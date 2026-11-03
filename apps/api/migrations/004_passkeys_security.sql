BEGIN;

-- Additive security tables only. Existing customers, accounts, balances and ledger rows are untouched.
CREATE TABLE IF NOT EXISTS fp_passkeys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES fp_users(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key BYTEA NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports TEXT[] NOT NULL DEFAULT '{}',
  device_type TEXT CHECK (device_type IS NULL OR device_type IN ('singleDevice', 'multiDevice')),
  backed_up BOOLEAN NOT NULL DEFAULT FALSE,
  name TEXT NOT NULL DEFAULT 'Passkey' CHECK (length(name) BETWEEN 1 AND 80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS fp_passkeys_user_active_idx
  ON fp_passkeys(user_id, created_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS fp_passkey_challenges (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES fp_users(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('registration', 'authentication')),
  challenge TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS fp_passkey_challenges_expiry_idx
  ON fp_passkey_challenges(expires_at);

CREATE TABLE IF NOT EXISTS fp_security_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES fp_users(id),
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'rejected')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS fp_security_audit_user_created_idx
  ON fp_security_audit_events(user_id, created_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('004_passkeys_security')
ON CONFLICT (version) DO NOTHING;

COMMIT;
