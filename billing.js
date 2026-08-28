const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DATABASE_POOL_MAX || 10),
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
}) : null;

const CREDIT_VALUE_USD = Number(process.env.CREDIT_VALUE_USD || 0.03333);
const BILLING_MULTIPLIER = Number(process.env.BILLING_MULTIPLIER || 1.8);

async function initializeSchema() {
  if (!pool || process.env.AUTO_MIGRATE === 'false') return;
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', '001_billing.sql'), 'utf8');
  await pool.query(sql);
}

async function ensureBillingUser(user) {
  if (!pool) throw new Error('DATABASE_URL is required for billing');
  await pool.query('BEGIN');
  try {
    await pool.query('INSERT INTO billing_users (id,email) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email', [user.id, user.email]);
    await pool.query('INSERT INTO credit_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [user.id]);
    await pool.query('COMMIT');
  } catch (error) { await pool.query('ROLLBACK'); throw error; }
}

function creditsForCost(costUsd) {
  const cost = Number(costUsd);
  if (!Number.isFinite(cost) || cost < 0) throw new Error('Invalid provider cost');
  return cost === 0 ? 0 : Math.ceil((cost * BILLING_MULTIPLIER) / CREDIT_VALUE_USD * 100000000) / 100000000;
}

async function charge(userId, costUsd, sourceId, metadata = {}) {
  if (!pool) throw new Error('DATABASE_URL is required for billing');
  const amount = creditsForCost(costUsd);
  const idempotencyKey = `usage:${sourceId}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wallet = await client.query('SELECT available FROM credit_wallets WHERE user_id=$1 FOR UPDATE', [userId]);
    if (!wallet.rowCount) throw new Error('Billing wallet not found');
    if (Number(wallet.rows[0].available) < amount) {
      await client.query('ROLLBACK');
      return { charged: false, amount, reason: 'insufficient_credits' };
    }
    const inserted = await client.query(
      `INSERT INTO credit_ledger (id,user_id,amount,entry_type,source_id,idempotency_key,metadata)
       VALUES ($1,$2,$3,'PROVIDER_USAGE',$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [crypto.randomUUID(), userId, -amount, sourceId, idempotencyKey, JSON.stringify({ ...metadata, costUsd, multiplier: BILLING_MULTIPLIER })]
    );
    if (inserted.rowCount) await client.query('UPDATE credit_wallets SET available=available-$1, updated_at=now() WHERE user_id=$2', [amount, userId]);
    await client.query('COMMIT');
    return { charged: true, amount, duplicate: !inserted.rowCount };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function reserve(userId, credits, sourceId, metadata = {}) {
  if (!pool) throw new Error('DATABASE_URL is required for billing');
  const amount = Math.max(0, Number(credits));
  if (!Number.isFinite(amount)) throw new Error('Invalid reservation amount');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wallet = await client.query('SELECT available FROM credit_wallets WHERE user_id=$1 FOR UPDATE', [userId]);
    if (!wallet.rowCount || Number(wallet.rows[0].available) < amount) { await client.query('ROLLBACK'); return { reserved: false, amount }; }
    const reservationId = `reservation:${sourceId}`;
    const inserted = await client.query(
      `INSERT INTO credit_ledger (id,user_id,amount,entry_type,source_id,idempotency_key,metadata)
       VALUES ($1,$2,$3,'RESERVATION', $4, $5, $6) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [crypto.randomUUID(), userId, -amount, sourceId, reservationId, JSON.stringify(metadata)]
    );
    if (inserted.rowCount) await client.query('UPDATE credit_wallets SET available=available-$1, held=held+$1, updated_at=now() WHERE user_id=$2', [amount, userId]);
    await client.query('COMMIT');
    return { reserved: true, amount, duplicate: !inserted.rowCount, reservationId };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function settle(userId, reservationId, actualCostUsd, metadata = {}) {
  if (!pool) throw new Error('DATABASE_URL is required for billing');
  const actual = creditsForCost(actualCostUsd);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reservation = await client.query('SELECT amount FROM credit_ledger WHERE idempotency_key=$1 AND user_id=$2 FOR UPDATE', [`reservation:${reservationId}`, userId]);
    if (!reservation.rowCount) throw new Error('Reservation not found');
    const prior = await client.query('SELECT amount FROM credit_ledger WHERE idempotency_key=$1 AND user_id=$2', [`settlement:${reservationId}`, userId]);
    if (prior.rowCount) { await client.query('COMMIT'); return { settled: true, amount: Math.abs(Number(prior.rows[0].amount)), duplicate: true }; }
    const held = Math.abs(Number(reservation.rows[0].amount));
    if (actual > held) {
      const wallet = await client.query('SELECT available FROM credit_wallets WHERE user_id=$1 FOR UPDATE', [userId]);
      const extra = actual - held;
      if (!wallet.rowCount || Number(wallet.rows[0].available) < extra) { await client.query('ROLLBACK'); return { settled: false, reason: 'insufficient_credits', amount: actual }; }
      await client.query('UPDATE credit_wallets SET available=available-$1, held=held-$2, updated_at=now() WHERE user_id=$3', [extra, held, userId]);
    } else {
      await client.query('UPDATE credit_wallets SET held=held-$1, available=available+$2, updated_at=now() WHERE user_id=$3', [held, held - actual, userId]);
    }
    await client.query('INSERT INTO credit_ledger (id,user_id,amount,entry_type,source_id,idempotency_key,metadata) VALUES ($1,$2,$3,\'SETTLEMENT\',$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING', [crypto.randomUUID(), userId, -actual, reservationId, `settlement:${reservationId}`, JSON.stringify({ ...metadata, actualCostUsd })]);
    await client.query('COMMIT');
    return { settled: true, amount: actual };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function release(userId, reservationId) {
  return settle(userId, reservationId, 0, { released: true });
}

async function balance(userId) {
  if (!pool) throw new Error('DATABASE_URL is required for billing');
  const result = await pool.query('SELECT available,held FROM credit_wallets WHERE user_id=$1', [userId]);
  return result.rows[0] || { available: 0, held: 0 };
}

async function grant(userId, credits, sourceId, metadata = {}) {
  if (!pool) throw new Error('DATABASE_URL is required for billing');
  const amount = Number(credits);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid grant amount');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO credit_ledger (id,user_id,amount,entry_type,source_id,idempotency_key,metadata)
       VALUES ($1,$2,$3,'PURCHASE',$4,$5,$6)
       ON CONFLICT (idempotency_key) DO UPDATE SET metadata=credit_ledger.metadata || EXCLUDED.metadata
       RETURNING id, (xmax = 0) AS inserted`,
      [crypto.randomUUID(), userId, amount, sourceId, `grant:${sourceId}`, JSON.stringify(metadata)]
    );
    if (inserted.rows[0]?.inserted) await client.query('UPDATE credit_wallets SET available=available+$1, updated_at=now() WHERE user_id=$2', [amount, userId]);
    await client.query('COMMIT');
    return { granted: true, amount, duplicate: !inserted.rows[0]?.inserted };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

module.exports = { pool, initializeSchema, ensureBillingUser, creditsForCost, charge, reserve, settle, release, balance, grant, CREDIT_VALUE_USD, BILLING_MULTIPLIER };
