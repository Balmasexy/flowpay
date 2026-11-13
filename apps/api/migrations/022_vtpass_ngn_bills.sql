BEGIN;

-- Add a separate clearing account for provider-confirmed bill purchases.
ALTER TABLE public.fp_accounts
  DROP CONSTRAINT IF EXISTS fp_accounts_system_role_check;
ALTER TABLE public.fp_accounts
  ADD CONSTRAINT fp_accounts_system_role_check
  CHECK (
    system_account_role IS NULL OR
    (account_type = 'system' AND system_account_role IN (
      'flutterwave_ngn_clearing',
      'paystack_ngn_clearing',
      'manual_receipt_ngn_clearing',
      'vtpass_ngn_clearing'
    ))
  );

CREATE UNIQUE INDEX IF NOT EXISTS fp_accounts_system_role_currency_unique
  ON public.fp_accounts(system_account_role, currency)
  WHERE system_account_role IS NOT NULL;

INSERT INTO public.fp_accounts (user_id, account_type, currency, status, system_account_role)
VALUES (NULL, 'system', 'NGN', 'active', 'vtpass_ngn_clearing')
ON CONFLICT (system_account_role, currency)
  WHERE system_account_role IS NOT NULL
DO NOTHING;

-- Provider requests are recorded before contacting VTpass. Pending and unknown
-- requests reserve funds until authoritative requery resolves the result.
CREATE TABLE IF NOT EXISTS public.fp_vtpass_bill_payments (
  transaction_id UUID PRIMARY KEY REFERENCES public.fp_ledger_transactions(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL REFERENCES public.fp_accounts(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('airtime','data','electricity')),
  service_id TEXT NOT NULL,
  variation_code TEXT,
  customer_reference TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status TEXT NOT NULL DEFAULT 'initiating'
    CHECK (status IN ('initiating','pending','unknown','success','failed','reversed')),
  provider_transaction_id TEXT,
  provider_code TEXT,
  provider_status TEXT,
  status_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS fp_vtpass_bill_payments_user_created_idx
  ON public.fp_vtpass_bill_payments(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS fp_vtpass_bill_payments_reservations_idx
  ON public.fp_vtpass_bill_payments(account_id, created_at)
  WHERE status IN ('initiating','pending','unknown');

INSERT INTO public.schema_migrations(version)
VALUES ('022_vtpass_ngn_bills')
ON CONFLICT (version) DO NOTHING;

COMMIT;
