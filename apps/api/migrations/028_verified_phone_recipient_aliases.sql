BEGIN;

-- A verified Nigerian phone number is a second recipient alias for the same
-- FlowPay wallet. The permanent 10-digit FlowPay ID remains unchanged.
-- Neon Auth remains the source of OTP generation and phone verification.
CREATE TABLE IF NOT EXISTS public.fp_customer_phone_aliases (
  user_id UUID PRIMARY KEY REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  phone_e164 TEXT NOT NULL UNIQUE,
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fp_customer_phone_aliases_phone_format_check
    CHECK (phone_e164 ~ '^\\+234[789][0-9]{9}$')
);

INSERT INTO public.schema_migrations(version)
VALUES ('028_verified_phone_recipient_aliases')
ON CONFLICT (version) DO NOTHING;

COMMIT;
