BEGIN;

-- Customer evidence for investigating a Paystack deposit that remains pending.
-- Receipt files are private and only accessible to their owner or a verified
-- FlowPay super administrator. This table never posts ledger entries.
CREATE TABLE IF NOT EXISTS public.fp_deposit_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES public.fp_paystack_deposits(transaction_id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  file_name TEXT NOT NULL CHECK (length(trim(file_name)) BETWEEN 1 AND 120),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  file_data BYTEA NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size BETWEEN 1 AND 4194304),
  file_sha256 CHAR(64) NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  review_status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (review_status IN ('pending_review', 'evidence_accepted', 'rejected')),
  reviewer_user_id UUID REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  review_note TEXT CHECK (review_note IS NULL OR length(review_note) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  CONSTRAINT fp_deposit_receipts_file_size_check
    CHECK (octet_length(file_data) = file_size),
  CONSTRAINT fp_deposit_receipts_review_state_check
    CHECK (
      (review_status = 'pending_review' AND reviewer_user_id IS NULL AND reviewed_at IS NULL)
      OR
      (review_status <> 'pending_review' AND reviewer_user_id IS NOT NULL AND reviewed_at IS NOT NULL)
    ),
  CONSTRAINT fp_deposit_receipts_transaction_hash_unique
    UNIQUE (transaction_id, file_sha256)
);

CREATE INDEX IF NOT EXISTS fp_deposit_receipts_user_created_idx
  ON public.fp_deposit_receipts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fp_deposit_receipts_review_created_idx
  ON public.fp_deposit_receipts(review_status, created_at ASC);

INSERT INTO public.schema_migrations(version)
VALUES ('018_deposit_receipt_review')
ON CONFLICT(version) DO NOTHING;

COMMIT;
