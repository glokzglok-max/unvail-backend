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

async function balance(userId) {
  if (!pool) throw new Error('DATABASE_URL is required for billing');
  const result = await pool.query('SELECT available,held FROM credit_wallets WHERE user_id=$1', [userId]);
  return result.rows[0] || { available: 0, held: 0 };
}

module.exports = { pool, initializeSchema, ensureBillingUser, creditsForCost, charge, balance, CREDIT_VALUE_USD, BILLING_MULTIPLIER };
