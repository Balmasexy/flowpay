BEGIN;
CREATE TABLE IF NOT EXISTS public.fp_simulated_transfer_details (
  transaction_id uuid PRIMARY KEY REFERENCES public.fp_ledger_transactions(id) ON DELETE RESTRICT,
  provider text NOT NULL DEFAULT 'OPay' CHECK (provider = 'OPay'),
  destination_account text NOT NULL CHECK (destination_account ~ '^[0-9]{10}$'),
  simulation_only boolean NOT NULL DEFAULT true CHECK (simulation_only IS TRUE),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.schema_migrations(version) VALUES ('006_simulated_opay_transfers') ON CONFLICT (version) DO NOTHING;
COMMIT;
