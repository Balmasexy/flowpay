BEGIN;

-- Preserve existing customer/admin values while permitting an explicitly
-- provisioned super_admin role used by the existing /admin/session gate.
ALTER TABLE public.fp_users
  DROP CONSTRAINT IF EXISTS fp_users_role_check;
ALTER TABLE public.fp_users
  ADD CONSTRAINT fp_users_role_check
  CHECK (role IN ('customer','admin','super_admin'));

-- Receipt metadata is kept in Postgres; the private file bytes are stored in
-- the configured S3-compatible object store. Existing wallet and ledger rows
-- are not modified.
CREATE TABLE IF NOT EXISTS public.fp_deposit_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  client_request_id UUID NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  reference_text TEXT,
  customer_note TEXT,
  object_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  content_sha256 CHAR(64),
  status TEXT NOT NULL DEFAULT 'pending_upload'
    CHECK (status IN ('pending_upload','pending_review','approved','rejected')),
  uploaded_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  review_bank_reference TEXT,
  ledger_transaction_id UUID UNIQUE REFERENCES public.fp_ledger_transactions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, client_request_id),
  CHECK (reference_text IS NULL OR length(reference_text) <= 100),
  CHECK (customer_note IS NULL OR length(customer_note) <= 500),
  CHECK (review_note IS NULL OR length(review_note) <= 500),
  CHECK (review_bank_reference IS NULL OR length(review_bank_reference) BETWEEN 5 AND 100),
  CHECK (
    (status = 'pending_upload' AND uploaded_at IS NULL AND reviewed_at IS NULL AND ledger_transaction_id IS NULL)
    OR
    (status = 'pending_review' AND uploaded_at IS NOT NULL AND reviewed_at IS NULL AND ledger_transaction_id IS NULL)
    OR
    (status = 'approved' AND uploaded_at IS NOT NULL AND reviewed_at IS NOT NULL AND
      reviewed_by IS NOT NULL AND review_bank_reference IS NOT NULL AND ledger_transaction_id IS NOT NULL)
    OR
    (status = 'rejected' AND uploaded_at IS NOT NULL AND reviewed_at IS NOT NULL AND
      reviewed_by IS NOT NULL AND review_note IS NOT NULL AND ledger_transaction_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS fp_deposit_receipts_user_created_idx
  ON public.fp_deposit_receipts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fp_deposit_receipts_review_queue_idx
  ON public.fp_deposit_receipts(created_at ASC)
  WHERE status = 'pending_review';
CREATE UNIQUE INDEX IF NOT EXISTS fp_deposit_receipts_bank_reference_unique
  ON public.fp_deposit_receipts(review_bank_reference)
  WHERE review_bank_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.fp_deposit_receipt_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID NOT NULL REFERENCES public.fp_deposit_receipts(id) ON DELETE RESTRICT,
  actor_user_id UUID NOT NULL REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('customer','super_admin')),
  action TEXT NOT NULL CHECK (action IN ('submitted','uploaded','approved','rejected')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS fp_deposit_receipt_audit_receipt_created_idx
  ON public.fp_deposit_receipt_audit_events(receipt_id, created_at DESC);

-- A dedicated clearing account keeps manually verified bank receipt credits
-- balanced separately from Paystack and Flutterwave settlement flows.
ALTER TABLE public.fp_accounts
  DROP CONSTRAINT IF EXISTS fp_accounts_system_role_check;
ALTER TABLE public.fp_accounts
  ADD CONSTRAINT fp_accounts_system_role_check
  CHECK (
    system_account_role IS NULL OR
    (account_type = 'system' AND system_account_role IN (
      'flutterwave_ngn_clearing',
      'paystack_ngn_clearing',
      'manual_receipt_ngn_clearing'
    ))
  );

INSERT INTO public.fp_accounts (user_id, account_type, currency, status, system_account_role)
VALUES (NULL, 'system', 'NGN', 'active', 'manual_receipt_ngn_clearing')
ON CONFLICT (system_account_role, currency)
  WHERE system_account_role IS NOT NULL
DO NOTHING;

INSERT INTO public.schema_migrations(version)
VALUES ('018_deposit_receipt_submissions')
ON CONFLICT (version) DO NOTHING;

COMMIT;
