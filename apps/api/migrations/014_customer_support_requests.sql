BEGIN;

-- Additive customer support storage. Existing customer, wallet, and ledger rows
-- are untouched. Support content is scoped to its authenticated FlowPay user.
CREATE TABLE IF NOT EXISTS public.fp_support_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  client_request_id UUID NOT NULL,
  ticket_reference TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN (
    'Transaction issue', 'Account access', 'Profile or photo',
    'Card issue', 'Airtime, data or bill', 'Security concern', 'Other'
  )),
  reference_text TEXT,
  details TEXT NOT NULL CHECK (length(trim(details)) BETWEEN 20 AND 2000),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, client_request_id),
  CHECK (reference_text IS NULL OR length(reference_text) <= 100)
);

CREATE INDEX IF NOT EXISTS fp_support_requests_user_created_idx
  ON public.fp_support_requests(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS fp_support_requests_status_created_idx
  ON public.fp_support_requests(status, created_at DESC);

INSERT INTO public.schema_migrations (version)
VALUES ('014_customer_support_requests')
ON CONFLICT (version) DO NOTHING;

COMMIT;
