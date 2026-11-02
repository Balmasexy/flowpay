BEGIN;

-- Sandbox balances are intentionally isolated from fp_accounts and the production ledger.
CREATE TABLE IF NOT EXISTS fp_sandbox_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES fp_users(id) ON DELETE RESTRICT,
  account_type TEXT NOT NULL CHECK (account_type IN ('customer', 'clearing')),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((account_type = 'customer' AND user_id IS NOT NULL) OR
         (account_type = 'clearing' AND user_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS fp_sandbox_customer_account_unique
  ON fp_sandbox_accounts(user_id, currency) WHERE account_type = 'customer';
CREATE UNIQUE INDEX IF NOT EXISTS fp_sandbox_clearing_account_unique
  ON fp_sandbox_accounts(currency) WHERE account_type = 'clearing';

CREATE TABLE IF NOT EXISTS fp_sandbox_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES fp_users(id) ON DELETE RESTRICT,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('deposit', 'withdrawal', 'payment', 'transfer')),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  description TEXT NOT NULL,
  counterparty_account_id UUID REFERENCES fp_sandbox_accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS fp_sandbox_transactions_user_created_idx
  ON fp_sandbox_transactions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fp_sandbox_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES fp_sandbox_transactions(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL REFERENCES fp_sandbox_accounts(id) ON DELETE RESTRICT,
  amount_minor BIGINT NOT NULL CHECK (amount_minor <> 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS fp_sandbox_entries_account_idx
  ON fp_sandbox_entries(account_id, created_at);

INSERT INTO schema_migrations(version)
VALUES ('008_sandbox_mode')
ON CONFLICT (version) DO NOTHING;

COMMIT;
