BEGIN;

-- A pending checkout session is persisted before calling Flutterwave so a
-- retry with the same customer idempotency key cannot create duplicate charges.
-- Existing rows keep their checkout URLs; only pending sessions may be NULL.
ALTER TABLE public.fp_flutterwave_deposits
  ALTER COLUMN checkout_url DROP NOT NULL;

INSERT INTO public.schema_migrations (version)
VALUES ('012_flutterwave_pending_checkout_sessions')
ON CONFLICT (version) DO NOTHING;

COMMIT;
