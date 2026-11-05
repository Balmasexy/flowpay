BEGIN;

-- Independent Paystack sandbox deposit records. No customer balances or
-- existing Flutterwave rows are modified by this migration.
CREATE TABLE IF NOT EXISTS public.fp_paystack_deposits (
  transaction_id UUID PRIMARY KEY REFERENCES public.fp_ledger_transactions(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL REFERENCES public.fp_accounts(id) ON DELETE RESTRICT,
  reference TEXT NOT NULL UNIQUE,
  provider_transaction_id TEXT UNIQUE,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','posted','failed')),
  checkout_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS fp_paystack_deposits_user_created_idx
  ON public.fp_paystack_deposits(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fp_paystack_deposits_pending_idx
  ON public.fp_paystack_deposits(created_at) WHERE status='pending';

ALTER TABLE public.fp_payment_events
  ADD COLUMN IF NOT EXISTS transaction_id UUID REFERENCES public.fp_ledger_transactions(id),
  ADD COLUMN IF NOT EXISTS payload_sha256 CHAR(64);

INSERT INTO public.schema_migrations(version)
VALUES ('015_paystack_sandbox_deposits')
ON CONFLICT(version) DO NOTHING;

COMMIT;
