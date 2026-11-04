BEGIN;

-- Customer-editable contact details are isolated from identity, account
-- provisioning and ledger records. One profile per existing FlowPay user.
CREATE TABLE IF NOT EXISTS public.fp_customer_profiles (
  user_id UUID PRIMARY KEY REFERENCES public.fp_users(id) ON DELETE CASCADE,
  phone_number TEXT,
  residential_address TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (phone_number IS NULL OR length(phone_number) <= 24),
  CHECK (residential_address IS NULL OR length(residential_address) <= 500)
);

INSERT INTO schema_migrations (version)
VALUES ('009_customer_profile_details')
ON CONFLICT (version) DO NOTHING;

COMMIT;
