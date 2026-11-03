BEGIN;

-- Existing users remain ordinary customers unless explicitly promoted.
ALTER TABLE fp_users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'customer';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fp_users_role_check'
      AND conrelid = 'public.fp_users'::regclass
  ) THEN
    ALTER TABLE fp_users
      ADD CONSTRAINT fp_users_role_check CHECK (role IN ('customer', 'admin'));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS fp_admin_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES fp_users(id),
  auth_subject TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('first_admin_bootstrap')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fp_admin_audit_events_created_idx
  ON fp_admin_audit_events(created_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('005_admin_bootstrap')
ON CONFLICT (version) DO NOTHING;

COMMIT;
