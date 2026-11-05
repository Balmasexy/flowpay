BEGIN;

-- Store only an event identifier and a digest, never raw provider payloads.
-- This table makes repeated charge.completed notifications idempotent.
CREATE TABLE IF NOT EXISTS public.fp_flutterwave_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  transaction_id UUID NOT NULL REFERENCES public.fp_ledger_transactions(id),
  payload_sha256 CHAR(64) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fp_flutterwave_webhook_events_transaction_idx
  ON public.fp_flutterwave_webhook_events(transaction_id, received_at DESC);

INSERT INTO public.schema_migrations (version)
VALUES ('013_flutterwave_webhook_receipts')
ON CONFLICT (version) DO NOTHING;

COMMIT;
