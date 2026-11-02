BEGIN;

-- Idempotency keys are scoped to the authenticated FlowPay customer.
-- This prevents unrelated customers from colliding while preserving replay
-- protection for each customer's own requests.
ALTER TABLE fp_sandbox_transactions
  DROP CONSTRAINT IF EXISTS fp_sandbox_transactions_idempotency_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS fp_sandbox_transactions_user_idempotency_unique
  ON fp_sandbox_transactions(user_id, idempotency_key);

INSERT INTO schema_migrations(version)
VALUES ('009_sandbox_idempotency_per_customer')
ON CONFLICT (version) DO NOTHING;

COMMIT;
