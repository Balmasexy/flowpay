import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";

type Options = { pool: Pool | null };
type Deposit = {
  transaction_id: string;
  provider_tx_ref: string;
  provider_transaction_id: string | null;
  amount_minor: string;
  currency: string;
  status: "pending" | "posted" | "failed";
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > 65_536) throw Object.assign(new Error("PAYLOAD_TOO_LARGE"), { statusCode: 413 });
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

function safeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function amountToMinor(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value);
  const match = /^(0|[1-9]\d{0,12})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(2, "0"));
  return (whole * 100n + fraction).toString();
}

export function createFlutterwaveWebhookHandler({ pool }: Options) {
  return async function handleFlutterwaveWebhook(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
    if (req.method !== "POST" || pathname !== "/webhooks/flutterwave") return false;

    const secretHash = process.env.FLW_WEBHOOK_SECRET_HASH?.trim() ?? "";
    const secretKey = process.env.FLW_SECRET_KEY?.trim() ?? "";
    if (!pool || !secretHash || !secretKey.startsWith("FLWSECK_TEST-") || process.env.FLW_ENVIRONMENT !== "test") {
      send(res, 503, { error: "FLUTTERWAVE_WEBHOOK_NOT_CONFIGURED" });
      return true;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readRawBody(req);
    } catch (error) {
      const status = error && typeof error === "object" && "statusCode" in error
        ? Number((error as { statusCode: unknown }).statusCode) : 400;
      send(res, status, { error: "INVALID_WEBHOOK_PAYLOAD" });
      return true;
    }

    const suppliedHash = req.headers["verif-hash"];
    if (typeof suppliedHash !== "string" || !safeEqualText(suppliedHash, secretHash)) {
      send(res, 401, { error: "INVALID_WEBHOOK_SIGNATURE" });
      return true;
    }

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid payload");
      payload = parsed as Record<string, unknown>;
    } catch {
      send(res, 400, { error: "INVALID_WEBHOOK_JSON" });
      return true;
    }

    if (payload.event !== "charge.completed") {
      send(res, 200, { received: true, processed: false, reason: "UNSUPPORTED_EVENT" });
      return true;
    }
    const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? payload.data as Record<string, unknown> : {};
    const providerId = data.id;
    const providerIdText = typeof providerId === "number" && Number.isSafeInteger(providerId)
      ? String(providerId) : typeof providerId === "string" && /^\d{1,30}$/.test(providerId) ? providerId : null;
    const providerReference = typeof data.tx_ref === "string" ? data.tx_ref : "";
    if (!providerIdText || !providerReference || data.status !== "successful") {
      send(res, 200, { received: true, processed: false, reason: "NON_SUCCESSFUL_OR_INCOMPLETE_EVENT" });
      return true;
    }

    let verifyResponse: Response;
    let verifyPayload: unknown;
    try {
      verifyResponse = await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(providerIdText)}/verify`, {
        method: "GET",
        headers: { Authorization: `Bearer ${secretKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(12_000)
      });
      verifyPayload = await verifyResponse.json().catch(() => null);
    } catch (error) {
      console.error("FlowPay Flutterwave verification request failed:", error instanceof Error ? error.message : "network error");
      send(res, 503, { error: "PROVIDER_VERIFICATION_UNAVAILABLE" });
      return true;
    }
    const verifyBody = verifyPayload && typeof verifyPayload === "object" && !Array.isArray(verifyPayload)
      ? verifyPayload as Record<string, unknown> : {};
    const verified = verifyBody.data && typeof verifyBody.data === "object" && !Array.isArray(verifyBody.data)
      ? verifyBody.data as Record<string, unknown> : {};
    if (!verifyResponse.ok || verifyBody.status !== "success" || verified.status !== "successful") {
      send(res, 202, { received: true, processed: false, reason: "PROVIDER_TRANSACTION_NOT_VERIFIED" });
      return true;
    }

    const verifiedReference = typeof verified.tx_ref === "string" ? verified.tx_ref : "";
    const verifiedCurrency = typeof verified.currency === "string" ? verified.currency : "";
    const eventCurrency = typeof data.currency === "string" ? data.currency : "";
    const verifiedId = typeof verified.id === "number" && Number.isSafeInteger(verified.id)
      ? String(verified.id)
      : typeof verified.id === "string" && /^\\d{1,30}$/.test(verified.id) ? verified.id : null;
    const verifiedAmount = amountToMinor(verified.amount);
    const eventAmount = amountToMinor(data.amount);
    if (
      verifiedId !== providerIdText ||
      verifiedReference !== providerReference ||
      verifiedCurrency !== "NGN" ||
      eventCurrency !== "NGN" ||
      verifiedAmount === null ||
      eventAmount === null ||
      verifiedAmount !== eventAmount
    ) {
      send(res, 202, { received: true, processed: false, reason: "PROVIDER_EVENT_MISMATCH" });
      return true;
    }

    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      console.error("FlowPay Flutterwave webhook database unavailable:", error instanceof Error ? error.message : "database error");
      send(res, 503, { error: "WEBHOOK_DATABASE_UNAVAILABLE" });
      return true;
    }
    try {
      await client.query("BEGIN");
      const result = await client.query<Deposit>(
        `SELECT transaction_id, provider_tx_ref, provider_transaction_id,
                amount_minor::text AS amount_minor, currency, status
           FROM public.fp_flutterwave_deposits
          WHERE provider_tx_ref = $1
          FOR UPDATE`,
        [providerReference]
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
        (deposit.provider_transaction_id && deposit.provider_transaction_id !== providerIdText) ||
        deposit.status === "failed"
      ) {
        await client.query("ROLLBACK");
        send(res, 202, { received: true, processed: false, reason: "FLOWPAY_DEPOSIT_MISMATCH" });
        return true;
      }

      const eventHash = createHash("sha256").update(rawBody).digest("hex");
      const inserted = await client.query(
        `INSERT INTO public.fp_payment_events
           (provider, provider_event_id, event_type, transaction_id, payload_sha256, processing_status)
         VALUES ('flutterwave', $1, 'charge.completed', $2, $3, 'pending')
         ON CONFLICT (provider, provider_event_id) DO NOTHING
         RETURNING provider_event_id`,
        [providerIdText, deposit.transaction_id, eventHash]
      );

      if (inserted.rowCount === 0) {
        await client.query("COMMIT");
        send(res, 200, { received: true, processed: true, duplicate: true, walletCredited: false });
        return true;
      }

      await client.query(
        `UPDATE public.fp_flutterwave_deposits
            SET provider_transaction_id = $2,
                verified_at = COALESCE(verified_at, NOW())
          WHERE transaction_id = $1 AND status = 'pending'`,
        [deposit.transaction_id, providerIdText]
      );
      await client.query(
        `UPDATE public.fp_payment_events
            SET processing_status = 'processed'
          WHERE provider = 'flutterwave' AND provider_event_id = $1`,
        [providerIdText]
      );
      await client.query("COMMIT");
      send(res, 200, {
        received: true,
        processed: true,
        providerVerified: true,
        transactionId: deposit.transaction_id,
        status: "pending",
        walletCredited: false
      });
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("FlowPay Flutterwave webhook processing failed:", error instanceof Error ? error.message : "database error");
      send(res, 503, { error: "WEBHOOK_PROCESSING_UNAVAILABLE" });
      return true;
    } finally {
      client.release();
    }
  };
}
