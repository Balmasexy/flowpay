import type { Pool, PoolClient } from "pg";

type PaystackDomain = "test" | "live";
type VerifiedCharge = Record<string, unknown>;
type Dva = {
  user_id: string;
  paystack_customer_code: string | null;
  account_number: string;
  status: string;
};
type Deposit = {
  transaction_id: string;
  user_id: string;
  account_id: string;
  reference: string;
  provider_transaction_id: string | null;
  amount_minor: string;
  currency: string;
  status: "pending" | "posted" | "failed";
};
type LedgerGroup = { account_id: string; amount_minor: string; entry_count: number };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function safeProviderId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^\d{1,30}$/.test(value)) return value;
  return null;
}
function safeAmount(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const raw = String(value);
  if (!/^\d{1,15}$/.test(raw) || !Number.isSafeInteger(Number(raw)) || BigInt(raw) <= 0n) return null;
  return raw;
}
function balancedLedger(rows: LedgerGroup[], customerAccountId: string, clearingAccountId: string, amount: string) {
  if (rows.length !== 2) return false;
  const customer = rows.find(row => row.account_id === customerAccountId);
  const clearing = rows.find(row => row.account_id === clearingAccountId);
  return Boolean(
    customer && clearing &&
    customer.entry_count === 1 && clearing.entry_count === 1 &&
    customer.amount_minor === amount &&
    clearing.amount_minor === (-BigInt(amount)).toString()
  );
}

/**
 * Credits a Paystack Dedicated Virtual Account payment after the caller has
 * independently verified the charge with Paystack's transaction verify API.
 *
 * This deliberately does not depend on the DVA assignment feature switch:
 * disabling new account assignments must never strand funds already received
 * into an account that FlowPay previously assigned.
 */
export async function settleVerifiedPaystackDvaCharge(
  pool: Pool,
  environment: PaystackDomain,
  verified: VerifiedCharge,
  payloadSha256: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const reference = typeof verified.reference === "string" ? verified.reference.trim() : "";
  const providerTransactionId = safeProviderId(verified.id);
  const amount = safeAmount(verified.amount);
  const currency = typeof verified.currency === "string" ? verified.currency : "";
  const domain = typeof verified.domain === "string" ? verified.domain : "";
  const authorization = record(verified.authorization);
  const channel = typeof verified.channel === "string" ? verified.channel
    : typeof authorization.channel === "string" ? authorization.channel : "";
  const receiverAccountNumber = typeof authorization.receiver_bank_account_number === "string"
    ? authorization.receiver_bank_account_number.trim() : "";
  const customer = record(verified.customer);
  const customerCode = typeof customer.customer_code === "string" ? customer.customer_code.trim() : "";

  if (verified.status !== "success" || domain !== environment || channel !== "dedicated_nuban" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(reference) ||
      !providerTransactionId || !amount || currency !== "NGN" ||
      !/^\d{10}$/.test(receiverAccountNumber) ||
      (customerCode && !/^CUS_[A-Za-z0-9]+$/.test(customerCode)) ||
      !/^[0-9a-f]{64}$/.test(payloadSha256)) {
    return { status: 202, body: { received: true, processed: false, reason: "INVALID_DEDICATED_ACCOUNT_CHARGE" } };
  }

  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    const dvaResult = await client.query<Dva>(
      `SELECT user_id, paystack_customer_code, account_number, status
         FROM public.fp_paystack_dedicated_accounts_v2
        WHERE provider_domain = $1 AND account_number = $2 AND status = 'assigned'
        FOR UPDATE`,
      [environment, receiverAccountNumber]
    );
    if (dvaResult.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { status: 202, body: { received: true, processed: false, reason: "ASSIGNED_DEDICATED_ACCOUNT_NOT_FOUND" } };
    }
    const dva = dvaResult.rows[0];
    if (dva.paystack_customer_code && customerCode !== dva.paystack_customer_code) {
      await client.query("ROLLBACK");
      return { status: 202, body: { received: true, processed: false, reason: "DEDICATED_ACCOUNT_CUSTOMER_MISMATCH" } };
    }

    const wallets = await client.query<{ id: string }>(
      `SELECT id FROM public.fp_accounts
        WHERE user_id = $1 AND account_type = 'customer' AND currency = 'NGN'
          AND status = 'active'
        ORDER BY id FOR UPDATE`,
      [dva.user_id]
    );
    if (wallets.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { status: 202, body: { received: true, processed: false, reason: "ACTIVE_NGN_WALLET_NOT_UNIQUE" } };
    }
    const customerAccountId = wallets.rows[0].id;

    let depositResult = await client.query<Deposit>(
      `SELECT transaction_id, user_id, account_id, reference, provider_transaction_id,
              amount_minor::text AS amount_minor, currency, status
         FROM public.fp_paystack_deposits
        WHERE reference = $1
        FOR UPDATE`,
      [reference]
    );
    let deposit: Deposit;
    let created = false;
    if (depositResult.rowCount === 1) {
      deposit = depositResult.rows[0];
      if (deposit.user_id !== dva.user_id || deposit.account_id !== customerAccountId ||
          deposit.amount_minor !== amount || deposit.currency.trim() !== "NGN" ||
          (deposit.provider_transaction_id && deposit.provider_transaction_id !== providerTransactionId)) {
        await client.query("ROLLBACK");
        return { status: 202, body: { received: true, processed: false, reason: "DEDICATED_ACCOUNT_DEPOSIT_MISMATCH" } };
      }
    } else {
      const idempotencyKey = `paystack-dva-deposit:${environment}:${reference}`;
      const insertedTransaction = await client.query<{ id: string }>(
        `INSERT INTO public.fp_ledger_transactions
           (idempotency_key, transaction_type, status, description)
         VALUES ($1, 'paystack_deposit', 'pending', 'Paystack dedicated virtual account NGN deposit')
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [idempotencyKey]
      );
      if (insertedTransaction.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { status: 503, body: { error: "DEDICATED_ACCOUNT_DEPOSIT_IDEMPOTENCY_REQUIRES_RECONCILIATION" } };
      }
      const transactionId = insertedTransaction.rows[0].id;
      const insertedDeposit = await client.query<Deposit>(
        `INSERT INTO public.fp_paystack_deposits
           (transaction_id, user_id, account_id, reference, provider_transaction_id,
            amount_minor, currency, status)
         VALUES ($1,$2,$3,$4,$5,$6,'NGN','pending')
         RETURNING transaction_id, user_id, account_id, reference, provider_transaction_id,
                   amount_minor::text AS amount_minor, currency, status`,
        [transactionId, dva.user_id, customerAccountId, reference, providerTransactionId, amount]
      );
      if (insertedDeposit.rowCount !== 1) throw new Error("DEDICATED_ACCOUNT_DEPOSIT_INSERT_FAILED");
      deposit = insertedDeposit.rows[0];
      created = true;
    }

    const transaction = await client.query<{ status: string }>(
      "SELECT status FROM public.fp_ledger_transactions WHERE id = $1 FOR UPDATE",
      [deposit.transaction_id]
    );
    if (transaction.rowCount !== 1) throw new Error("FLOWPAY_LEDGER_TRANSACTION_NOT_FOUND");
    const clearing = await client.query<{ id: string }>(
      `SELECT id FROM public.fp_accounts
        WHERE account_type = 'system' AND currency = 'NGN'
          AND system_account_role = 'paystack_ngn_clearing' AND status = 'active'
        FOR UPDATE`
    );
    if (clearing.rowCount !== 1) throw new Error("PAYSTACK_CLEARING_ACCOUNT_NOT_CONFIGURED");
    const clearingAccountId = clearing.rows[0].id;

    if (transaction.rows[0].status === "posted" && deposit.status === "posted") {
      const entries = await client.query<LedgerGroup>(
        `SELECT account_id::text AS account_id, SUM(amount_minor)::text AS amount_minor,
                COUNT(*)::int AS entry_count
           FROM public.fp_ledger_entries WHERE transaction_id = $1
          GROUP BY account_id`,
        [deposit.transaction_id]
      );
      if (!balancedLedger(entries.rows, customerAccountId, clearingAccountId, amount)) {
        throw new Error("POSTED_DEDICATED_ACCOUNT_LEDGER_REQUIRES_RECONCILIATION");
      }
      const receipt = await client.query(
        `INSERT INTO public.fp_payment_events
           (provider, provider_event_id, event_type, transaction_id, payload_sha256, processing_status)
         VALUES ('paystack', $1, 'charge.success', $2, $3, 'processed')
         ON CONFLICT (provider, provider_event_id) DO NOTHING`,
        [reference, deposit.transaction_id, payloadSha256]
      );
      if (receipt.rowCount === 0) {
        const saved = await client.query<{ transaction_id: string; payload_sha256: string | null }>(
          `SELECT transaction_id::text, payload_sha256
             FROM public.fp_payment_events
            WHERE provider = 'paystack' AND provider_event_id = $1
            FOR UPDATE`,
          [reference]
        );
        if (saved.rowCount !== 1 || saved.rows[0].transaction_id !== deposit.transaction_id ||
            (saved.rows[0].payload_sha256 && saved.rows[0].payload_sha256 !== payloadSha256)) {
          throw new Error("DEDICATED_ACCOUNT_DUPLICATE_EVENT_MISMATCH");
        }
        await client.query(
          `UPDATE public.fp_payment_events SET processing_status = 'processed'
            WHERE provider = 'paystack' AND provider_event_id = $1`,
          [reference]
        );
      }
      await client.query("COMMIT");
      return {
        status: 200,
        body: {
          received: true, processed: true, duplicate: true, providerVerified: true,
          transactionId: deposit.transaction_id, reference, status: "posted",
          walletCredited: true, channel: "dedicated_nuban"
        }
      };
    }

    if (transaction.rows[0].status !== "pending" || deposit.status !== "pending") {
      throw new Error("DEDICATED_ACCOUNT_DEPOSIT_STATE_REQUIRES_RECONCILIATION");
    }
    const existingEntries = await client.query<{ entry_count: number }>(
      "SELECT COUNT(*)::int AS entry_count FROM public.fp_ledger_entries WHERE transaction_id = $1",
      [deposit.transaction_id]
    );
    if (Number(existingEntries.rows[0]?.entry_count ?? 0) !== 0) {
      throw new Error("PENDING_DEDICATED_ACCOUNT_LEDGER_ENTRIES_REQUIRE_RECONCILIATION");
    }

    const eventReceipt = await client.query(
      `INSERT INTO public.fp_payment_events
         (provider, provider_event_id, event_type, transaction_id, payload_sha256, processing_status)
       VALUES ('paystack', $1, 'charge.success', $2, $3, 'pending')
       ON CONFLICT (provider, provider_event_id) DO NOTHING
       RETURNING provider_event_id`,
      [reference, deposit.transaction_id, payloadSha256]
    );
    if (eventReceipt.rowCount === 0) {
      const saved = await client.query<{ transaction_id: string; payload_sha256: string | null }>(
        `SELECT transaction_id::text, payload_sha256
           FROM public.fp_payment_events
          WHERE provider = 'paystack' AND provider_event_id = $1
          FOR UPDATE`,
        [reference]
      );
      if (saved.rowCount !== 1 || saved.rows[0].transaction_id !== deposit.transaction_id ||
          (saved.rows[0].payload_sha256 && saved.rows[0].payload_sha256 !== payloadSha256)) {
        throw new Error("DEDICATED_ACCOUNT_DUPLICATE_EVENT_MISMATCH");
      }
    }

    await client.query(
      `INSERT INTO public.fp_ledger_entries (transaction_id, account_id, amount_minor, currency)
       VALUES ($1,$2,$3,'NGN'), ($1,$4,$5,'NGN')`,
      [deposit.transaction_id, customerAccountId, amount, clearingAccountId, (-BigInt(amount)).toString()]
    );
    const posted = await client.query(
      `UPDATE public.fp_ledger_transactions
          SET status = 'posted', posted_at = NOW()
        WHERE id = $1 AND status = 'pending'`,
      [deposit.transaction_id]
    );
    if (posted.rowCount !== 1) throw new Error("DEDICATED_ACCOUNT_DEPOSIT_LEDGER_POST_FAILED");
    const updated = await client.query(
      `UPDATE public.fp_paystack_deposits
          SET status = 'posted', provider_transaction_id = $2, verified_at = NOW()
        WHERE transaction_id = $1 AND status = 'pending'`,
      [deposit.transaction_id, providerTransactionId]
    );
    if (updated.rowCount !== 1) throw new Error("DEDICATED_ACCOUNT_DEPOSIT_STATUS_UPDATE_FAILED");
    await client.query(
      `UPDATE public.fp_payment_events SET processing_status = 'processed'
        WHERE provider = 'paystack' AND provider_event_id = $1`,
      [reference]
    );
    await client.query("COMMIT");
    return {
      status: 200,
      body: {
        received: true, processed: true, duplicate: false, providerVerified: true,
        transactionId: deposit.transaction_id, reference, status: "posted",
        walletCredited: true, channel: "dedicated_nuban", created
      }
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("FlowPay Paystack dedicated-account deposit settlement failed:", error instanceof Error ? error.message : "database error");
    return { status: 503, body: { error: "DEDICATED_ACCOUNT_DEPOSIT_SETTLEMENT_UNAVAILABLE" } };
  } finally {
    client.release();
  }
}
