BEGIN;

-- Store a small private profile image with the customer's own profile row.
ALTER TABLE public.fp_customer_profiles
  ADD COLUMN IF NOT EXISTS photo_data BYTEA,
  ADD COLUMN IF NOT EXISTS photo_mime_type TEXT;

ALTER TABLE public.fp_customer_profiles
  DROP CONSTRAINT IF EXISTS fp_customer_profiles_photo_mime_type_check;

ALTER TABLE public.fp_customer_profiles
  ADD CONSTRAINT fp_customer_profiles_photo_mime_type_check
  CHECK (photo_mime_type IS NULL OR photo_mime_type IN ('image/jpeg', 'image/png', 'image/webp'));

INSERT INTO schema_migrations (version)
VALUES ('010_customer_profile_photo')
ON CONFLICT (version) DO NOTHING;

COMMIT;
