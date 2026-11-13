import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { settleVerifiedFlutterwaveDeposit } from "./flutterwave-settlement.js";

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
      : typeof verified.id === "string" && /^\d{1,30}$/.test(verified.id) ? verified.id : null;
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

    const eventHash = createHash("sha256").update(rawBody).digest("hex");
    try {
      const settled = await settleVerifiedFlutterwaveDeposit(pool, {
        providerReference,
        providerTransactionId: providerIdText,
        amountMinor: verifiedAmount,
        currency: "NGN",
        eventId: providerIdText,
        eventType: "charge.completed",
        payloadSha256: eventHash
      });
      send(res, 200, {
        received: true,
        processed: true,
        duplicate: settled.duplicate,
        providerVerified: true,
        transactionId: settled.transactionId,
        status: settled.status,
        walletCredited: settled.walletCredited
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "WEBHOOK_PROCESSING_UNAVAILABLE";
      if ([
        "FLOWPAY_FLUTTERWAVE_DEPOSIT_NOT_FOUND",
        "FLOWPAY_FLUTTERWAVE_DEPOSIT_MISMATCH",
        "FLUTTERWAVE_DUPLICATE_EVENT_MISMATCH",
        "FLUTTERWAVE_DEPOSIT_NOT_PENDING"
      ].includes(code)) {
        send(res, 202, { received: true, processed: false, reason: code });
        return true;
      }
      console.error("FlowPay Flutterwave webhook settlement failed:", code);
      send(res, 503, { error: code === "FLUTTERWAVE_CLEARING_ACCOUNT_NOT_CONFIGURED"
        ? code : "WEBHOOK_PROCESSING_UNAVAILABLE" });
    }
    return true;
  };
}
