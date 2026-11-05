BEGIN;

-- FlowPay numbers are internal wallet-routing identifiers, not bank NUBANs.
-- Rotate legacy sequential 12-digit identifiers to random 10-digit values.
-- Historical transfer details continue to accept either length.
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

-- Process rows one at a time: each newly allocated value is visible to the
-- uniqueness check before another row is updated.
DO $$
DECLARE
  target_user RECORD;
BEGIN
  FOR target_user IN
    SELECT id FROM public.fp_users
     WHERE status = 'active' AND role IN ('customer','admin','super_admin')
     ORDER BY id
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.fp_customer_account_numbers
       WHERE user_id = target_user.id
    ) THEN
      UPDATE public.fp_customer_account_numbers
         SET account_number = public.fp_generate_flowpay_account_number()
       WHERE user_id = target_user.id;
    ELSE
      INSERT INTO public.fp_customer_account_numbers(user_id, account_number)
      VALUES (target_user.id, public.fp_generate_flowpay_account_number())
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END
$$;

ALTER TABLE public.fp_customer_account_numbers
  ADD CONSTRAINT fp_customer_account_numbers_account_number_check
  CHECK (account_number ~ '^[1-9][0-9]{9}$');

-- Keep old completed transfer receipts/history valid; new recipient lookups
-- and transfer requests accept only 10-digit identifiers.
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
