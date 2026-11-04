BEGIN;

-- Provider metadata only. Raw selfie and liveness frames are never stored here.
CREATE TABLE IF NOT EXISTS public.fp_face_verification_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.fp_users(id),
  smile_user_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL UNIQUE,
  smile_job_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'under_review', 'verified', 'rejected', 'failed')),
  result_code TEXT,
  result_text TEXT,
  liveness_check TEXT,
  selfie_check TEXT,
  selfie_provided TEXT,
  human_review_liveness_check TEXT,
  consented_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (result_code IS NULL OR length(result_code) <= 20),
  CHECK (result_text IS NULL OR length(result_text) <= 240)
);

CREATE INDEX IF NOT EXISTS fp_face_verification_user_created_idx
  ON public.fp_face_verification_jobs(user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS fp_face_verification_one_open_job_per_user_idx
  ON public.fp_face_verification_jobs(user_id)
  WHERE status IN ('pending', 'under_review');

INSERT INTO schema_migrations (version)
VALUES ('011_face_verification')
ON CONFLICT (version) DO NOTHING;

COMMIT;