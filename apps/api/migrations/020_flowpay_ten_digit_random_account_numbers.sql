BEGIN;

-- FlowPay transfer numbers are internal identifiers, not bank NUBANs.
-- Replace legacy 12-digit sequence values with unique, non-sequential
-- 10-digit values while retaining historical transfer detail rows.
LOCK TABLE public.fp_customer_account_numbers IN ACCESS EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.fp_generate_flowpay_account_number()
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  candidate TEXT;
  attempts INTEGER := 0;
BEGIN
  LOOP
    candidate := (1000000000 + FLOOR(RANDOM() * 9000000000)::BIGINT)::TEXT;
    attempts := attempts + 1;
    IF NOT EXISTS (
      SELECT 1 FROM public.fp_customer_account_numbers
       WHERE account_number = candidate
    ) THEN
      RETURN candidate;
    END IF;
    IF attempts > 10000 THEN
      RAISE EXCEPTION 'Could not allocate a unique FlowPay account number';
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE public.fp_customer_account_numbers
  DROP CONSTRAINT IF EXISTS fp_customer_account_numbers_account_number_check;

UPDATE public.fp_customer_account_numbers
   SET account_number = public.fp_generate_flowpay_account_number();

ALTER TABLE public.fp_customer_account_numbers
  ADD CONSTRAINT fp_customer_account_numbers_account_number_check
  CHECK (account_number ~ '^[1-9][0-9]{9}$');

-- Keep pre-migration transfer history readable while new sends use 10 digits.
ALTER TABLE public.fp_internal_transfer_details
  DROP CONSTRAINT IF EXISTS fp_internal_transfer_details_recipient_account_number_check;

ALTER TABLE public.fp_internal_transfer_details
  ADD CONSTRAINT fp_internal_transfer_details_recipient_account_number_check
  CHECK (recipient_account_number ~ '^([1-9][0-9]{9}|[0-9]{12})$');

DROP FUNCTION public.fp_generate_flowpay_account_number();

INSERT INTO public.schema_migrations(version)
VALUES ('020_flowpay_ten_digit_random_account_numbers')
ON CONFLICT (version) DO NOTHING;

COMMIT;
