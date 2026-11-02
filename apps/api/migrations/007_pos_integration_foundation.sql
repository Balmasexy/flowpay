BEGIN;

-- FlowPay POS foundation. This migration stores terminal/provider metadata only.
-- It does not create payment credentials, contact a provider, post ledger entries,
-- or enable live payment processing.

CREATE TABLE IF NOT EXISTS fp_pos_provider_connections (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id         UUID NOT NULL REFERENCES fp_users(id),
    provider_code       TEXT NOT NULL CHECK (provider_code ~ '^[a-z0-9][a-z0-9_-]{1,49}$'),
    integration_mode    TEXT NOT NULL CHECK (integration_mode IN ('provider_api', 'terminal_sdk', 'terminal_push', 'qr')),
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sandbox_ready', 'approved', 'suspended', 'revoked')),
    display_name        TEXT,
    credential_ref      TEXT,
    live_enabled        BOOLEAN NOT NULL DEFAULT FALSE CHECK (live_enabled = FALSE),
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (merchant_id, provider_code, integration_mode)
);

CREATE INDEX IF NOT EXISTS fp_pos_provider_connections_merchant_idx
    ON fp_pos_provider_connections(merchant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fp_pos_terminals (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id             UUID NOT NULL REFERENCES fp_users(id),
    provider_connection_id  UUID REFERENCES fp_pos_provider_connections(id),
    provider_code           TEXT NOT NULL CHECK (provider_code ~ '^[a-z0-9][a-z0-9_-]{1,49}$'),
    external_terminal_ref   TEXT,
    terminal_label          TEXT,
    manufacturer            TEXT,
    model                   TEXT,
    platform                TEXT NOT NULL DEFAULT 'unknown'
                            CHECK (platform IN ('android_phone', 'android_pos', 'linux_pos', 'other', 'unknown')),
    connection_status       TEXT NOT NULL DEFAULT 'unlinked'
                            CHECK (connection_status IN ('unlinked', 'pending', 'connected', 'offline', 'suspended')),
    last_seen_at            TIMESTAMPTZ,
    metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (external_terminal_ref IS NULL OR length(trim(external_terminal_ref)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS fp_pos_terminal_provider_ref_unique
    ON fp_pos_terminals(provider_code, external_terminal_ref)
    WHERE external_terminal_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS fp_pos_terminals_merchant_idx
    ON fp_pos_terminals(merchant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fp_pos_payment_intents (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id             UUID NOT NULL REFERENCES fp_users(id),
    terminal_id             UUID REFERENCES fp_pos_terminals(id),
    provider_code           TEXT NOT NULL CHECK (provider_code ~ '^[a-z0-9][a-z0-9_-]{1,49}$'),
    idempotency_key         TEXT NOT NULL,
    amount_minor            BIGINT NOT NULL CHECK (amount_minor > 0),
    currency                CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    status                  TEXT NOT NULL DEFAULT 'created'
                            CHECK (status IN ('created', 'awaiting_terminal', 'pending', 'succeeded', 'failed', 'cancelled', 'expired')),
    provider_reference      TEXT,
    failure_code            TEXT,
    expires_at              TIMESTAMPTZ,
    confirmed_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (merchant_id, idempotency_key),
    CHECK (status <> 'succeeded' OR (provider_reference IS NOT NULL AND confirmed_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS fp_pos_payment_provider_ref_unique
    ON fp_pos_payment_intents(provider_code, provider_reference)
    WHERE provider_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS fp_pos_payment_intents_merchant_idx
    ON fp_pos_payment_intents(merchant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fp_pos_webhook_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_code       TEXT NOT NULL CHECK (provider_code ~ '^[a-z0-9][a-z0-9_-]{1,49}$'),
    provider_event_id   TEXT NOT NULL,
    event_type          TEXT NOT NULL,
    payload_digest      TEXT NOT NULL,
    processing_status   TEXT NOT NULL DEFAULT 'received'
                        CHECK (processing_status IN ('received', 'verified', 'processed', 'rejected', 'failed')),
    received_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at        TIMESTAMPTZ,
    UNIQUE (provider_code, provider_event_id)
);

CREATE TABLE IF NOT EXISTS fp_pos_audit_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id     UUID NOT NULL REFERENCES fp_users(id),
    actor_user_id   UUID REFERENCES fp_users(id),
    terminal_id     UUID REFERENCES fp_pos_terminals(id),
    payment_intent_id UUID REFERENCES fp_pos_payment_intents(id),
    action          TEXT NOT NULL CHECK (length(trim(action)) > 0),
    outcome         TEXT NOT NULL DEFAULT 'recorded',
    details         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fp_pos_audit_merchant_idx
    ON fp_pos_audit_events(merchant_id, created_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('007_pos_integration_foundation')
ON CONFLICT (version) DO NOTHING;

COMMIT;
