BEGIN;

-- A dedicated, zero-opening-balance contra/clearing account for FlowPay's
-- Flutterwave NGN test deposits. It is not a customer wallet and does not
-- represent funds held at Flutterwave or a bank.
ALTER TABLE fp_accounts
  ADD COLUMN IF NOT EXISTS system_account_role TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fp_accounts_system_role_check'
      AND conrelid = 'public.fp_accounts'::regclass
  ) THEN
    ALTER TABLE fp_accounts
      ADD CONSTRAINT fp_accounts_system_role_check
      CHECK (
        system_account_role IS NULL OR
        (account_type = 'system' AND system_account_role IN ('flutterwave_ngn_clearing'))
      );
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS fp_accounts_system_role_currency_unique
  ON fp_accounts(system_account_role, currency)
  WHERE system_account_role IS NOT NULL;

INSERT INTO fp_accounts (user_id, account_type, currency, status, system_account_role)
VALUES (NULL, 'system', 'NGN', 'active', 'flutterwave_ngn_clearing')
ON CONFLICT (system_account_role, currency)
  WHERE system_account_role IS NOT NULL
DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('008_flutterwave_ngn_clearing_account')
ON CONFLICT (version) DO NOTHING;

COMMIT;
