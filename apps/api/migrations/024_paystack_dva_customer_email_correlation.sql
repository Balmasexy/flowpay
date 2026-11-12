BEGIN;

ALTER TABLE public.fp_paystack_dedicated_accounts_v2
  ADD COLUMN IF NOT EXISTS customer_email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS fp_paystack_dva_v2_email_unique
  ON public.fp_paystack_dedicated_accounts_v2(provider_domain, lower(customer_email))
  WHERE customer_email IS NOT NULL;

INSERT INTO public.schema_migrations(version)
VALUES ('024_paystack_dva_customer_email_correlation')
ON CONFLICT (version) DO NOTHING;

COMMIT;
