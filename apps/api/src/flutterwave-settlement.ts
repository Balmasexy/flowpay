import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export type VerifiedFlutterwaveSettlement = {
  providerReference: string;
  providerTransactionId: string;
  amountMinor: string;
  currency: "NGN";
  eventId: string;
  eventType: "charge.completed" | "transaction.verify";
  payloadSha256?: string;
};

type Deposit = {
  transaction_id: string;
  user_id: string;
  account_id: string;
  provider_tx_ref: string;
  provider_transaction_id: string | null;
  amount_minor: string;
  currency: string;
  status: "pending" | "posted" | "failed";
};
type LedgerGroup = { account_id: string; amount_minor: string; entry_count: number };

function balancedLedger(rows: LedgerGroup[], customerId: string, clearingId: string, amount: string): boolean {
  if (rows.length !== 2) return false;
  const customer = rows.find(row => row.account_id === customerId);
  const clearing = rows.find(row => row.account_id === clearingId);
  return Boolean(customer && clearing &&
    customer.entry_count === 1 && clearing.entry_count === 1 &&
    customer.amount_minor === amount &&
    clearing.amount_minor === (-BigInt(amount)).toString());
}

function safeDigest(value: VerifiedFlutterwaveSettlement): string {
  return value.payloadSha256 && /^[a-f0-9]{64}$/i.test(value.payloadSha256)
    ? value.payloadSha256.toLowerCase()
    : createHash("sha256").update(JSON.stringify({
        reference:value.providerReference,
        providerTransactionId:value.providerTransactionId,
        amountMinor:value.amountMinor,
        currency:value.currency,
        eventType:value.eventType
      })).digest("hex");
}

async function queryLedger(client: PoolClient, transactionId: string): Promise<LedgerGroup[]> {
  const result = await client.query<LedgerGroup>(
    `SELECT account_id::text AS account_id,
            SUM(amount_minor)::text AS amount_minor,
            COUNT(*)::int AS entry_count
       FROM public.fp_ledger_entries
      WHERE transaction_id = $1
      GROUP BY account_id`,
    [transactionId]
  );
  return result.rows;
}

/**
 * Post a Flutterwave NGN deposit only after the caller has independently
 * verified the provider transaction. All receipt, ledger and deposit writes
 * are atomic and protected by database row locks.
 */
export async function settleVerifiedFlutterwaveDeposit(
  pool: Pool,
  input: VerifiedFlutterwaveSettlement
): Promise<{ status: "posted"; duplicate: boolean; walletCredited: true; transactionId: string }> {
  if (!input.providerReference || !/^\d{1,30}$/.test(input.providerTransactionId) ||
      !/^\d{1,15}$/.test(input.amountMinor) || BigInt(input.amountMinor) <= 0n ||
      input.currency !== "NGN" || !input.eventId || input.eventId.length > 120) {
    throw new Error("FLUTTERWAVE_SETTLEMENT_INPUT_INVALID");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const depositResult = await client.query<Deposit>(
      `SELECT transaction_id,user_id,account_id,provider_tx_ref,provider_transaction_id,
              amount_minor::text AS amount_minor,currency,status
         FROM public.fp_flutterwave_deposits
        WHERE provider_tx_ref = $1
        FOR UPDATE`,
      [input.providerReference]
    );
    if (depositResult.rowCount !== 1 || !depositResult.rows[0]) {
      throw new Error("FLOWPAY_FLUTTERWAVE_DEPOSIT_NOT_FOUND");
    }
    const deposit = depositResult.rows[0];
    if (deposit.currency.trim() !== "NGN" ||
        deposit.amount_minor !== input.amountMinor ||
        (deposit.provider_transaction_id && deposit.provider_transaction_id !== input.providerTransactionId) ||
        deposit.status === "failed") {
      throw new Error("FLOWPAY_FLUTTERWAVE_DEPOSIT_MISMATCH");
    }

    const digest = safeDigest(input);
    const inserted = await client.query(
      `INSERT INTO public.fp_payment_events
         (provider,provider_event_id,event_type,transaction_id,payload_sha256,processing_status)
       VALUES ('flutterwave',$1,$2,$3,$4,'pending')
       ON CONFLICT (provider,provider_event_id) DO NOTHING
       RETURNING provider_event_id`,
      [input.eventId,input.eventType,deposit.transaction_id,digest]
    );
    const duplicateReceipt = inserted.rowCount === 0;
    if (duplicateReceipt) {
      const receipt = await client.query<{ transaction_id:string; payload_sha256:string|null }>(
        `SELECT transaction_id::text,payload_sha256
           FROM public.fp_payment_events
          WHERE provider='flutterwave' AND provider_event_id=$1
          FOR UPDATE`,
        [input.eventId]
      );
      const previousDigest = receipt.rows[0]?.payload_sha256?.trim() ?? "";
      if (receipt.rowCount !== 1 ||
          receipt.rows[0]?.transaction_id !== deposit.transaction_id ||
          (previousDigest && previousDigest !== digest)) {
        throw new Error("FLUTTERWAVE_DUPLICATE_EVENT_MISMATCH");
      }
    }

    const transaction = await client.query<{ status:string }>(
      "SELECT status FROM public.fp_ledger_transactions WHERE id=$1 FOR UPDATE",
      [deposit.transaction_id]
    );
    if (transaction.rowCount !== 1) throw new Error("FLOWPAY_LEDGER_TRANSACTION_NOT_FOUND");

    const clearing = await client.query<{ id:string }>(
      `SELECT id FROM public.fp_accounts
        WHERE account_type='system' AND currency='NGN'
          AND system_account_role='flutterwave_ngn_clearing' AND status='active'
        FOR UPDATE`
    );
    if (clearing.rowCount !== 1 || !clearing.rows[0]) {
      throw new Error("FLUTTERWAVE_CLEARING_ACCOUNT_NOT_CONFIGURED");
    }
    const clearingAccountId = clearing.rows[0].id;

    if (transaction.rows[0].status === "posted") {
      const ledger = await queryLedger(client,deposit.transaction_id);
      if (!balancedLedger(ledger,deposit.account_id,clearingAccountId,input.amountMinor)) {
        throw new Error("POSTED_FLUTTERWAVE_LEDGER_REQUIRES_RECONCILIATION");
      }
      await client.query(
        `UPDATE public.fp_flutterwave_deposits
            SET status='posted',provider_transaction_id=$2,
                verified_at=COALESCE(verified_at,NOW()),
                posted_at=COALESCE(posted_at,NOW()),updated_at=NOW()
          WHERE transaction_id=$1`,
        [deposit.transaction_id,input.providerTransactionId]
      );
      await client.query(
        `UPDATE public.fp_payment_events SET processing_status='processed'
          WHERE provider='flutterwave' AND provider_event_id=$1`,
        [input.eventId]
      );
      await client.query("COMMIT");
      return {status:"posted",duplicate:duplicateReceipt,walletCredited:true,transactionId:deposit.transaction_id};
    }
    if (transaction.rows[0].status !== "pending" || deposit.status !== "pending") {
      throw new Error("FLUTTERWAVE_DEPOSIT_NOT_PENDING");
    }

    const customerAccount = await client.query<{ id:string }>(
      `SELECT id FROM public.fp_accounts
        WHERE id=$1 AND user_id=$2 AND account_type='customer'
          AND currency='NGN' AND status='active'
        FOR UPDATE`,
      [deposit.account_id,deposit.user_id]
    );
    if (customerAccount.rowCount !== 1) throw new Error("FLUTTERWAVE_CUSTOMER_WALLET_NOT_ACTIVE");

    const existing = await client.query<{ count:number }>(
      "SELECT COUNT(*)::int AS count FROM public.fp_ledger_entries WHERE transaction_id=$1",
      [deposit.transaction_id]
    );
    if (Number(existing.rows[0]?.count ?? 0) !== 0) {
      throw new Error("PENDING_FLUTTERWAVE_LEDGER_ENTRIES_REQUIRE_RECONCILIATION");
    }

    const debit = (-BigInt(input.amountMinor)).toString();
    await client.query(
      `INSERT INTO public.fp_ledger_entries(transaction_id,account_id,amount_minor,currency)
       VALUES($1,$2,$3,'NGN'),($1,$4,$5,'NGN')`,
      [deposit.transaction_id,deposit.account_id,input.amountMinor,clearingAccountId,debit]
    );
    const posted = await client.query(
      `UPDATE public.fp_ledger_transactions
          SET status='posted',posted_at=NOW()
        WHERE id=$1 AND status='pending'`,
      [deposit.transaction_id]
    );
    if (posted.rowCount !== 1) throw new Error("FLUTTERWAVE_LEDGER_POST_FAILED");

    const updated = await client.query(
      `UPDATE public.fp_flutterwave_deposits
          SET status='posted',provider_transaction_id=$2,
              verified_at=COALESCE(verified_at,NOW()),
              posted_at=NOW(),updated_at=NOW()
        WHERE transaction_id=$1 AND status='pending'`,
      [deposit.transaction_id,input.providerTransactionId]
    );
    if (updated.rowCount !== 1) throw new Error("FLUTTERWAVE_DEPOSIT_POST_FAILED");

    await client.query(
      `UPDATE public.fp_payment_events SET processing_status='processed'
        WHERE provider='flutterwave' AND provider_event_id=$1`,
      [input.eventId]
    );
    await client.query("COMMIT");
    return {status:"posted",duplicate:duplicateReceipt,walletCredited:true,transactionId:deposit.transaction_id};
  } catch (error) {
    await client.query("ROLLBACK").catch(()=>undefined);
    throw error;
  } finally {
    client.release();
  }
}
