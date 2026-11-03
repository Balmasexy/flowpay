BEGIN;

-- Map the verified Neon Auth subject to one existing FlowPay customer.
ALTER TABLE fp_users ADD COLUMN IF NOT EXISTS auth_subject TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS fp_users_auth_subject_unique
  ON fp_users(auth_subject) WHERE auth_subject IS NOT NULL;

-- Store provider references and non-sensitive card display metadata only.
-- Never store PAN, CVV/CVC, PIN, or raw card credentials here.
CREATE TABLE IF NOT EXISTS fp_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES fp_users(id),
  provider TEXT NOT NULL DEFAULT 'unconfigured',
  provider_card_id TEXT,
  card_type TEXT NOT NULL CHECK (card_type IN ('virtual', 'physical')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'frozen', 'blocked', 'closed', 'failed')),
  last4 CHAR(4) CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$'),
  expiry_month SMALLINT CHECK (expiry_month IS NULL OR expiry_month BETWEEN 1 AND 12),
  expiry_year SMALLINT CHECK (expiry_year IS NULL OR expiry_year BETWEEN 2020 AND 2200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (provider_card_id IS NULL OR length(trim(provider_card_id)) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS fp_cards_provider_ref_unique
  ON fp_cards(provider, provider_card_id) WHERE provider_card_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fp_cards_user_created_idx
  ON fp_cards(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fp_card_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id UUID NOT NULL REFERENCES fp_cards(id),
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  outcome TEXT NOT NULL DEFAULT 'recorded'
    CHECK (outcome IN ('recorded', 'succeeded', 'failed', 'rejected')),
  actor_user_id UUID REFERENCES fp_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS fp_card_events_card_created_idx
  ON fp_card_events(card_id, created_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('003_customer_profile_cards')
ON CONFLICT (version) DO NOTHING;

COMMIT;
