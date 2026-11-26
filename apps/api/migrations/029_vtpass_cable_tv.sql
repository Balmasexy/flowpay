BEGIN;

-- Extend the existing provider-backed VTpass billing ledger to cable television.
-- Existing transactions, reservations and balances are not rewritten.
ALTER TABLE public.fp_vtpass_bill_payments
  DROP CONSTRAINT IF EXISTS fp_vtpass_bill_payments_category_check;

ALTER TABLE public.fp_vtpass_bill_payments
  ADD CONSTRAINT fp_vtpass_bill_payments_category_check
  CHECK (category IN ('airtime','data','electricity','cabletv'));

INSERT INTO public.schema_migrations(version)
VALUES ('029_vtpass_cable_tv')
ON CONFLICT (version) DO NOTHING;

COMMIT;
