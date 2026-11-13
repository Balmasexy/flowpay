BEGIN;

-- Persist the Paystack provider slug needed by the DVA requery endpoint and
-- coordinate the provider's one-request-per-account-per-ten-minute limit.
ALTER TABLE public.fp_paystack_dedicated_accounts_v2
  ADD COLUMN IF NOT EXISTS bank_slug TEXT,
  ADD COLUMN IF NOT EXISTS last_requery_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS fp_paystack_dva_v2_requery_idx
  ON public.fp_paystack_dedicated_accounts_v2(provider_domain, last_requery_at)
  WHERE status = 'assigned';

INSERT INTO public.schema_migrations(version)
VALUES ('025_paystack_dva_requery_controls')
ON CONFLICT (version) DO NOTHING;

COMMIT;
