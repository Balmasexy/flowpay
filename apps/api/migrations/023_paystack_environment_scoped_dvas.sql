BEGIN;

-- Normalize either historical 021 schema without dropping the original rows.
ALTER TABLE public.fp_paystack_dedicated_accounts
  ADD COLUMN IF NOT EXISTS provider_domain TEXT NOT NULL DEFAULT 'test',
  ADD COLUMN IF NOT EXISTS paystack_customer_code TEXT,
  ADD COLUMN IF NOT EXISTS dedicated_account_id TEXT,
  ADD COLUMN IF NOT EXISTS account_number TEXT,
  ADD COLUMN IF NOT EXISTS bank_name TEXT,
  ADD COLUMN IF NOT EXISTS account_name TEXT,
  ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error_code TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'fp_paystack_dedicated_accounts'
       AND column_name = 'provider_customer_code'
  ) THEN
    EXECUTE 'UPDATE public.fp_paystack_dedicated_accounts
                SET paystack_customer_code = COALESCE(paystack_customer_code, provider_customer_code)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'fp_paystack_dedicated_accounts'
       AND column_name = 'provider_account_id'
  ) THEN
    EXECUTE 'UPDATE public.fp_paystack_dedicated_accounts
                SET dedicated_account_id = COALESCE(dedicated_account_id, provider_account_id)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.fp_paystack_dedicated_accounts_v2 (
  user_id UUID NOT NULL REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  provider_domain TEXT NOT NULL CHECK (provider_domain IN ('test','live')),
  paystack_customer_code TEXT,
  dedicated_account_id TEXT,
  account_number TEXT CHECK (account_number IS NULL OR account_number ~ '^[0-9]{10}$'),
  bank_name TEXT,
  account_name TEXT,
  currency CHAR(3) NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status TEXT NOT NULL DEFAULT 'not_requested'
    CHECK (status IN ('not_requested','pending','assigned','failed')),
  consent_at TIMESTAMPTZ,
  last_error_code TEXT,
  assigned_at TIMESTAMPTZ,
  last_provider_event TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, provider_domain),
  CHECK (
    status <> 'assigned' OR
    (account_number IS NOT NULL AND bank_name IS NOT NULL AND account_name IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS fp_paystack_dva_v2_customer_unique
  ON public.fp_paystack_dedicated_accounts_v2(provider_domain,paystack_customer_code)
  WHERE paystack_customer_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fp_paystack_dva_v2_account_id_unique
  ON public.fp_paystack_dedicated_accounts_v2(provider_domain,dedicated_account_id)
  WHERE dedicated_account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fp_paystack_dva_v2_account_number_unique
  ON public.fp_paystack_dedicated_accounts_v2(provider_domain,account_number)
  WHERE account_number IS NOT NULL;

INSERT INTO public.fp_paystack_dedicated_accounts_v2
  (user_id,provider_domain,paystack_customer_code,dedicated_account_id,account_number,
   bank_name,account_name,currency,status,consent_at,last_error_code,created_at,updated_at)
SELECT user_id,provider_domain,paystack_customer_code,dedicated_account_id,account_number,
       bank_name,account_name,'NGN',
       CASE WHEN status IN ('pending','assigned','failed') THEN status ELSE 'not_requested' END,
       consent_at,last_error_code,created_at,updated_at
  FROM public.fp_paystack_dedicated_accounts
ON CONFLICT (user_id,provider_domain) DO NOTHING;

INSERT INTO public.schema_migrations(version)
VALUES ('023_paystack_environment_scoped_dvas')
ON CONFLICT (version) DO NOTHING;

COMMIT;
