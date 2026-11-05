BEGIN;

-- Reuse the existing provider-event ledger from migration 001. Add nullable
-- metadata only; existing event rows and statuses remain unchanged.
ALTER TABLE public.fp_payment_events
  ADD COLUMN IF NOT EXISTS transaction_id UUID REFERENCES public.fp_ledger_transactions(id),
  ADD COLUMN IF NOT EXISTS payload_sha256 CHAR(64);

CREATE INDEX IF NOT EXISTS fp_payment_events_transaction_idx
  ON public.fp_payment_events(transaction_id, received_at DESC)
  WHERE transaction_id IS NOT NULL;

INSERT INTO public.schema_migrations (version)
VALUES ('013_flutterwave_webhook_receipts')
ON CONFLICT (version) DO NOTHING;

COMMIT;
