BEGIN;

CREATE TABLE IF NOT EXISTS fp_sandbox_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES fp_users(id) ON DELETE RESTRICT,
  batch_type TEXT NOT NULL CHECK (batch_type IN ('payment', 'verification')),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'completed', 'completed_with_errors')),
  row_count INTEGER NOT NULL CHECK (row_count BETWEEN 1 AND 5000),
  valid_count INTEGER NOT NULL DEFAULT 0 CHECK (valid_count BETWEEN 0 AND row_count),
  invalid_count INTEGER NOT NULL DEFAULT 0 CHECK (invalid_count BETWEEN 0 AND row_count),
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS fp_sandbox_batches_user_created_idx
  ON fp_sandbox_batches(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fp_sandbox_batch_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES fp_sandbox_batches(id) ON DELETE RESTRICT,
  row_number INTEGER NOT NULL CHECK (row_number BETWEEN 1 AND 5000),
  beneficiary_name TEXT NOT NULL,
  account_number_masked TEXT NOT NULL,
  bank_code TEXT NOT NULL,
  amount_minor BIGINT,
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL CHECK (status IN ('prepared', 'invalid', 'simulated_match', 'simulated_no_match')),
  result_code TEXT,
  result_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(batch_id, row_number)
);
CREATE INDEX IF NOT EXISTS fp_sandbox_batch_rows_batch_idx
  ON fp_sandbox_batch_rows(batch_id, row_number);

INSERT INTO schema_migrations(version)
VALUES ('010_sandbox_bulk_batches')
ON CONFLICT (version) DO NOTHING;
COMMIT;
