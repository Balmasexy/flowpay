BEGIN;

-- Independent customer-facing utility bill records. Existing deposit and
-- VTpass rows are not rewritten; active amounts remain reserved until the
-- Flutterwave bill status endpoint confirms success or failure.
CREATE TABLE IF NOT EXISTS public.fp_flutterwave_bill_payments (
  transaction_id UUID PRIMARY KEY REFERENCES public.fp_ledger_transactions(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL REFERENCES public.fp_accounts(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE,
  category_code TEXT NOT NULL CHECK (category_code = 'UTILITYBILLS'),
  biller_code TEXT NOT NULL,
  biller_name TEXT NOT NULL,
  item_code TEXT NOT NULL,
  item_name TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  provider_reference TEXT NOT NULL UNIQUE,
  flw_tx_ref TEXT UNIQUE,
  flw_reference TEXT,
  provider_token TEXT,
  status TEXT NOT NULL DEFAULT 'initiating'
    CHECK (status IN ('initiating','pending','unknown','success','failed')),
  provider_status TEXT,
  status_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS fp_flutterwave_bill_user_created_idx
  ON public.fp_flutterwave_bill_payments(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS fp_flutterwave_bill_reservations_idx
  ON public.fp_flutterwave_bill_payments(account_id, created_at)
  WHERE status IN ('initiating','pending','unknown');

INSERT INTO public.schema_migrations(version)
VALUES ('023_flutterwave_utility_bills')
ON CONFLICT (version) DO NOTHING;

COMMIT;
