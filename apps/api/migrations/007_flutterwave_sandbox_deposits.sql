BEGIN;

-- Additive Flutterwave sandbox deposit tracking. Existing customer and ledger rows are untouched.
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

CREATE INDEX IF NOT EXISTS fp_flutterwave_deposits_user_created_idx
  ON public.fp_flutterwave_deposits(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS fp_flutterwave_deposits_pending_idx
  ON public.fp_flutterwave_deposits(created_at)
  WHERE status = 'pending';

INSERT INTO public.schema_migrations(version)
VALUES ('007_flutterwave_sandbox_deposits')
ON CONFLICT (version) DO NOTHING;

COMMIT;
