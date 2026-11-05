BEGIN;

-- Public FlowPay wallet account numbers are separate from ledger UUIDs and
-- from provider-issued virtual bank account numbers. A sequence guarantees
-- unique 12-digit numbers without relying on random collision retries.
CREATE SEQUENCE IF NOT EXISTS public.fp_customer_account_number_seq
  AS BIGINT
  START WITH 100000000000
  INCREMENT BY 1
  MINVALUE 100000000000
  MAXVALUE 999999999999;

CREATE TABLE IF NOT EXISTS public.fp_customer_account_numbers (
  user_id UUID PRIMARY KEY REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  account_number TEXT NOT NULL UNIQUE CHECK (account_number ~ '^[0-9]{12}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Existing customer accounts receive unique numbers. Non-customer users are
-- intentionally excluded. New customers receive a number on first account-
-- details request, using the same sequence.
INSERT INTO public.fp_customer_account_numbers (user_id, account_number)
SELECT id, nextval('public.fp_customer_account_number_seq')::TEXT
  FROM public.fp_users
 WHERE role = 'customer'
ON CONFLICT DO NOTHING;

-- Transaction PINs are salted scrypt hashes; no plaintext PIN is persisted.
CREATE TABLE IF NOT EXISTS public.fp_transaction_pins (
  user_id UUID PRIMARY KEY REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  pin_salt BYTEA NOT NULL CHECK (octet_length(pin_salt) = 16),
  pin_hash BYTEA NOT NULL CHECK (octet_length(pin_hash) = 64),
  failed_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit and history metadata for wallet-to-wallet transfers. The balanced
-- debit/credit itself remains in the immutable ledger entries.
CREATE TABLE IF NOT EXISTS public.fp_internal_transfer_details (
  transaction_id UUID PRIMARY KEY REFERENCES public.fp_ledger_transactions(id) ON DELETE RESTRICT,
  sender_user_id UUID NOT NULL REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  recipient_user_id UUID NOT NULL REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  recipient_account_number TEXT NOT NULL CHECK (recipient_account_number ~ '^[0-9]{12}$'),
  reference TEXT NOT NULL UNIQUE,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (sender_user_id <> recipient_user_id)
);

CREATE INDEX IF NOT EXISTS fp_internal_transfer_sender_created_idx
  ON public.fp_internal_transfer_details(sender_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fp_internal_transfer_recipient_created_idx
  ON public.fp_internal_transfer_details(recipient_user_id, created_at DESC);

INSERT INTO public.schema_migrations(version)
VALUES ('017_flowpay_internal_transfers')
ON CONFLICT (version) DO NOTHING;

COMMIT;
