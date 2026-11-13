import { createHmac, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { getPaystackRuntime } from "./paystack-mode.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { enqueueTransferNotification, formatNgnMinor } from "./customer-notifications.js";
import { createRemoteJWKSet, jwtVerify } from "jose";

type Options = {
  pool: Pool | null;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
  issuer?: string;
  audience?: string;
};
type Identity = { id: string; email: string | null; name: string | null };
type PayoutStatus = "initiating" | "pending" | "otp" | "unknown" | "success" | "failed" | "reversed" | "blocked" | "abandoned" | "rejected";
type PaystackData = Record<string, unknown>;
type PaystackPayload = { status?: unknown; message?: unknown; data?: unknown };

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function isJwtError(error: unknown) {
  return error instanceof Error && [
    "JWTExpired", "JWSSignatureVerificationFailed", "JWTClaimValidationFailed",
    "JWSInvalid", "JWTInvalid"
  ].includes(error.name);
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(raw, "utf8") > 8_192) throw new Error("PAYLOAD_TOO_LARGE");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw || "{}"); } catch { throw new Error("INVALID_JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_PAYLOAD");
  return parsed as Record<string, unknown>;
}
function validUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function validAmount(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) return false;
  const amount = BigInt(value);
  return amount > 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER);
}
export function isPaystackBankPayoutsEnabled(environment: "test" | "live"): boolean {
  if (environment === "test") {
    return process.env.FLOWPAY_RUNTIME_ENV === "development" &&
      process.env.NODE_ENV !== "production" &&
      process.env.PAYSTACK_TRANSFERS_ENABLED === "true";
  }
  return process.env.NODE_ENV === "production" &&
    process.env.PAYSTACK_LIVE_TRANSFERS_ENABLED === "true";
}
function beneficiaryFingerprint(secret: string, accountNumber: string): string {
  return createHmac("sha256", secret).update(accountNumber, "utf8").digest("hex");
}
function safeStatus(value: unknown): PayoutStatus {
  const status = typeof value === "string" ? value.toLowerCase() : "";
  // Paystack's "received" state is still awaiting merchant approval.
  if (status === "received") return "pending";
  return ["initiating", "pending", "otp", "unknown", "success", "failed", "reversed", "blocked", "abandoned", "rejected"].includes(status)
    ? status as PayoutStatus : "unknown";
}
async function paystackRequest(secret: string, path: string, method: "GET" | "POST", payload?: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: PaystackPayload }> {
  const response = await fetch("https://api.paystack.co" + path, {
    method,
    headers: {
      Authorization: "Bearer " + secret,
      Accept: "application/json",
      ...(payload ? { "Content-Type": "application/json" } : {})
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(12_000)
  });
  const body = await response.json().catch(() => null);
  return { ok: response.ok && record(body).status === true, status: response.status, body: record(body) as PaystackPayload };
}
async function derivePin(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(pin, salt, 64, (error, derived) => {
      if (error) reject(error);
      else resolve(derived as Buffer);
    });
  });
}
async function verifyTransactionPin(client: PoolClient, userId: string, suppliedPin: string): Promise<"verified" | "missing" | "locked" | "invalid"> {
  const result = await client.query<{
    pin_salt: Buffer; pin_hash: Buffer; failed_attempts: number; locked_until: Date | null;
  }>(
    `SELECT pin_salt, pin_hash, failed_attempts, locked_until
       FROM public.fp_transaction_pins
      WHERE user_id = $1
      FOR UPDATE`,
    [userId]
  );
  if (result.rowCount !== 1) return "missing";
  const saved = result.rows[0];
  if (saved.locked_until && new Date(saved.locked_until).getTime() > Date.now()) return "locked";
  const derived = await derivePin(suppliedPin, saved.pin_salt);
  if (derived.length !== saved.pin_hash.length || !timingSafeEqual(derived, saved.pin_hash)) {
    const attempts = Math.min(5, Number(saved.failed_attempts) + 1);
    await client.query(
      `UPDATE public.fp_transaction_pins
          SET failed_attempts = $2,
              locked_until = CASE WHEN $2 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END,
              updated_at = NOW()
        WHERE user_id = $1`,
      [userId, attempts]
    );
    return attempts >= 5 ? "locked" : "invalid";
  }
  await client.query(
    `UPDATE public.fp_transaction_pins
        SET failed_attempts = 0, locked_until = NULL, updated_at = NOW()
      WHERE user_id = $1`,
    [userId]
  );
  return "verified";
}
async function authenticate(pool: Pool, jwks: ReturnType<typeof createRemoteJWKSet>, issuer: string, audience: string, req: IncomingMessage): Promise<Identity | null> {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
  if (!bearer) return null;
  const { payload } = await jwtVerify(bearer[1], jwks, { algorithms: ["EdDSA"], issuer, audience });
  if (typeof payload.sub !== "string" || !payload.sub) return null;
  const result = await pool.query<Identity>(
    `SELECT app_user.id, auth_user.email, auth_user.name
       FROM neon_auth."user" AS auth_user
       JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
      WHERE auth_user.id::text = $1
        AND auth_user."emailVerified" = true
        AND app_user.status = 'active'
        AND app_user.role = 'customer'
      LIMIT 1`,
    [payload.sub]
  );
  return result.rowCount === 1 ? result.rows[0] : null;
}
async function resolveRecipient(secret: string, accountNumber: string, bankCode: string, environment: "test" | "live"): Promise<{ recipientCode: string; accountName: string; bankName: string }> {
  const resolveUrl = new URL("https://api.paystack.co/bank/resolve");
  resolveUrl.searchParams.set("account_number", accountNumber);
  resolveUrl.searchParams.set("bank_code", bankCode);
  const resolved = await paystackRequest(secret, resolveUrl.pathname + resolveUrl.search, "GET");
  const resolvedData = record(resolved.body.data);
  const name = typeof resolvedData.account_name === "string" ? resolvedData.account_name.trim() : "";
  if (!resolved.ok || resolvedData.account_number !== accountNumber || !name || name.length > 160) {
    throw new Error("BANK_ACCOUNT_NOT_VERIFIED");
  }

  const recipient = await paystackRequest(secret, "/transferrecipient", "POST", {
    type: "nuban",
    name,
    account_number: accountNumber,
    bank_code: bankCode,
    currency: "NGN",
    description: "FlowPay customer bank payout"
  });
  const data = record(recipient.body.data);
  const details = record(data.details);
  const recipientCode = typeof data.recipient_code === "string" ? data.recipient_code.trim() : "";
  const bankName = typeof details.bank_name === "string" ? details.bank_name.trim() : "";
  if (!recipient.ok || data.domain !== environment || data.active !== true ||
      data.type !== "nuban" || data.currency !== "NGN" ||
      !/^RCP_[A-Za-z0-9]+$/.test(recipientCode) || !bankName ||
      (typeof details.account_number === "string" && details.account_number !== accountNumber) ||
      (typeof details.bank_code === "string" && details.bank_code !== bankCode)) {
    throw new Error("PAYSTACK_RECIPIENT_CREATION_FAILED");
  }
  return { recipientCode, accountName: name, bankName };
}

type StoredPayout = {
  transaction_id: string;
  user_id: string;
  account_id: string;
  reference: string;
  recipient_code: string;
  transfer_code: string | null;
  provider_transfer_id: string | null;
  amount_minor: string;
  currency: string;
  bank_code: string;
  bank_name: string;
  account_name: string;
  account_number_last4: string;
  account_fingerprint: string;
  status: PayoutStatus;
  provider_status: string | null;
};
async function loadPayout(pool: Pool, reference: string, userId?: string): Promise<StoredPayout | null> {
  const result = await pool.query<StoredPayout>(
    `SELECT transaction_id, user_id, account_id, reference, recipient_code,
            transfer_code, provider_transfer_id, amount_minor::text AS amount_minor,
            currency, bank_code, bank_name, account_name, account_number_last4, account_fingerprint,
            status, provider_status
       FROM public.fp_paystack_bank_transfers
      WHERE reference = $1 AND ($2::uuid IS NULL OR user_id = $2)
      LIMIT 1`,
    [reference, userId ?? null]
  );
  return result.rowCount === 1 ? result.rows[0] : null;
}
async function applyVerifiedStatus(pool: Pool, secret: string, reference: string, verified: PaystackData, environment: "test" | "live"): Promise<{ status: PayoutStatus; duplicate: boolean }> {
  const verifiedReference = typeof verified.reference === "string" ? verified.reference : "";
  const verifiedAmount = typeof verified.amount === "number" || typeof verified.amount === "string" ? String(verified.amount) : "";
  const verifiedCurrency = typeof verified.currency === "string" ? verified.currency : "";
  const verifiedDomain = typeof verified.domain === "string" ? verified.domain : "";
  const providerStatus = safeStatus(verified.status);
  const providerTransferId = typeof verified.id === "number" || typeof verified.id === "string" ? String(verified.id) : null;
  const transferCode = typeof verified.transfer_code === "string" ? verified.transfer_code : null;
  if (verifiedReference !== reference || !/^\d{1,15}$/.test(verifiedAmount) ||
      !Number.isSafeInteger(Number(verifiedAmount)) || verifiedCurrency !== "NGN" || verifiedDomain !== environment) {
    throw new Error("PAYSTACK_TRANSFER_VERIFICATION_MISMATCH");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<StoredPayout>(
      `SELECT transaction_id, user_id, account_id, reference, recipient_code,
              transfer_code, provider_transfer_id, amount_minor::text AS amount_minor,
              currency, bank_code, bank_name, account_name, account_number_last4, account_fingerprint,
              status, provider_status
         FROM public.fp_paystack_bank_transfers
        WHERE reference = $1
        FOR UPDATE`,
      [reference]
    );
    if (locked.rowCount !== 1) {
      await client.query("ROLLBACK");
      throw new Error("FLOWPAY_BANK_TRANSFER_NOT_FOUND");
    }
    const payout = locked.rows[0];
    const verifiedRecipient = record(verified.recipient);
    const verifiedRecipientDetails = record(verifiedRecipient.details);
    const verifiedRecipientCode = typeof verifiedRecipient.recipient_code === "string"
      ? verifiedRecipient.recipient_code : "";
    const verifiedAccountNumber = typeof verifiedRecipientDetails.account_number === "string"
      ? verifiedRecipientDetails.account_number : "";
    const verifiedBankCode = typeof verifiedRecipientDetails.bank_code === "string"
      ? verifiedRecipientDetails.bank_code : "";
    if (payout.amount_minor !== verifiedAmount || payout.currency.trim() !== verifiedCurrency) {
      await client.query("ROLLBACK");
      throw new Error("PAYSTACK_TRANSFER_AMOUNT_MISMATCH");
    }
    if (verifiedRecipientCode !== payout.recipient_code ||
        !/^[0-9]{10}$/.test(verifiedAccountNumber) ||
        verifiedBankCode !== payout.bank_code ||
        beneficiaryFingerprint(secret, verifiedAccountNumber) !== payout.account_fingerprint) {
      await client.query("ROLLBACK");
      throw new Error("PAYSTACK_TRANSFER_RECIPIENT_MISMATCH");
    }

    const tx = await client.query<{ status: string }>(
      "SELECT status FROM public.fp_ledger_transactions WHERE id = $1 FOR UPDATE",
      [payout.transaction_id]
    );
    if (tx.rowCount !== 1) throw new Error("FLOWPAY_LEDGER_TRANSACTION_NOT_FOUND");

    if (providerStatus === "success") {
      if (tx.rows[0].status === "posted" && payout.status === "success") {
        await client.query(
          `UPDATE public.fp_paystack_bank_transfers
              SET provider_status = 'success',
                  provider_transfer_id = COALESCE($2, provider_transfer_id),
                  transfer_code = COALESCE($3, transfer_code),
                  verified_at = COALESCE(verified_at, NOW()),
                  updated_at = NOW()
            WHERE transaction_id = $1`,
          [payout.transaction_id, providerTransferId, transferCode]
        );
        await client.query("COMMIT");
        return { status: "success", duplicate: true };
      }
      if (tx.rows[0].status !== "pending") throw new Error("PAYOUT_LEDGER_STATE_REQUIRES_RECONCILIATION");
      const existing = await client.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM public.fp_ledger_entries WHERE transaction_id = $1",
        [payout.transaction_id]
      );
      if (Number(existing.rows[0]?.count ?? 0) !== 0) throw new Error("PAYOUT_LEDGER_ENTRIES_REQUIRE_RECONCILIATION");
      const clearing = await client.query<{ id: string }>(
        `SELECT id FROM public.fp_accounts
          WHERE account_type = 'system' AND currency = 'NGN'
            AND system_account_role = 'paystack_ngn_clearing' AND status = 'active'
          FOR UPDATE`
      );
      if (clearing.rowCount !== 1) throw new Error("PAYSTACK_CLEARING_ACCOUNT_NOT_CONFIGURED");
      await client.query(
        `INSERT INTO public.fp_ledger_entries (transaction_id, account_id, amount_minor, currency)
         VALUES ($1, $2, $3, 'NGN'), ($1, $4, $5, 'NGN')`,
        [payout.transaction_id, payout.account_id, (-BigInt(payout.amount_minor)).toString(), clearing.rows[0].id, payout.amount_minor]
      );
      const posted = await client.query(
        `UPDATE public.fp_ledger_transactions
            SET status = 'posted', posted_at = NOW()
          WHERE id = $1 AND status = 'pending'`,
        [payout.transaction_id]
      );
      if (posted.rowCount !== 1) throw new Error("PAYOUT_LEDGER_POST_FAILED");
      await client.query(
        `UPDATE public.fp_paystack_bank_transfers
            SET status = 'success', provider_status = 'success',
                provider_transfer_id = COALESCE($2, provider_transfer_id),
                transfer_code = COALESCE($3, transfer_code),
                status_note = NULL, verified_at = NOW(), updated_at = NOW()
          WHERE transaction_id = $1`,
        [payout.transaction_id, providerTransferId, transferCode]
      );
      await enqueueTransferNotification(client, {
        userId: payout.user_id,
        eventKey: `paystack-bank:${payout.transaction_id}:success`,
        transactionId: payout.transaction_id,
        reference: payout.reference,
        transferType: "bank",
        direction: "sent",
        status: "success",
        amountMinor: payout.amount_minor,
        title: "Bank transfer successful",
        message: `You sent ${formatNgnMinor(payout.amount_minor)} to ${payout.bank_name} (account ending ${payout.account_number_last4.trim()}). Paystack confirmed the transfer.`
      });
      await client.query("COMMIT");
      return { status: "success", duplicate: false };
    }

    if (providerStatus === "reversed") {
      if (tx.rows[0].status !== "posted") {
        await client.query(
          `UPDATE public.fp_paystack_bank_transfers
              SET status = 'unknown', provider_status = 'reversed',
                  status_note = 'Provider reports reversal before FlowPay has a posted payout; manual reconciliation required.',
                  updated_at = NOW()
            WHERE transaction_id = $1`,
          [payout.transaction_id]
        );
        await client.query("COMMIT");
        return { status: "unknown", duplicate: false };
      }
      const reversalKey = `paystack-bank-reversal:${payout.transaction_id}`;
      const priorReversal = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM public.fp_ledger_transactions
          WHERE idempotency_key = $1 FOR UPDATE`,
        [reversalKey]
      );
      let reversalId: string;
      const duplicateReversal = priorReversal.rowCount === 1;
      if (duplicateReversal) {
        reversalId = priorReversal.rows[0].id;
      } else {
        const createdReversal = await client.query<{ id: string }>(
          `INSERT INTO public.fp_ledger_transactions
             (idempotency_key, transaction_type, status, description)
           VALUES ($1, 'paystack_bank_transfer_reversal', 'pending', 'Paystack NGN bank payout reversal')
           RETURNING id`,
          [reversalKey]
        );
        reversalId = createdReversal.rows[0].id;
      }

      const clearing = await client.query<{ id: string }>(
        `SELECT id FROM public.fp_accounts
          WHERE account_type = 'system' AND currency = 'NGN'
            AND system_account_role = 'paystack_ngn_clearing' AND status = 'active'
          FOR UPDATE`
      );
      if (clearing.rowCount !== 1) throw new Error("PAYSTACK_CLEARING_ACCOUNT_NOT_CONFIGURED");
      const reversalEntries = await client.query<{
        account_id: string; amount_minor: string; entry_count: number;
      }>(
        `SELECT account_id::text AS account_id, SUM(amount_minor)::text AS amount_minor,
                COUNT(*)::int AS entry_count
           FROM public.fp_ledger_entries WHERE transaction_id = $1
          GROUP BY account_id`,
        [reversalId]
      );
      if (reversalEntries.rowCount === 0) {
        if (priorReversal.rowCount === 1 && priorReversal.rows[0].status !== "pending") {
          throw new Error("PAYOUT_REVERSAL_ENTRIES_MISSING");
        }
        await client.query(
          `INSERT INTO public.fp_ledger_entries (transaction_id, account_id, amount_minor, currency)
           VALUES ($1, $2, $3, 'NGN'), ($1, $4, $5, 'NGN')`,
          [reversalId, payout.account_id, payout.amount_minor, clearing.rows[0].id, (-BigInt(payout.amount_minor)).toString()]
        );
      } else {
        const customerEntry = reversalEntries.rows.find(row => row.account_id === payout.account_id);
        const clearingEntry = reversalEntries.rows.find(row => row.account_id === clearing.rows[0].id);
        if (reversalEntries.rowCount !== 2 || !customerEntry || !clearingEntry ||
            customerEntry.entry_count !== 1 || clearingEntry.entry_count !== 1 ||
            customerEntry.amount_minor !== payout.amount_minor ||
            clearingEntry.amount_minor !== (-BigInt(payout.amount_minor)).toString()) {
          throw new Error("PAYOUT_REVERSAL_LEDGER_REQUIRES_RECONCILIATION");
        }
      }
      if (priorReversal.rowCount === 0 || priorReversal.rows[0].status === "pending") {
        const postedReversal = await client.query(
          `UPDATE public.fp_ledger_transactions
              SET status = 'posted', posted_at = NOW()
            WHERE id = $1 AND status = 'pending'`,
          [reversalId]
        );
        if (postedReversal.rowCount !== 1) throw new Error("PAYOUT_REVERSAL_POST_FAILED");
      } else if (priorReversal.rows[0].status !== "posted") {
        throw new Error("PAYOUT_REVERSAL_STATE_REQUIRES_RECONCILIATION");
      }
      await client.query(
        `UPDATE public.fp_paystack_bank_transfers
            SET status = 'reversed', provider_status = 'reversed',
                provider_transfer_id = COALESCE($2, provider_transfer_id),
                transfer_code = COALESCE($3, transfer_code),
                status_note = 'Paystack confirmed the payout reversal; customer wallet was credited back.',
                verified_at = NOW(), updated_at = NOW()
          WHERE transaction_id = $1`,
        [payout.transaction_id, providerTransferId, transferCode]
      );
      await enqueueTransferNotification(client, {
        userId: payout.user_id,
        eventKey: `paystack-bank:${payout.transaction_id}:reversed`,
        transactionId: payout.transaction_id,
        reference: payout.reference,
        transferType: "bank",
        direction: "sent",
        status: "reversed",
        amountMinor: payout.amount_minor,
        title: "Bank transfer reversed",
        message: `Your ${formatNgnMinor(payout.amount_minor)} transfer to ${payout.bank_name} (account ending ${payout.account_number_last4.trim()}) was reversed by Paystack and returned to your FlowPay wallet.`
      });
      await client.query("COMMIT");
      return { status: "reversed", duplicate: duplicateReversal };
    }

    if (["failed", "blocked", "abandoned", "rejected"].includes(providerStatus)) {
      if (tx.rows[0].status === "pending") {
        const failed = await client.query(
          "UPDATE public.fp_ledger_transactions SET status = 'failed' WHERE id = $1 AND status = 'pending'",
          [payout.transaction_id]
        );
        if (failed.rowCount !== 1) throw new Error("PAYOUT_LEDGER_FAIL_POST_FAILED");
      } else if (tx.rows[0].status !== "failed") {
        throw new Error("PAYOUT_FAILURE_AFTER_POST_REQUIRES_RECONCILIATION");
      }
      await client.query(
        `UPDATE public.fp_paystack_bank_transfers
            SET status = $2, provider_status = $2,
                provider_transfer_id = COALESCE($3, provider_transfer_id),
                transfer_code = COALESCE($4, transfer_code),
                status_note = 'Paystack reported a final unsuccessful transfer; no customer wallet debit was posted.',
                verified_at = NOW(), updated_at = NOW()
          WHERE transaction_id = $1`,
        [payout.transaction_id, providerStatus, providerTransferId, transferCode]
      );
      await enqueueTransferNotification(client, {
        userId: payout.user_id,
        eventKey: `paystack-bank:${payout.transaction_id}:failed`,
        transactionId: payout.transaction_id,
        reference: payout.reference,
        transferType: "bank",
        direction: "sent",
        status: "failed",
        amountMinor: payout.amount_minor,
        title: "Bank transfer failed",
        message: `Your ${formatNgnMinor(payout.amount_minor)} transfer to ${payout.bank_name} (account ending ${payout.account_number_last4.trim()}) was not completed by Paystack. No wallet debit was posted.`
      });
      await client.query("COMMIT");
      return { status: providerStatus, duplicate: tx.rows[0].status === "failed" };
    }

    const nextStatus = providerStatus === "otp" ? "otp" : "pending";
    await client.query(
      `UPDATE public.fp_paystack_bank_transfers
          SET status = $2, provider_status = $3,
              provider_transfer_id = COALESCE($4, provider_transfer_id),
              transfer_code = COALESCE($5, transfer_code),
              status_note = CASE WHEN $2 = 'otp'
                THEN 'Paystack requires an authorized business owner to approve this transfer.'
                ELSE 'Paystack has not reported a final transfer status.'
              END,
              updated_at = NOW()
        WHERE transaction_id = $1`,
      [payout.transaction_id, nextStatus, providerStatus, providerTransferId, transferCode]
    );
    await client.query("COMMIT");
    return { status: nextStatus, duplicate: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function processPaystackTransferWebhook(pool: Pool, secret: string, event: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const runtime = getPaystackRuntime();
  if (!runtime || !isPaystackBankPayoutsEnabled(runtime.environment)) {
    return { status: 200, body: { received: true, ignored: true, reason: "BANK_PAYOUT_RUNTIME_DISABLED" } };
  }
  const eventType = typeof event.event === "string" ? event.event : "";
  if (!["transfer.success", "transfer.failed", "transfer.reversed"].includes(eventType)) {
    return { status: 200, body: { received: true, ignored: true } };
  }
  const data = record(event.data);
  const reference = typeof data.reference === "string" ? data.reference.trim() : "";
  if (!reference) return { status: 202, body: { received: true, processed: false, reason: "TRANSFER_REFERENCE_MISSING" } };
  try {
    const verified = await paystackRequest(secret, "/transfer/verify/" + encodeURIComponent(reference), "GET");
    const verifiedData = record(verified.body.data);
    if (!verified.ok || verifiedData.reference !== reference) {
      return { status: 503, body: { error: "PAYSTACK_TRANSFER_VERIFICATION_UNAVAILABLE" } };
    }
    const result = await applyVerifiedStatus(pool, secret, reference, verifiedData, runtime.environment);
    return { status: 200, body: { received: true, processed: true, status: result.status, duplicate: result.duplicate } };
  } catch (error) {
    console.error("FlowPay Paystack transfer webhook reconciliation failed:", error instanceof Error ? error.message : "database error");
    return { status: 503, body: { error: "PAYSTACK_TRANSFER_RECONCILIATION_UNAVAILABLE" } };
  }
}

export function createPaystackBankTransfersHandler(options: Options) {
  const { pool, jwks, issuer, audience } = options;
  return async function handlePaystackBankTransfers(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const isSubmit = req.method === "POST" && path === "/customer/transfers/bank";
    const isStatus = req.method === "GET" && path === "/customer/transfers/bank/status";
    if (!isSubmit && !isStatus) return false;
    if (!pool || !jwks || !issuer || !audience) {
      send(res, 503, { error: "BANK_TRANSFER_SERVICE_NOT_CONFIGURED" }); return true;
    }
    const runtime = getPaystackRuntime();
    const secret = runtime?.secretKey ?? "";
    const environment = runtime?.environment ?? null;
    if (!runtime || !environment || (isSubmit && !isPaystackBankPayoutsEnabled(environment))) {
      send(res, 503, {
        error: "PAYSTACK_BANK_PAYOUTS_NOT_ENABLED",
        environment,
        livePayoutsEnabled: environment === "live" && process.env.PAYSTACK_LIVE_TRANSFERS_ENABLED === "true",
        requiredConfiguration: environment === "live"
          ? ["PAYSTACK_ENVIRONMENT=live", "PAYSTACK_SECRET_KEY=sk_live_…", "PAYSTACK_LIVE_PAYMENTS_ENABLED=true", "PAYSTACK_LIVE_TRANSFERS_ENABLED=true"]
          : ["PAYSTACK_ENVIRONMENT=test", "PAYSTACK_SECRET_KEY=sk_test_…", "FLOWPAY_RUNTIME_ENV=development", "PAYSTACK_TRANSFERS_ENABLED=true"]
      }); return true;
    }

    let identity: Identity | null;
    try {
      identity = await authenticate(pool, jwks, issuer, audience, req);
      if (!identity) {
        send(res, req.headers.authorization ? 403 : 401, {
          error: req.headers.authorization ? "ACTIVE_VERIFIED_CUSTOMER_REQUIRED" : "AUTHENTICATION_REQUIRED"
        });
        return true;
      }
    } catch (error) {
      if (isJwtError(error)) send(res, 401, { error: "INVALID_SESSION" });
      else {
        console.error("FlowPay bank payout authentication failed:", error instanceof Error ? error.message : "unknown error");
        send(res, 503, { error: "BANK_TRANSFER_AUTH_UNAVAILABLE" });
      }
      return true;
    }

    if (isStatus) {
      const reference = url.searchParams.get("reference")?.trim() ?? "";
      if (!/^flowpay-bnk-[a-f0-9]{32}$/.test(reference)) {
        send(res, 400, { error: "VALID_BANK_TRANSFER_REFERENCE_REQUIRED" }); return true;
      }
      try {
        const saved = await loadPayout(pool, reference, identity.id);
        if (!saved) { send(res, 404, { error: "BANK_TRANSFER_NOT_FOUND" }); return true; }
        if (["success", "failed", "reversed", "blocked", "abandoned", "rejected"].includes(saved.status)) {
          send(res, 200, { reference, status: saved.status, final: true, amountMinor: saved.amount_minor, currency: "NGN" });
          return true;
        }
        const verified = await paystackRequest(secret, "/transfer/verify/" + encodeURIComponent(reference), "GET");
        const data = record(verified.body.data);
        if (!verified.ok || data.reference !== reference) {
          send(res, 202, { reference, status: saved.status, final: false, message: "Paystack has not returned a final status. The amount remains reserved until verification completes." });
          return true;
        }
        const result = await applyVerifiedStatus(pool, secret, reference, data, environment);
        send(res, 200, { reference, status: result.status, final: ["success", "failed", "reversed", "blocked", "abandoned", "rejected"].includes(result.status), amountMinor: saved.amount_minor, currency: "NGN" });
      } catch (error) {
        console.error("FlowPay bank payout status check failed:", error instanceof Error ? error.message : "database error");
        send(res, 503, { error: "BANK_TRANSFER_STATUS_UNAVAILABLE" });
      }
      return true;
    }

    let input: Record<string, unknown>;
    try { input = await readJson(req); }
    catch (error) {
      const message = error instanceof Error ? error.message : "INVALID_PAYLOAD";
      send(res, message === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: message }); return true;
    }
    if (Object.keys(input).some(key => !["accountNumber", "bankCode", "amountMinor", "idempotencyKey", "transactionPin"].includes(key))) {
      send(res, 400, { error: "UNSUPPORTED_BANK_TRANSFER_FIELD" }); return true;
    }
    const accountNumber = typeof input.accountNumber === "string" ? input.accountNumber.trim() : "";
    const bankCode = typeof input.bankCode === "string" ? input.bankCode.trim() : "";
    if (!/^\d{10}$/.test(accountNumber) || !/^[A-Za-z0-9_-]{2,12}$/.test(bankCode) ||
        !validAmount(input.amountMinor) || !validUuid(input.idempotencyKey) ||
        typeof input.transactionPin !== "string" || !/^\d{6}$/.test(input.transactionPin)) {
      send(res, 400, { error: "INVALID_BANK_TRANSFER_DETAILS" }); return true;
    }

    const dbKey = `paystack-bank-transfer:${identity.id}:${input.idempotencyKey}`;

    // Return an existing request before contacting Paystack again. This makes
    // retries safe when the browser loses the original HTTP response.
    try {
      const prior = await pool.query<StoredPayout>(
        `SELECT transaction_id, user_id, account_id, reference, recipient_code,
                transfer_code, provider_transfer_id, amount_minor::text AS amount_minor,
                currency, bank_code, bank_name, account_name, account_number_last4, account_fingerprint,
                status, provider_status
           FROM public.fp_paystack_bank_transfers
          WHERE idempotency_key = $1
          LIMIT 1`,
        [dbKey]
      );
      if (prior.rowCount === 1) {
        const saved = prior.rows[0];
        const matches = saved.user_id === identity.id &&
          saved.amount_minor === input.amountMinor &&
          saved.bank_code === bankCode &&
          saved.account_number_last4.trim() === accountNumber.slice(-4) &&
          saved.account_fingerprint === beneficiaryFingerprint(secret, accountNumber);
        if (!matches) {
          send(res, 409, { error: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_TRANSFER" }); return true;
        }
        send(res, 200, {
          transactionId: saved.transaction_id, reference: saved.reference,
          status: saved.status, amountMinor: saved.amount_minor, currency: "NGN",
          bankName: saved.bank_name, accountName: saved.account_name,
          accountNumberMasked: "******" + saved.account_number_last4.trim(),
          duplicate: true, final: ["success", "failed", "reversed", "blocked", "abandoned", "rejected"].includes(saved.status)
        });
        return true;
      }
    } catch (error) {
      console.error("FlowPay bank payout idempotency lookup failed:", error instanceof Error ? error.message : "database error");
      send(res, 503, { error: "BANK_TRANSFER_IDEMPOTENCY_UNAVAILABLE" }); return true;
    }

    // Validate the transaction PIN before creating a Paystack beneficiary.
    let pinClient: PoolClient;
    try { pinClient = await pool.connect(); }
    catch { send(res, 503, { error: "BANK_TRANSFER_DATABASE_UNAVAILABLE" }); return true; }
    try {
      await pinClient.query("BEGIN");
      const pinState = await verifyTransactionPin(pinClient, identity.id, input.transactionPin);
      await pinClient.query("COMMIT");
      if (pinState !== "verified") {
        const code = pinState === "missing" ? "TRANSACTION_PIN_SETUP_REQUIRED"
          : pinState === "locked" ? "TRANSACTION_PIN_TEMPORARILY_LOCKED" : "INVALID_TRANSACTION_PIN";
        send(res, pinState === "missing" ? 403 : pinState === "locked" ? 429 : 401, { error: code }); return true;
      }
    } catch (error) {
      await pinClient.query("ROLLBACK").catch(() => undefined);
      console.error("FlowPay bank payout PIN verification failed:", error instanceof Error ? error.message : "database error");
      send(res, 503, { error: "TRANSACTION_PIN_VERIFICATION_UNAVAILABLE" }); return true;
    } finally {
      pinClient.release();
    }

    let recipient: { recipientCode: string; accountName: string; bankName: string };
    try {
      recipient = await resolveRecipient(secret, accountNumber, bankCode, environment);
    } catch (error) {
      const code = error instanceof Error ? error.message : "PAYSTACK_RECIPIENT_CREATION_FAILED";
      const status = code === "BANK_ACCOUNT_NOT_VERIFIED" ? 422 : 503;
      send(res, status, { error: code, message: status === 422 ? "The account name could not be verified by Paystack." : "Paystack could not prepare this beneficiary. No wallet debit was made." });
      return true;
    }

    const reference = "flowpay-bnk-" + randomUUID().replace(/-/g, "");
    let transactionId = "";
    let client: PoolClient;
    try { client = await pool.connect(); }
    catch { send(res, 503, { error: "BANK_TRANSFER_DATABASE_UNAVAILABLE" }); return true; }
    try {
      await client.query("BEGIN");
      const wallets = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM public.fp_accounts
          WHERE user_id = $1 AND account_type = 'customer' AND currency = 'NGN'
          ORDER BY id FOR UPDATE`,
        [identity.id]
      );
      if (wallets.rowCount !== 1 || wallets.rows[0].status !== "active") {
        await client.query("ROLLBACK");
        send(res, 409, { error: "ACTIVE_NGN_WALLET_REQUIRED" }); return true;
      }
      const walletId = wallets.rows[0].id;

      const prior = await client.query<StoredPayout>(
        `SELECT transaction_id, user_id, account_id, reference, recipient_code,
                transfer_code, provider_transfer_id, amount_minor::text AS amount_minor,
                currency, bank_code, bank_name, account_name, account_number_last4, account_fingerprint,
                status, provider_status
           FROM public.fp_paystack_bank_transfers
          WHERE idempotency_key = $1
          FOR UPDATE`,
        [dbKey]
      );
      if (prior.rowCount === 1) {
        const saved = prior.rows[0];
        const matches = saved.user_id === identity.id &&
          saved.amount_minor === input.amountMinor &&
          saved.bank_code === bankCode &&
          saved.account_number_last4.trim() === accountNumber.slice(-4) &&
          saved.account_fingerprint === beneficiaryFingerprint(secret, accountNumber);
        await client.query("COMMIT");
        if (!matches) {
          send(res, 409, { error: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_TRANSFER" }); return true;
        }
        send(res, 200, {
          transactionId: saved.transaction_id, reference: saved.reference,
          status: saved.status, amountMinor: saved.amount_minor, currency: "NGN",
          bankName: saved.bank_name, accountName: saved.account_name,
          accountNumberMasked: "******" + saved.account_number_last4.trim(),
          duplicate: true, final: ["success", "failed", "reversed", "blocked", "abandoned", "rejected"].includes(saved.status)
        });
        return true;
      }

      const clearing = await client.query<{ id: string }>(
        `SELECT id FROM public.fp_accounts
          WHERE account_type = 'system' AND currency = 'NGN'
            AND system_account_role = 'paystack_ngn_clearing' AND status = 'active'
          FOR SHARE`
      );
      if (clearing.rowCount !== 1) {
        await client.query("ROLLBACK");
        send(res, 503, { error: "PAYSTACK_CLEARING_ACCOUNT_NOT_CONFIGURED" }); return true;
      }

      const [postedBalance, heldBalance] = await Promise.all([
        client.query<{ amount_minor: string }>(
          `SELECT COALESCE(SUM(entry.amount_minor), 0)::text AS amount_minor
             FROM public.fp_ledger_entries AS entry
             JOIN public.fp_ledger_transactions AS ledger_tx ON ledger_tx.id = entry.transaction_id
            WHERE entry.account_id = $1 AND entry.currency = 'NGN'
              AND ledger_tx.status = 'posted'`,
          [walletId]
        ),
        client.query<{ amount_minor: string }>(
          `SELECT COALESCE(SUM(reservation.amount_minor), 0)::text AS amount_minor
             FROM (
               SELECT amount_minor FROM public.fp_paystack_bank_transfers
                WHERE account_id = $1 AND status IN ('initiating', 'pending', 'otp', 'unknown')
               UNION ALL
               SELECT amount_minor FROM public.fp_vtpass_bill_payments
                WHERE account_id = $1 AND status IN ('initiating', 'pending', 'unknown')
             ) AS reservation`,
          [walletId]
        )
      ]);
      const available = BigInt(postedBalance.rows[0]?.amount_minor ?? "0") - BigInt(heldBalance.rows[0]?.amount_minor ?? "0");
      const amount = BigInt(input.amountMinor);
      if (available < amount) {
        await client.query("ROLLBACK");
        send(res, 409, { error: "INSUFFICIENT_AVAILABLE_BALANCE", availableMinor: available.toString() }); return true;
      }

      const created = await client.query<{ id: string }>(
        `INSERT INTO public.fp_ledger_transactions
           (idempotency_key, transaction_type, status, description)
         VALUES ($1, 'paystack_bank_transfer', 'pending', 'Paystack NGN test bank payout')
         RETURNING id`,
        [dbKey]
      );
      transactionId = created.rows[0].id;
      const bankName = recipient.bankName;
      await client.query(
        `INSERT INTO public.fp_paystack_bank_transfers
           (transaction_id, user_id, account_id, idempotency_key, reference,
            recipient_code, amount_minor, currency, bank_code, bank_name,
            account_name, account_number_last4, account_fingerprint, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'NGN',$8,$9,$10,$11,$12,'initiating')`,
        [transactionId, identity.id, walletId, dbKey, reference, recipient.recipientCode,
          input.amountMinor, bankCode, bankName, recipient.accountName, accountNumber.slice(-4),
          beneficiaryFingerprint(secret, accountNumber)]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("FlowPay Paystack bank transfer reservation failed:", error instanceof Error ? error.message : "database error");
      send(res, 503, { error: "BANK_TRANSFER_RESERVATION_UNAVAILABLE" }); return true;
    } finally {
      client.release();
    }

    try {
      const initiated = await paystackRequest(secret, "/transfer", "POST", {
        source: "balance",
        amount: Number(input.amountMinor),
        recipient: recipient.recipientCode,
        reference,
        reason: "FlowPay customer bank transfer",
        currency: "NGN"
      });
      const data = record(initiated.body.data);
      const status = safeStatus(data.status);
      if (!initiated.ok && [400, 401, 403, 404, 422].includes(initiated.status)) {
        await markFailedBeforeProviderAcceptance(
          pool, reference,
          "Paystack rejected the transfer request before accepting it. No FlowPay wallet debit was posted."
        );
        send(res, 202, {
          transactionId, reference, status: "failed", final: true,
          amountMinor: input.amountMinor, currency: "NGN", environment,
          message: "Paystack rejected this test transfer. No wallet debit was posted; review the bank and provider configuration."
        });
        return true;
      }
      if (!initiated.ok || data.domain !== environment || data.reference !== reference ||
          String(data.amount) !== input.amountMinor || data.currency !== "NGN") {
        await markUnknown(pool, reference, "Paystack did not return a matching transfer response.");
        send(res, 202, { transactionId, reference, status: "unknown", final: false, amountMinor: input.amountMinor, currency: "NGN", message: "Transfer submission outcome is unconfirmed. Funds remain reserved; refresh status before retrying." });
        return true;
      }
      const verified = await paystackRequest(secret, "/transfer/verify/" + encodeURIComponent(reference), "GET");
      const verifiedData = record(verified.body.data);
      if (!verified.ok || verifiedData.reference !== reference || String(verifiedData.amount) !== input.amountMinor ||
          verifiedData.currency !== "NGN" || verifiedData.domain !== environment) {
        await markUnknown(pool, reference, "Transfer was initiated, but Paystack verification has not confirmed its outcome.");
        send(res, 202, { transactionId, reference, status: status === "otp" ? "otp" : "pending", final: false, amountMinor: input.amountMinor, currency: "NGN", message: "Paystack is processing this test transfer. Funds remain reserved until the provider confirms the final status." });
        return true;
      }
      const result = await applyVerifiedStatus(pool, secret, reference, verifiedData, runtime.environment);
      send(res, result.status === "success" ? 201 : 202, {
        transactionId, reference, status: result.status, final: ["success", "failed", "reversed", "blocked", "abandoned", "rejected"].includes(result.status),
        amountMinor: input.amountMinor, currency: "NGN", bankName: recipient.bankName,
        accountName: recipient.accountName, accountNumberMasked: "******" + accountNumber.slice(-4),
        environment, livePayoutsEnabled: environment === "live" && process.env.PAYSTACK_LIVE_TRANSFERS_ENABLED === "true",
        message: result.status === "success" ? `Paystack confirmed the ${environment === "live" ? "live" : "sandbox"} bank transfer. FlowPay posted the matching wallet debit.` : "The transfer is not final. Its amount remains reserved while Paystack completes approval or processing."
      });
      return true;
    } catch (error) {
      await markUnknown(pool, reference, "The Paystack response could not be confirmed. Check provider status before retrying.");
      console.error("FlowPay Paystack bank payout outcome unconfirmed:", error instanceof Error ? error.message : "network error");
      send(res, 202, { transactionId, reference, status: "unknown", final: false, amountMinor: input.amountMinor, currency: "NGN", message: "Transfer outcome is unconfirmed. Funds remain reserved; use Refresh status before attempting another transfer." });
      return true;
    }
  };
}

async function markFailedBeforeProviderAcceptance(pool: Pool, reference: string, note: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const payout = await client.query<{ transaction_id: string }>(
      `SELECT transaction_id FROM public.fp_paystack_bank_transfers
        WHERE reference = $1 FOR UPDATE`,
      [reference]
    );
    if (payout.rowCount !== 1) throw new Error("FLOWPAY_BANK_TRANSFER_NOT_FOUND");
    const tx = await client.query<{ status: string }>(
      "SELECT status FROM public.fp_ledger_transactions WHERE id = $1 FOR UPDATE",
      [payout.rows[0].transaction_id]
    );
    if (tx.rowCount !== 1) throw new Error("FLOWPAY_LEDGER_TRANSACTION_NOT_FOUND");
    if (tx.rows[0].status === "pending") {
      const failed = await client.query(
        "UPDATE public.fp_ledger_transactions SET status = 'failed' WHERE id = $1 AND status = 'pending'",
        [payout.rows[0].transaction_id]
      );
      if (failed.rowCount !== 1) throw new Error("PAYOUT_LEDGER_FAIL_POST_FAILED");
    } else if (tx.rows[0].status !== "failed") {
      throw new Error("PAYOUT_LEDGER_STATE_REQUIRES_RECONCILIATION");
    }
    await client.query(
      `UPDATE public.fp_paystack_bank_transfers
          SET status = 'failed', provider_status = 'failed',
              status_note = $2, verified_at = NOW(), updated_at = NOW()
        WHERE transaction_id = $1`,
      [payout.rows[0].transaction_id, note]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function markUnknown(pool: Pool, reference: string, note: string): Promise<void> {
  await pool.query(
    `UPDATE public.fp_paystack_bank_transfers
        SET status = 'unknown', status_note = $2, updated_at = NOW()
      WHERE reference = $1 AND status IN ('initiating', 'pending', 'otp', 'unknown')`,
    [reference, note]
  );
}
