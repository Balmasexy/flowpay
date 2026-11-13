-- TEST-ONLY Better Auth passkey schema.
-- Apply only to the dedicated FlowPay Passkey Prototype Neon project.
-- This schema is separate from public FlowPay tables and production Neon Auth.

BEGIN;

CREATE SCHEMA IF NOT EXISTS passkey_auth;

CREATE TABLE IF NOT EXISTS passkey_auth."user" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  "emailVerified" BOOLEAN NOT NULL DEFAULT FALSE,
  image TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS passkey_auth.session (
  id TEXT PRIMARY KEY,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  token TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES passkey_auth."user"(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS passkey_auth_session_user_idx
  ON passkey_auth.session ("userId");

CREATE TABLE IF NOT EXISTS passkey_auth.account (
  id TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES passkey_auth."user"(id) ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" TIMESTAMPTZ,
  "refreshTokenExpiresAt" TIMESTAMPTZ,
  scope TEXT,
  password TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS passkey_auth_account_provider_id_idx
  ON passkey_auth.account ("providerId","accountId");
CREATE INDEX IF NOT EXISTS passkey_auth_account_user_idx
  ON passkey_auth.account ("userId");

CREATE TABLE IF NOT EXISTS passkey_auth.verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS passkey_auth_verification_identifier_idx
  ON passkey_auth.verification (identifier);

CREATE TABLE IF NOT EXISTS passkey_auth.passkey (
  id TEXT PRIMARY KEY,
  name TEXT,
  "publicKey" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES passkey_auth."user"(id) ON DELETE CASCADE,
  "credentialID" TEXT NOT NULL UNIQUE,
  counter BIGINT NOT NULL DEFAULT 0,
  "deviceType" TEXT NOT NULL,
  "backedUp" BOOLEAN NOT NULL DEFAULT FALSE,
  transports TEXT,
  "createdAt" TIMESTAMPTZ,
  aaguid TEXT
);
CREATE INDEX IF NOT EXISTS passkey_auth_passkey_user_idx
  ON passkey_auth.passkey ("userId");

CREATE TABLE IF NOT EXISTS passkey_auth.transaction_pin (
  user_id TEXT PRIMARY KEY REFERENCES passkey_auth."user"(id) ON DELETE CASCADE,
  salt BYTEA NOT NULL,
  pin_hash BYTEA NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS passkey_auth.transaction_challenges (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES passkey_auth."user"(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  context_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS passkey_auth_transaction_challenge_expiry_idx
  ON passkey_auth.transaction_challenges (expires_at);

CREATE TABLE IF NOT EXISTS passkey_auth.security_events (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES passkey_auth."user"(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','failed','rejected')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
