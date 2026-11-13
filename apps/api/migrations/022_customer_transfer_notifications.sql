BEGIN;

-- Customer-visible, private in-app notifications. Each row belongs to one
-- FlowPay user; event_key prevents duplicate alerts from webhook/status retries.
CREATE TABLE IF NOT EXISTS public.fp_customer_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.fp_users(id) ON DELETE RESTRICT,
  event_key TEXT NOT NULL CHECK (length(event_key) BETWEEN 1 AND 180),
  transaction_id UUID REFERENCES public.fp_ledger_transactions(id) ON DELETE RESTRICT,
  reference TEXT NOT NULL CHECK (length(reference) BETWEEN 1 AND 80),
  transfer_type TEXT NOT NULL CHECK (transfer_type IN ('wallet', 'bank')),
  direction TEXT NOT NULL CHECK (direction IN ('sent', 'received')),
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'reversed')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL CHECK (currency = 'NGN'),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 400),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  UNIQUE (user_id, event_key)
);

CREATE INDEX IF NOT EXISTS fp_customer_notifications_user_created_idx
  ON public.fp_customer_notifications(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS fp_customer_notifications_unread_idx
  ON public.fp_customer_notifications(user_id, created_at DESC)
  WHERE read_at IS NULL;

INSERT INTO public.schema_migrations(version)
VALUES ('022_customer_transfer_notifications')
ON CONFLICT (version) DO NOTHING;

COMMIT;
