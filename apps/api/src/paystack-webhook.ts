import { processPaystackDedicatedAccountWebhook } from "./paystack-dedicated-accounts.js";
import { getPaystackBankRuntime } from "./paystack-mode.js";
import { processPaystackTransferWebhook } from "./paystack-bank-transfers.js";
import { settleVerifiedPaystackDvaCharge } from "./paystack-dva-settlement.js";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";

type Options = { pool: Pool | null };
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

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 65_536) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function amountMinor(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const raw = String(value);
  if (!/^\d{1,15}$/.test(raw)) return null;
  const number = Number(raw);
  return Number.isSafeInteger(number) && number > 0 ? raw : null;
}

function providerId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^\d{1,30}$/.test(value)) return value;
  return null;
}

function validLegacySignature(raw: Buffer, supplied: unknown, secret: string): boolean {
  if (typeof supplied !== "string" || !/^[0-9a-f]{128}$/.test(supplied)) return false;
  const expected = createHmac("sha512", secret).update(raw).digest();
  const received = Buffer.from(supplied, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function validPaystackSignature(
  raw: Buffer,
  supplied: unknown,
  webhookSecret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  if (typeof supplied !== "string" || !supplied || !webhookSecret.startsWith("whsec_")) return false;
  let timestamp: number | null = null;
  const signatures: Array<{ keyId: string; hex: string }> = [];
  for (const part of supplied.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") {
      if (timestamp !== null || !/^\d{1,12}$/.test(value)) return false;
      timestamp = Number(value);
    } else if (key === "v1") {
      const colon = value.indexOf(":");
      if (colon < 1) continue;
      signatures.push({ keyId: value.slice(0, colon), hex: value.slice(colon + 1) });
    }
  }
  if (timestamp === null || !Number.isSafeInteger(timestamp) ||
      Math.abs(nowSeconds - timestamp) > 300 || signatures.length === 0) return false;
  const expected = createHmac("sha512", webhookSecret)
    .update(String(timestamp) + ".")
    .update(raw)
    .digest();
  for (const signature of signatures) {
    if (!/^whk_[A-Za-z0-9_-]{1,120}$/.test(signature.keyId) ||
        !/^[0-9a-f]{128}$/.test(signature.hex)) continue;
    const received = Buffer.from(signature.hex, "hex");
    if (received.length === expected.length && timingSafeEqual(received, expected)) return true;
  }
  return false;
}

function validSignature(
  raw: Buffer,
  paystackSignature: unknown,
  legacySignature: unknown,
  apiSecret: string,
  webhookSecret: string
): boolean {
  // When the new header is present it is authoritative: a malformed, stale or
  // invalid signature must not be rescued by a valid legacy header.
  if (typeof paystackSignature === "string" && paystackSignature.trim()) {
    return validPaystackSignature(raw, paystackSignature, webhookSecret);
  }
  return validLegacySignature(raw, legacySignature, apiSecret);
}

function balancedDepositLedger(
  rows: LedgerGroup[],
  customerAccountId: string,
  clearingAccountId: string,
  amount: string
): boolean {
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

export function createPaystackWebhookHandler({ pool }: Options) {
  return async function handlePaystackWebhook(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
    if (req.method !== "POST" || pathname !== "/webhooks/paystack") return false;

    const paystackRuntime = getPaystackBankRuntime();
    const secret = paystackRuntime?.secretKey ?? "";
    const environment = paystackRuntime?.environment ?? null;
    if (!paystackRuntime || !environment) {
      send(res, 503, { error: "PAYSTACK_CONFIGURATION_REQUIRED" });
      return true;
    }
    if (!pool) {
      send(res, 503, { error: "WEBHOOK_DATABASE_UNAVAILABLE" });
      return true;
    }

    let raw: Buffer;
    try {
      raw = await readRaw(req);
    } catch {
      send(res, 413, { error: "PAYLOAD_TOO_LARGE" });
      return true;
    }
    const webhookSecret = process.env.PAYSTACK_WEBHOOK_SECRET?.trim() ?? "";
    if (!validSignature(
      raw,
      req.headers["paystack-signature"],
      req.headers["x-paystack-signature"],
      secret,
      webhookSecret
    )) {
      send(res, 401, { error: "INVALID_WEBHOOK_SIGNATURE" });
      return true;
    }

    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid payload");
      event = parsed as Record<string, unknown>;
    } catch {
      send(res, 400, { error: "INVALID_JSON" });
      return true;
    }
    if (["transfer.success", "transfer.failed", "transfer.reversed"].includes(String(event.event))) {
      const result = await processPaystackTransferWebhook(pool, secret, event);
      send(res, result.status, result.body);
      return true;
    }
    if ([
      "dedicatedaccount.assign.success", "dedicatedaccount.assign.failed",
      "customeridentification.success", "customeridentification.failed", "assigndedicatedaccount.failed"
    ].includes(String(event.event))) {
      try {
        const handled = await processPaystackDedicatedAccountWebhook(pool, event);
        send(res, 200, { received: true, processed: handled });
      } catch (error) {
        console.error("FlowPay Paystack dedicated-account webhook failed:", error instanceof Error ? error.message : "database error");
        send(res, 503, { error: "DEDICATED_ACCOUNT_WEBHOOK_RECONCILIATION_UNAVAILABLE" });
      }
      return true;
    }
    if (event.event !== "charge.success") {
      send(res, 200, { received: true, ignored: true });
      return true;
    }
    // A successful charge already accepted by Paystack must be reconciled even
    // after the merchant disables new deposits. Initiation remains gated in
    // paystack-checkout.ts; disabling it must never strand an in-flight deposit.
    const data = event.data && typeof event.data === "object" && !Array.isArray(event.data)
      ? event.data as Record<string, unknown> : {};
    const reference = typeof data.reference === "string" ? data.reference.trim() : "";
    const eventAmount = amountMinor(data.amount);
    const eventProviderId = providerId(data.id);
    if (!reference || !eventAmount || !eventProviderId || String(data.status ?? "").toLowerCase() !== "success" || data.currency !== "NGN") {
      send(res, 202, { received: true, processed: false, reason: "INVALID_PROVIDER_EVENT" });
      return true;
    }

    let verifyResponse: Response;
    let verifyPayload: unknown;
    try {
      verifyResponse = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
        signal: AbortSignal.timeout(12_000)
      });
      verifyPayload = await verifyResponse.json().catch(() => null);
    } catch (error) {
      console.error("FlowPay Paystack verification request failed:", error instanceof Error ? error.message : "network error");
      send(res, 503, { error: "PROVIDER_VERIFICATION_UNAVAILABLE" });
      return true;
    }

    const body = verifyPayload && typeof verifyPayload === "object" && !Array.isArray(verifyPayload)
      ? verifyPayload as Record<string, unknown> : {};
    const verified = body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? body.data as Record<string, unknown> : {};
    const verifiedAmount = amountMinor(verified.amount);
    const verifiedProviderId = providerId(verified.id);
    if (!verifyResponse.ok || body.status !== true || verified.status !== "success" || verified.domain !== environment) {
      send(res, 202, { received: true, processed: false, reason: "PROVIDER_TRANSACTION_NOT_VERIFIED" });
      return true;
    }
    if (
      !verifiedProviderId || verifiedProviderId !== eventProviderId ||
      verified.reference !== reference || verifiedAmount !== eventAmount ||
      verified.currency !== "NGN"
    ) {
      send(res, 202, { received: true, processed: false, reason: "PROVIDER_EVENT_MISMATCH" });
      return true;
    }

    const eventDigest = createHash("sha256").update(raw).digest("hex");
    if (verified.channel === "dedicated_nuban") {
      const settlement = await settleVerifiedPaystackDvaCharge(pool, environment, verified, eventDigest);
      send(res, settlement.status, settlement.body);
      return true;
    }

    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch {
      send(res, 503, { error: "WEBHOOK_DATABASE_UNAVAILABLE" });
      return true;
    }
    try {
      await client.query("BEGIN");
      const result = await client.query<Deposit>(
        `SELECT transaction_id, user_id, account_id, reference, provider_transaction_id,
                amount_minor::text AS amount_minor, currency, status
           FROM public.fp_paystack_deposits
          WHERE reference = $1
          FOR UPDATE`,
        [reference]
      );
      if (result.rowCount !== 1 || !result.rows[0]) {
        await client.query("ROLLBACK");
        send(res, 202, { received: true, processed: false, reason: "FLOWPAY_DEPOSIT_REFERENCE_NOT_FOUND" });
        return true;
      }
      const deposit = result.rows[0];
      if (
        deposit.currency.trim() !== "NGN" ||
        deposit.amount_minor !== verifiedAmount ||
        (deposit.provider_transaction_id && deposit.provider_transaction_id !== verifiedProviderId) ||
        deposit.status === "failed"
      ) {
        await client.query("ROLLBACK");
        send(res, 202, { received: true, processed: false, reason: "FLOWPAY_DEPOSIT_MISMATCH" });
        return true;
      }

      const inserted = await client.query(
        `INSERT INTO public.fp_payment_events
           (provider, provider_event_id, event_type, transaction_id, payload_sha256, processing_status)
         VALUES ('paystack', $1, 'charge.success', $2, $3, 'pending')
         ON CONFLICT (provider, provider_event_id) DO NOTHING
         RETURNING provider_event_id`,
        [reference, deposit.transaction_id, eventDigest]
      );
      const isDuplicateReceipt = inserted.rowCount === 0;
      if (isDuplicateReceipt) {
        const receipt = await client.query<{ transaction_id: string; payload_sha256: string | null }>(
          `SELECT transaction_id::text, payload_sha256
             FROM public.fp_payment_events
            WHERE provider = 'paystack' AND provider_event_id = $1
            FOR UPDATE`,
          [reference]
        );
        const savedHash = receipt.rows[0]?.payload_sha256?.trim() ?? "";
        if (
          receipt.rowCount !== 1 ||
          receipt.rows[0]?.transaction_id !== deposit.transaction_id ||
          (savedHash && savedHash !== eventDigest)
        ) {
          await client.query("ROLLBACK");
          send(res, 202, { received: true, processed: false, reason: "DUPLICATE_EVENT_MISMATCH" });
          return true;
        }
      }

      const transaction = await client.query<{ status: string }>(
        "SELECT status FROM public.fp_ledger_transactions WHERE id = $1 FOR UPDATE",
        [deposit.transaction_id]
      );
      if (transaction.rowCount !== 1) {
        await client.query("ROLLBACK");
        send(res, 503, { error: "FLOWPAY_LEDGER_TRANSACTION_NOT_FOUND" });
        return true;
      }

      const clearing = await client.query<{ id: string }>(
        `SELECT id FROM public.fp_accounts
          WHERE account_type = 'system' AND currency = 'NGN'
            AND system_account_role = 'paystack_ngn_clearing' AND status = 'active'
          FOR UPDATE`
      );
      if (clearing.rowCount !== 1 || !clearing.rows[0]) {
        await client.query("ROLLBACK");
        send(res, 503, { error: "PAYSTACK_CLEARING_ACCOUNT_NOT_CONFIGURED" });
        return true;
      }
      const clearingAccountId = clearing.rows[0].id;

      if (transaction.rows[0].status === "posted") {
        const ledger = await client.query<LedgerGroup>(
          `SELECT account_id::text AS account_id, SUM(amount_minor)::text AS amount_minor,
                  COUNT(*)::int AS entry_count
             FROM public.fp_ledger_entries
            WHERE transaction_id = $1
            GROUP BY account_id`,
          [deposit.transaction_id]
        );
        if (!balancedDepositLedger(ledger.rows, deposit.account_id, clearingAccountId, verifiedAmount)) {
          await client.query("ROLLBACK");
          send(res, 503, { error: "POSTED_LEDGER_REQUIRES_RECONCILIATION" });
          return true;
        }
        await client.query(
          `UPDATE public.fp_paystack_deposits
              SET status = 'posted', provider_transaction_id = $2,
                  verified_at = COALESCE(verified_at, NOW())
            WHERE transaction_id = $1`,
          [deposit.transaction_id, verifiedProviderId]
        );
        await client.query(
          "UPDATE public.fp_payment_events SET processing_status = 'processed' WHERE provider = 'paystack' AND provider_event_id = $1",
          [reference]
        );
        await client.query("COMMIT");
        send(res, 200, {
          received: true, processed: true, duplicate: isDuplicateReceipt,
          providerVerified: true, transactionId: deposit.transaction_id,
          status: "posted", walletCredited: true
        });
        return true;
      }

      if (transaction.rows[0].status !== "pending" || deposit.status !== "pending") {
        await client.query("ROLLBACK");
        send(res, 202, { received: true, processed: false, reason: "DEPOSIT_NOT_PENDING" });
        return true;
      }

      const customerAccount = await client.query<{ id: string }>(
        `SELECT id FROM public.fp_accounts
          WHERE id = $1 AND user_id = $2 AND account_type = 'customer'
            AND currency = 'NGN' AND status = 'active'
          FOR UPDATE`,
        [deposit.account_id, deposit.user_id]
      );
      if (customerAccount.rowCount !== 1) {
        await client.query("ROLLBACK");
        send(res, 503, { error: "CUSTOMER_WALLET_NOT_ACTIVE" });
        return true;
      }

      const existingEntries = await client.query<{ entry_count: number }>(
        "SELECT COUNT(*)::int AS entry_count FROM public.fp_ledger_entries WHERE transaction_id = $1",
        [deposit.transaction_id]
      );
      if (Number(existingEntries.rows[0]?.entry_count ?? 0) !== 0) {
        await client.query("ROLLBACK");
        send(res, 503, { error: "PENDING_LEDGER_ENTRIES_REQUIRE_RECONCILIATION" });
        return true;
      }

      const debitMinor = (-BigInt(verifiedAmount)).toString();
      await client.query(
        `INSERT INTO public.fp_ledger_entries (transaction_id, account_id, amount_minor, currency)
         VALUES ($1, $2, $3, 'NGN'), ($1, $4, $5, 'NGN')`,
        [deposit.transaction_id, deposit.account_id, verifiedAmount, clearingAccountId, debitMinor]
      );
      await client.query(
        `UPDATE public.fp_ledger_transactions
            SET status = 'posted', posted_at = NOW()
          WHERE id = $1 AND status = 'pending'`,
        [deposit.transaction_id]
      );
      await client.query(
        `UPDATE public.fp_paystack_deposits
            SET status = 'posted', provider_transaction_id = $2,
                verified_at = COALESCE(verified_at, NOW())
          WHERE transaction_id = $1 AND status = 'pending'`,
        [deposit.transaction_id, verifiedProviderId]
      );
      await client.query(
        `UPDATE public.fp_payment_events
            SET processing_status = 'processed'
          WHERE provider = 'paystack' AND provider_event_id = $1`,
        [reference]
      );
      await client.query("COMMIT");
      send(res, 200, {
        received: true, processed: true, providerVerified: true,
        transactionId: deposit.transaction_id, status: "posted", walletCredited: true
      });
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("FlowPay Paystack webhook processing failed:", error instanceof Error ? error.message : "database error");
      send(res, 503, { error: "WEBHOOK_PROCESSING_UNAVAILABLE" });
      return true;
    } finally {
      client.release();
    }
  };
}
