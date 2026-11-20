BEGIN;

-- A phone number becomes a FlowPay recipient alias only after OTP verification.
-- This table is separate from the internal 10-digit FlowPay ID and bank NUBAN.
CREATE TABLE IF NOT EXISTS public.fp_customer_phone_aliases (
  user_id UUID PRIMARY KEY REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  phone_e164 TEXT NOT NULL UNIQUE,
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fp_customer_phone_aliases_phone_format_check
    CHECK (phone_e164 ~ '^\\+234[789][0-9]{9}$')
);

-- Registration challenges are email-bound before the user signs up with Neon Auth.
-- OTP hashes only are stored; raw OTP values are never persisted.
CREATE TABLE IF NOT EXISTS public.fp_registration_phone_challenges (
  email TEXT PRIMARY KEY,
  phone_e164 TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  send_count SMALLINT NOT NULL DEFAULT 1 CHECK (send_count BETWEEN 1 AND 5),
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fp_registration_phone_challenges_email_format_check
    CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  CONSTRAINT fp_registration_phone_challenges_phone_format_check
    CHECK (phone_e164 ~ '^\\+234[789][0-9]{9}$')
);

CREATE INDEX IF NOT EXISTS fp_registration_phone_challenges_pending_idx
  ON public.fp_registration_phone_challenges(phone_e164, expires_at)
  WHERE verified_at IS NOT NULL AND consumed_at IS NULL;

INSERT INTO public.schema_migrations(version)
VALUES ('028_verified_phone_recipient_aliases')
ON CONFLICT (version) DO NOTHING;

COMMIT;
