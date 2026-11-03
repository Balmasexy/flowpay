BEGIN;

CREATE TABLE IF NOT EXISTS fp_flutterwave_deposits (
  transaction_id UUID PRIMARY KEY REFERENCES fp_ledger_transactions(id),
  user_id UUID NOT NULL REFERENCES fp_users(id),
  account_id UUID NOT NULL REFERENCES fp_accounts(id),
  provider_tx_ref TEXT NOT NULL UNIQUE,
  provider_transaction_id TEXT UNIQUE,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL CHECK (currency = 'NGN'),
  checkout_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS fp_flutterwave_deposits_user_created_idx
  ON fp_flutterwave_deposits(user_id, created_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('007_flutterwave_test_deposits')
ON CONFLICT (version) DO NOTHING;

COMMIT;
