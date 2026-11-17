BEGIN;

-- FlowPay customer bootstrap uses these partial unique conflict targets.
-- The live customer database was missing both indexes even though the
-- application provisioning handler relies on them for idempotency.

CREATE UNIQUE INDEX IF NOT EXISTS fp_accounts_customer_user_currency_unique
  ON fp_accounts (user_id, currency)
  WHERE account_type = 'customer' AND user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS fp_cards_pending_issuer_virtual_user_unique
  ON fp_cards (user_id)
  WHERE provider = 'issuer_pending'
    AND card_type = 'virtual'
    AND status = 'pending';

INSERT INTO schema_migrations (version)
VALUES ('027_customer_provisioning_unique_indexes')
ON CONFLICT (version) DO NOTHING;

COMMIT;
