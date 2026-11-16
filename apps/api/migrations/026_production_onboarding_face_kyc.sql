BEGIN;

-- Keep sandbox and production biometric decisions separate. A sandbox approval
-- must never satisfy the production payment/withdrawal KYC gate.
ALTER TABLE public.fp_face_verification_jobs
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'sandbox';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'fp_face_verification_jobs_environment_check'
       AND conrelid = 'public.fp_face_verification_jobs'::regclass
  ) THEN
    ALTER TABLE public.fp_face_verification_jobs
      ADD CONSTRAINT fp_face_verification_jobs_environment_check
      CHECK (environment IN ('sandbox', 'production'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS fp_face_verification_production_gate_idx
  ON public.fp_face_verification_jobs(user_id, environment, status, created_at DESC);

-- Every customer has at most one wallet per currency. System clearing accounts
-- remain separate and are excluded from this partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS fp_accounts_customer_currency_unique
  ON public.fp_accounts(user_id, currency)
  WHERE account_type = 'customer' AND user_id IS NOT NULL;

-- One clearly unissued virtual-card placeholder may be shown per customer.
-- This row contains no PAN, CVV, expiry, or provider card identifier.
CREATE UNIQUE INDEX IF NOT EXISTS fp_cards_pending_issuer_virtual_unique
  ON public.fp_cards(user_id)
  WHERE provider = 'issuer_pending'
    AND card_type = 'virtual'
    AND status = 'pending';

INSERT INTO public.schema_migrations(version)
VALUES ('026_production_onboarding_face_kyc')
ON CONFLICT (version) DO NOTHING;

COMMIT;
