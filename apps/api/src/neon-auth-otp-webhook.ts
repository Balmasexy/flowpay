import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonWebKey } from "node:crypto";
import { normalizeNigerianPhone } from "./customer-phone-alias.js";

type Options = {
  jwksUrl?: string;
  termiiApiKey?: string;
  termiiSenderId?: string;
  termiiBaseUrl?: string;
  termiiChannel?: string;
  resendApiKey?: string;
  emailFrom?: string;
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) {
    raw += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(raw, "utf8") > 32_768) throw new Error("WEBHOOK_PAYLOAD_TOO_LARGE");
  }
  return raw;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character] ?? character);
}

/** Verify Neon's EdDSA detached JWS webhook signature and its five-minute timestamp window. */
export function verifyNeonWebhookSignature(
  rawBody: string,
  signature: string,
  timestamp: string,
  jwk: JsonWebKey,
  nowMs = Date.now()
): boolean {
  if (!/^\d{10,16}$/.test(timestamp)) return false;
  const eventTime = Number(timestamp);
  if (!Number.isSafeInteger(eventTime) || eventTime > nowMs + 60_000 || nowMs - eventTime > 300_000) return false;

  const parts = signature.split(".");
  if (parts.length !== 3 || !parts[0] || parts[1] !== "" || !parts[2]) return false;

  try {
    const payloadB64 = Buffer.from(rawBody, "utf8").toString("base64url");
    const timestampPayloadB64 = Buffer.from(timestamp + "." + payloadB64, "utf8").toString("base64url");
    const signingInput = Buffer.from(parts[0] + "." + timestampPayloadB64, "utf8");
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    return verifySignature(
      null,
      signingInput,
      publicKey,
      Buffer.from(parts[2], "base64url")
    );
  } catch {
    return false;
  }
}

async function findNeonSigningKey(jwksUrl: string, kid: string): Promise<JsonWebKey | null> {
  const response = await fetch(jwksUrl, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(3_000)
  });
  if (!response.ok) return null;
  const document = await response.json().catch(() => null) as { keys?: Array<JsonWebKey & { kid?: string }> } | null;
  if (!Array.isArray(document?.keys)) return null;
  return document.keys.find(key => key.kid === kid && key.kty === "OKP" && key.crv === "Ed25519") ?? null;
}

async function deliverEmailOtp(apiKey: string, from: string, email: string, code: string, type: string) {
  const subject = type === "forget-password" ? "Reset your FlowPay password" : "Your FlowPay verification code";
  const intro = type === "forget-password"
    ? "Use this code to reset your FlowPay password."
    : "Use this code to complete your FlowPay account verification.";
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#1f2937">
    <h2 style="color:#f97316">FlowPay</h2>
    <p>${intro}</p>
    <p style="font-size:30px;font-weight:700;letter-spacing:8px">${escapeHtml(code)}</p>
    <p>This code expires shortly. Do not share it with anyone, including FlowPay support.</p>
  </div>`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [email], subject, html }),
    signal: AbortSignal.timeout(4_000)
  });
  if (!response.ok) throw new Error("EMAIL_OTP_DELIVERY_FAILED");
}

async function deliverSmsOtp(
  apiKey: string,
  senderId: string,
  baseUrl: string,
  channel: string,
  phoneValue: string,
  code: string
) {
  const phone = normalizeNigerianPhone(phoneValue);
  if (!phone) throw new Error("NEON_OTP_PHONE_INVALID");
  const response = await fetch(baseUrl.replace(/\/+$/, "") + "/api/sms/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      to: phone.e164.slice(1),
      from: senderId,
      sms: "Your FlowPay verification code is " + code + ". Do not share this code. It expires in 5 minutes.",
      type: "plain",
      channel
    }),
    signal: AbortSignal.timeout(4_000)
  });
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof result.message_id !== "string") {
    throw new Error("SMS_OTP_DELIVERY_FAILED");
  }
}

export function createNeonAuthOtpWebhookHandler(options: Options) {
  const jwksUrl = options.jwksUrl?.trim() ?? "";
  const termiiApiKey = options.termiiApiKey?.trim() ?? "";
  const termiiSenderId = options.termiiSenderId?.trim() ?? "";
  const termiiBaseUrl = (options.termiiBaseUrl?.trim() || "https://api.ng.termii.com").replace(/\/+$/, "");
  const termiiChannel = options.termiiChannel?.trim() || "dnd";
  const resendApiKey = options.resendApiKey?.trim() ?? "";
  const emailFrom = options.emailFrom?.trim() ?? "";

  return async function handleNeonAuthOtpWebhook(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
    if (req.method !== "POST" || path !== "/webhooks/neon-auth/otp") return false;

    if (!jwksUrl) {
      send(res, 503, { error: "NEON_AUTH_WEBHOOK_JWKS_NOT_CONFIGURED" });
      return true;
    }

    let rawBody: string;
    try { rawBody = await readRawBody(req); }
    catch {
      send(res, 413, { error: "WEBHOOK_PAYLOAD_TOO_LARGE" });
      return true;
    }

    const signature = req.headers["x-neon-signature"];
    const kid = req.headers["x-neon-signature-kid"];
    const timestamp = req.headers["x-neon-timestamp"];
    if (typeof signature !== "string" || typeof kid !== "string" || typeof timestamp !== "string") {
      send(res, 401, { error: "NEON_WEBHOOK_SIGNATURE_REQUIRED" });
      return true;
    }

    try {
      const jwk = await findNeonSigningKey(jwksUrl, kid);
      if (!jwk || !verifyNeonWebhookSignature(rawBody, signature, timestamp, jwk)) {
        send(res, 401, { error: "NEON_WEBHOOK_SIGNATURE_INVALID" });
        return true;
      }
    } catch {
      send(res, 503, { error: "NEON_WEBHOOK_SIGNATURE_CHECK_UNAVAILABLE" });
      return true;
    }

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid payload");
      payload = parsed as Record<string, unknown>;
    } catch {
      send(res, 400, { error: "INVALID_NEON_WEBHOOK_PAYLOAD" });
      return true;
    }

    if (payload.event_type !== "send.otp") {
      send(res, 200, { success: true, ignored: true });
      return true;
    }

    const eventData = payload.event_data && typeof payload.event_data === "object"
      ? payload.event_data as Record<string, unknown> : {};
    const user = payload.user && typeof payload.user === "object"
      ? payload.user as Record<string, unknown> : {};
    const code = typeof eventData.otp_code === "string" ? eventData.otp_code : "";
    const preference = typeof eventData.delivery_preference === "string"
      ? eventData.delivery_preference : "email";

    if (!/^\d{6}$/.test(code)) {
      send(res, 400, { error: "INVALID_NEON_OTP_EVENT" });
      return true;
    }

    try {
      if (preference === "sms") {
        const phone = typeof user.phone_number === "string" ? user.phone_number
          : typeof user.phoneNumber === "string" ? user.phoneNumber : "";
        if (!termiiApiKey || !termiiSenderId || !phone) {
          send(res, 503, { error: "PHONE_OTP_DELIVERY_NOT_CONFIGURED" });
          return true;
        }
        await deliverSmsOtp(termiiApiKey, termiiSenderId, termiiBaseUrl, termiiChannel, phone, code);
      } else {
        const email = typeof user.email === "string" ? user.email : "";
        const otpType = typeof eventData.otp_type === "string" ? eventData.otp_type : "email-verification";
        if (!resendApiKey || !emailFrom || !email.includes("@") || !email) {
          send(res, 503, { error: "EMAIL_OTP_DELIVERY_NOT_CONFIGURED" });
          return true;
        }
        await deliverEmailOtp(resendApiKey, emailFrom, email, code, otpType);
      }
      send(res, 200, { success: true });
    } catch (error) {
      console.error("Neon Auth OTP delivery failed:", error instanceof Error ? error.message : "delivery error");
      send(res, 502, { error: "NEON_OTP_DELIVERY_FAILED" });
    }
    return true;
  };
}
