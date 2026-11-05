BEGIN;

-- Add an isolated Paystack bank-transfer record set. The migration does not
-- update existing customer wallets, deposits, balances, or ledger entries.
-- Apply only after 016_paystack_sandbox_ledger_posting is present.
CREATE TABLE IF NOT EXISTS public.fp_paystack_bank_transfers (
  transaction_id UUID PRIMARY KEY
    REFERENCES public.fp_ledger_transactions(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL REFERENCES public.fp_accounts(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  reference TEXT NOT NULL UNIQUE,
  recipient_code TEXT NOT NULL,
  transfer_code TEXT,
  provider_transfer_id TEXT UNIQUE,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  bank_code TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_number_last4 CHAR(4) NOT NULL CHECK (account_number_last4 ~ '^[0-9]{4}$'),
  status TEXT NOT NULL DEFAULT 'initiating'
    CHECK (status IN (
      'initiating', 'pending', 'otp', 'unknown', 'success',
      'failed', 'reversed', 'blocked', 'abandoned', 'rejected'
    )),
  provider_status TEXT,
  status_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS fp_paystack_bank_transfers_user_created_idx
  ON public.fp_paystack_bank_transfers(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS fp_paystack_bank_transfers_reservation_idx
  ON public.fp_paystack_bank_transfers(account_id, created_at)
  WHERE status IN ('initiating', 'pending', 'otp', 'unknown');

CREATE INDEX IF NOT EXISTS fp_paystack_bank_transfers_provider_status_idx
  ON public.fp_paystack_bank_transfers(status, updated_at DESC);

INSERT INTO public.schema_migrations(version)
VALUES ('019_paystack_bank_transfers')
ON CONFLICT (version) DO NOTHING;

COMMIT;
