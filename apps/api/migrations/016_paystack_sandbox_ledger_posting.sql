BEGIN;

-- Paystack sandbox deposits use their own clearing account. The account has a
-- zero opening balance and is not evidence of customer funds at a bank.
ALTER TABLE public.fp_accounts
  ADD COLUMN IF NOT EXISTS system_account_role TEXT;

ALTER TABLE public.fp_accounts
  DROP CONSTRAINT IF EXISTS fp_accounts_system_role_check;

ALTER TABLE public.fp_accounts
  ADD CONSTRAINT fp_accounts_system_role_check
  CHECK (
    system_account_role IS NULL OR
    (account_type = 'system' AND system_account_role IN (
      'flutterwave_ngn_clearing',
      'paystack_ngn_clearing'
    ))
  );

CREATE UNIQUE INDEX IF NOT EXISTS fp_accounts_system_role_currency_unique
  ON public.fp_accounts(system_account_role, currency)
  WHERE system_account_role IS NOT NULL;

INSERT INTO public.fp_accounts (user_id, account_type, currency, status, system_account_role)
VALUES (NULL, 'system', 'NGN', 'active', 'paystack_ngn_clearing')
ON CONFLICT (system_account_role, currency)
  WHERE system_account_role IS NOT NULL
DO NOTHING;

-- Repeat the additive columns here because the historical Flutterwave 013
-- migration is not recorded on every existing FlowPay database.
ALTER TABLE public.fp_payment_events
  ADD COLUMN IF NOT EXISTS transaction_id UUID REFERENCES public.fp_ledger_transactions(id),
  ADD COLUMN IF NOT EXISTS payload_sha256 CHAR(64);

CREATE INDEX IF NOT EXISTS fp_payment_events_transaction_idx
  ON public.fp_payment_events(transaction_id, received_at DESC)
  WHERE transaction_id IS NOT NULL;

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

INSERT INTO public.schema_migrations(version)
VALUES ('015_paystack_sandbox_deposits')
ON CONFLICT(version) DO NOTHING;

INSERT INTO public.schema_migrations(version)
VALUES ('016_paystack_sandbox_ledger_posting')
ON CONFLICT(version) DO NOTHING;

COMMIT;
