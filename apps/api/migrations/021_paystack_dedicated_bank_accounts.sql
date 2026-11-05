BEGIN;

-- Provider-issued Paystack dedicated bank accounts are distinct from
-- FlowPay's internal 10-digit wallet-routing numbers and from card PANs.
CREATE TABLE IF NOT EXISTS public.fp_paystack_dedicated_accounts (
  user_id UUID PRIMARY KEY REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  paystack_customer_code TEXT UNIQUE,
  dedicated_account_id TEXT UNIQUE,
  account_number CHAR(10) UNIQUE
    CHECK (account_number IS NULL OR account_number ~ '^[0-9]{10}$'),
  bank_name TEXT,
  account_name TEXT,
  currency CHAR(3) NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status TEXT NOT NULL DEFAULT 'not_requested'
    CHECK (status IN ('not_requested','pending','assigned','failed')),
  consent_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    status <> 'assigned' OR
    (account_number IS NOT NULL AND bank_name IS NOT NULL AND account_name IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS fp_paystack_dedicated_accounts_status_idx
  ON public.fp_paystack_dedicated_accounts(status, updated_at DESC);

INSERT INTO public.schema_migrations(version)
VALUES ('021_paystack_dedicated_bank_accounts')
ON CONFLICT (version) DO NOTHING;

COMMIT;
