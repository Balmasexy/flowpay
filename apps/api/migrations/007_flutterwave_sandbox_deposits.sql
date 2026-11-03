BEGIN;
CREATE TABLE IF NOT EXISTS public.fp_flutterwave_deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL REFERENCES public.fp_accounts(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_reference TEXT NOT NULL UNIQUE,
  provider_transaction_id TEXT UNIQUE,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'failed')),
  checkout_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  posted_at TIMESTAMPTZ
);
ALTER TABLE public.fp_flutterwave_deposits
  ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS provider_reference TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'fp_flutterwave_deposits'
      AND column_name = 'transaction_id'
  ) THEN
    UPDATE public.fp_flutterwave_deposits
       SET id = COALESCE(id, gen_random_uuid()),
           idempotency_key = COALESCE(idempotency_key, 'legacy:' || COALESCE(transaction_id::text, gen_random_uuid()::text)),
           provider_reference = COALESCE(provider_reference, provider_tx_ref)
     WHERE id IS NULL OR idempotency_key IS NULL OR provider_reference IS NULL;
  END IF;
END $$;
ALTER TABLE public.fp_flutterwave_deposits
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN provider_reference SET NOT NULL,
  ALTER COLUMN checkout_url DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fp_flutterwave_deposits_id_uidx ON public.fp_flutterwave_deposits(id);
CREATE UNIQUE INDEX IF NOT EXISTS fp_flutterwave_deposits_idempotency_key_uidx ON public.fp_flutterwave_deposits(idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS fp_flutterwave_deposits_provider_reference_uidx ON public.fp_flutterwave_deposits(provider_reference);
CREATE TABLE IF NOT EXISTS public.fp_provider_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  currency CHAR(3) NOT NULL CHECK (currency = 'NGN'),
  account_id UUID NOT NULL UNIQUE REFERENCES public.fp_accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, currency)
);
CREATE INDEX IF NOT EXISTS fp_flutterwave_deposits_user_created_idx ON public.fp_flutterwave_deposits(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fp_flutterwave_deposits_pending_idx ON public.fp_flutterwave_deposits(created_at) WHERE status = 'pending';
INSERT INTO public.schema_migrations(version) VALUES ('007_flutterwave_sandbox_deposits') ON CONFLICT (version) DO NOTHING;
COMMIT;
