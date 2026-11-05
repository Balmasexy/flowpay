BEGIN;

-- Provider-confirmed Nigerian dedicated virtual bank accounts are separate
-- from FlowPay's internal wallet-transfer numbers and from issued payment cards.
CREATE TABLE IF NOT EXISTS public.fp_paystack_dedicated_accounts (
  user_id UUID PRIMARY KEY REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL DEFAULT 'paystack' CHECK (provider = 'paystack'),
  provider_domain TEXT NOT NULL CHECK (provider_domain IN ('test', 'live')),
  provider_customer_code TEXT NOT NULL UNIQUE,
  provider_account_id TEXT UNIQUE,
  account_number TEXT UNIQUE CHECK (account_number IS NULL OR account_number ~ '^[0-9]{10}$'),
  bank_name TEXT,
  account_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'assigned', 'failed', 'disabled')),
  consent_at TIMESTAMPTZ NOT NULL,
  assigned_at TIMESTAMPTZ,
  last_provider_event TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'assigned' AND account_number IS NOT NULL AND bank_name IS NOT NULL AND account_name IS NOT NULL)
    OR status <> 'assigned'
  )
);

CREATE INDEX IF NOT EXISTS fp_paystack_dedicated_accounts_status_idx
  ON public.fp_paystack_dedicated_accounts(status, updated_at DESC);

INSERT INTO public.schema_migrations(version)
VALUES ('021_paystack_dedicated_virtual_accounts')
ON CONFLICT (version) DO NOTHING;

COMMIT;
