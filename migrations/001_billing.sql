CREATE TABLE IF NOT EXISTS billing_users (
  id TEXT PRIMARY KEY,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_wallets (
  user_id TEXT PRIMARY KEY REFERENCES billing_users(id) ON DELETE CASCADE,
  available NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (available >= 0),
  held NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (held >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES billing_users(id) ON DELETE CASCADE,
  amount NUMERIC(20,8) NOT NULL,
  entry_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credit_ledger_user_created_idx ON credit_ledger(user_id, created_at DESC);
