-- UNVAIL PRODUCTION SCHEMA — PostgreSQL is source of truth
-- Enable pgcrypto for gen_random_uuid
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users: mapping of auth provider subject to internal user
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_provider TEXT NOT NULL,
  auth_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  email_verified BOOLEAN DEFAULT false,
  display_name TEXT,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  UNIQUE (auth_provider, auth_subject)
);
CREATE INDEX idx_users_email ON users(email);

-- Wallets: one per user, integer units, optimistic versioning
CREATE TABLE credit_wallets (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available_units INTEGER NOT NULL DEFAULT 0 CHECK (available_units >=0),
  held_units INTEGER NOT NULL DEFAULT 0 CHECK (held_units >=0),
  lifetime_purchased_units INTEGER NOT NULL DEFAULT 0,
  lifetime_promotional_units INTEGER NOT NULL DEFAULT 0,
  lifetime_spent_units INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ledger: append-only, never edit/delete
CREATE TABLE credit_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_units INTEGER NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('PURCHASE','FREE_GRANT','PROMOTIONAL_GRANT','RESERVATION_CREATED','RESERVATION_RELEASED','GENERATION_CHARGE','REFUND_REVERSAL','CHARGEBACK_REVERSAL','ADMIN_GRANT','ADMIN_DEDUCTION','CORRECTION')),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ledger_user ON credit_ledger(user_id, created_at);

-- Reservations: atomic holds
CREATE TABLE credit_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation_run_id UUID,
  reserved_units INTEGER NOT NULL CHECK (reserved_units>0),
  finalized_units INTEGER NOT NULL DEFAULT 0,
  released_units INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','FINALIZED','RELEASED','PARTIALLY_RELEASED','FAILED')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ
);

-- Packages
CREATE TABLE credit_packages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stripe_product_id TEXT,
  stripe_price_id TEXT NOT NULL,
  credit_units INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  active BOOLEAN DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Payment orders
CREATE TABLE payment_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credit_package_id TEXT NOT NULL REFERENCES credit_packages(id),
  package_version INTEGER NOT NULL,
  expected_credit_units INTEGER NOT NULL,
  expected_price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','CHECKOUT_CREATED','PAID','FULFILLED','PAYMENT_FAILED','EXPIRED','REFUNDED','PARTIALLY_REFUNDED','DISPUTED','CANCELLED')),
  fulfilled_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  disputed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payment_session ON payment_orders(stripe_checkout_session_id);

-- Webhook events: idempotency
CREATE TABLE stripe_webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  livemode BOOLEAN NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'pending',
  processed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Generation quotes: short-lived, one-time
CREATE TABLE generation_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation_type TEXT NOT NULL CHECK (generation_type IN ('image','video')),
  model_id TEXT NOT NULL,
  settings_json JSONB NOT NULL,
  provider_cost_estimate INTEGER,
  credits_reserved INTEGER NOT NULL,
  pricing_version INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_quotes_user ON generation_quotes(user_id, expires_at);

-- Generation runs: persisted state
CREATE TABLE generation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quote_id UUID REFERENCES generation_quotes(id),
  reservation_id UUID REFERENCES credit_reservations(id),
  generation_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_version TEXT,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','PROCESSING','WAITING_FOR_PROVIDER','DOWNLOADING_RESULT','STORING_RESULT','COMPLETED','FAILED','PARTIAL','CANCEL_REQUESTED','CANCELLED')),
  stage TEXT,
  prompt TEXT,
  settings_json JSONB,
  estimated_cost_micro_usd INTEGER,
  actual_cost_micro_usd INTEGER,
  reserved_credit_units INTEGER,
  charged_credit_units INTEGER,
  error_code TEXT,
  sanitized_error_message TEXT,
  cancel_requested_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_runs_user ON generation_runs(user_id, created_at);
CREATE INDEX idx_runs_status ON generation_runs(status);

-- Provider calls
CREATE TABLE provider_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_run_id UUID NOT NULL REFERENCES generation_runs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_version TEXT,
  provider_request_id TEXT,
  stage TEXT,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_started_at TIMESTAMPTZ,
  request_completed_at TIMESTAMPTZ,
  estimated_cost_micro_usd INTEGER,
  actual_cost_micro_usd INTEGER,
  usage_json JSONB,
  sanitized_error_json JSONB
);

-- Assets: private bucket keys
CREATE TABLE assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation_run_id UUID REFERENCES generation_runs(id),
  object_key TEXT NOT NULL UNIQUE,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('image','video','audio','thumbnail')),
  mime_type TEXT NOT NULL,
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  checksum TEXT,
  status TEXT NOT NULL DEFAULT 'stored',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_assets_user ON assets(user_id);

-- Free claims
CREATE TABLE free_credit_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_hmac TEXT NOT NULL,
  device_hash TEXT,
  granted_units INTEGER NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, user_id),
  UNIQUE (campaign_id, ip_hmac)
);

-- Admin audit
CREATE TABLE admin_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  target_user_id UUID,
  target_resource_id TEXT,
  reason TEXT NOT NULL,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pricing snapshot
CREATE TABLE provider_pricing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  pricing_unit TEXT NOT NULL,
  input_cost_micro_usd INTEGER,
  output_cost_micro_usd INTEGER,
  per_image_cost_micro_usd INTEGER,
  per_second_cost_micro_usd INTEGER,
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, model_id, model_version)
);

-- Seed packages (test mode)
INSERT INTO credit_packages (id, name, stripe_price_id, credit_units, price_cents) VALUES
('credits_50_v1','Starter', 'price_test_50', 50, 499),
('credits_200_v1','Creator', 'price_test_200', 200, 1499),
('credits_500_v1','Pro', 'price_test_500', 500, 2999)
ON CONFLICT (id) DO NOTHING;
