BEGIN;

-- Public FlowPay wallet account numbers are separate from wallet ledger UUIDs
-- and from provider-issued virtual bank account numbers.
CREATE TABLE IF NOT EXISTS public.fp_customer_account_numbers (
  user_id UUID PRIMARY KEY REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  account_number TEXT NOT NULL UNIQUE CHECK (account_number ~ '^[0-9]{12}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.fp_assign_customer_account_number()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  candidate TEXT;
BEGIN
  IF NEW.role <> 'customer' THEN
    RETURN NEW;
  END IF;
  LOOP
    candidate := (100000000000::BIGINT + floor(random() * 900000000000)::BIGINT)::TEXT;
    BEGIN
      INSERT INTO public.fp_customer_account_numbers (user_id, account_number)
      VALUES (NEW.id, candidate);
      RETURN NEW;
    EXCEPTION WHEN unique_violation THEN
      IF EXISTS (
        SELECT 1 FROM public.fp_customer_account_numbers WHERE user_id = NEW.id
      ) THEN
        RETURN NEW;
      END IF;
    END;
  END LOOP;
END;
$$;

DROP TRIGGER IF EXISTS fp_users_assign_account_number ON public.fp_users;
CREATE TRIGGER fp_users_assign_account_number
AFTER INSERT ON public.fp_users
FOR EACH ROW
EXECUTE FUNCTION public.fp_assign_customer_account_number();

-- Backfill existing FlowPay customers without altering customer or ledger data.
DO $$
DECLARE
  customer RECORD;
  candidate TEXT;
  assigned BOOLEAN;
BEGIN
  FOR customer IN SELECT id FROM public.fp_users WHERE role = 'customer' ORDER BY id LOOP
    IF EXISTS (SELECT 1 FROM public.fp_customer_account_numbers WHERE user_id = customer.id) THEN
      CONTINUE;
    END IF;
    assigned := FALSE;
    WHILE NOT assigned LOOP
      candidate := (100000000000::BIGINT + floor(random() * 900000000000)::BIGINT)::TEXT;
      BEGIN
        INSERT INTO public.fp_customer_account_numbers (user_id, account_number)
        VALUES (customer.id, candidate);
        assigned := TRUE;
      EXCEPTION WHEN unique_violation THEN
        assigned := EXISTS (
          SELECT 1 FROM public.fp_customer_account_numbers WHERE user_id = customer.id
        );
      END;
    END LOOP;
  END LOOP;
END;
$$;

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
