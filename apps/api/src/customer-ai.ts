import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createRemoteJWKSet, jwtVerify } from "jose";

type Options = {
  pool: Pool | null;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
  issuer?: string;
  audience?: string;
};
type CustomerIdentity = { id: string; name: string | null };

const MAX_MESSAGE_LENGTH = 2_000;
const MAX_PAYLOAD_BYTES = 8_192;
const MAX_REQUESTS_PER_MINUTE = 12;
const requestTimes = new Map<string, number[]>();

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
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
    if (Buffer.byteLength(raw, "utf8") > MAX_PAYLOAD_BYTES) throw new Error("PAYLOAD_TOO_LARGE");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw || "{}"); }
  catch { throw new Error("INVALID_JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_PAYLOAD");
  return parsed as Record<string, unknown>;
}
function allowRequest(userId: string): boolean {
  const now = Date.now();
  const recent = (requestTimes.get(userId) ?? []).filter((timestamp) => now - timestamp < 60_000);
  if (recent.length >= MAX_REQUESTS_PER_MINUTE) {
    requestTimes.set(userId, recent);
    return false;
  }
  recent.push(now);
  requestTimes.set(userId, recent);
  return true;
}
function extractResponseText(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const body = payload as { output_text?: unknown; output?: unknown };
  if (typeof body.output_text === "string") return body.output_text.trim();
  const parts: string[] = [];
  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part && typeof part === "object" && !Array.isArray(part)) {
          const text = (part as { text?: unknown }).text;
          if (typeof text === "string") parts.push(text);
        }
      }
    }
  }
  return parts.join("\n").trim();
}

const SYSTEM_INSTRUCTIONS = [
  "You are BALMZ AI, the customer support assistant inside FlowPay.",
  "Help customers understand FlowPay screens and safe product workflows: account registration, wallet balances, deposits, transfer destinations, account numbers, transaction history, cards, security, verification and support.",
  "You are a guidance assistant only. You cannot access customer balances, payment records, transaction statuses, card data or identity documents. Never imply that you have checked any account or performed any action.",
  "Never invent balances, fees, limits, bank details, payment outcomes, dates, available services or provider status. When a question requires account-specific information, direct the customer to the relevant authenticated FlowPay page or Help & Support.",
  "FlowPay wallet-to-wallet transfers are a separate internal destination and require the app's transaction PIN. A To Bank recipient review is not proof that a bank payout was submitted or completed.",
  "Never initiate, approve, reverse or settle payments; never modify balances or customer records; never request or accept PINs, passwords, one-time codes, full card numbers, full bank-account numbers, API keys or other secrets.",
  "If the customer shares a secret, tell them not to share it and do not repeat it. For urgent account or security concerns, direct them to the in-app Help & Support page.",
  "Be concise, friendly, accurate and clear about uncertainty. Use only the information in the customer's current question and the limited customer display name supplied below."
].join(" ");

export function createCustomerAiHandler(options: Options) {
  const { pool, jwks, issuer, audience } = options;
  return async function handleCustomerAi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
    if (req.method !== "POST" || pathname !== "/customer-ai/chat") return false;

    if (!pool || !jwks || !issuer || !audience) {
      send(res, 503, { error: "FLOWPAY_AI_AUTH_NOT_CONFIGURED" });
      return true;
    }
    const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if (!bearer) {
      send(res, 401, { error: "AUTHENTICATION_REQUIRED" });
      return true;
    }

    let customer: CustomerIdentity;
    try {
      const { payload } = await jwtVerify(bearer[1], jwks, {
        algorithms: ["EdDSA"], issuer, audience
      });
      if (typeof payload.sub !== "string" || !payload.sub) {
        send(res, 401, { error: "INVALID_SESSION" });
        return true;
      }
      const identity = await pool.query<CustomerIdentity>(
        'SELECT app_user.id, auth_user.name FROM neon_auth."user" AS auth_user JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text WHERE auth_user.id::text = $1 AND auth_user."emailVerified" = true AND app_user.status = $2 AND app_user.role = $3 LIMIT 1',
        [payload.sub, "active", "customer"]
      );
      if (identity.rowCount !== 1 || !identity.rows[0]) {
        send(res, 403, { error: "ACTIVE_VERIFIED_CUSTOMER_REQUIRED" });
        return true;
      }
      customer = identity.rows[0];
    } catch (error) {
      if (isJwtError(error)) send(res, 401, { error: "INVALID_SESSION" });
      else {
        console.error("FlowPay BALMZ AI authentication failed:", error instanceof Error ? error.message : "unknown error");
        send(res, 503, { error: "FLOWPAY_AI_AUTH_UNAVAILABLE" });
      }
      return true;
    }

    let input: Record<string, unknown>;
    try { input = await readJson(req); }
    catch (error) {
      const reason = error instanceof Error ? error.message : "INVALID_PAYLOAD";
      send(res, reason === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: reason });
      return true;
    }
    if (Object.keys(input).some((key) => key !== "message")) {
      send(res, 400, { error: "UNSUPPORTED_AI_FIELD" });
      return true;
    }
    const message = typeof input.message === "string" ? input.message.trim() : "";
    if (!message) {
      send(res, 400, { error: "MESSAGE_REQUIRED" });
      return true;
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      send(res, 413, { error: "MESSAGE_TOO_LONG", maximumCharacters: MAX_MESSAGE_LENGTH });
      return true;
    }
    if (!allowRequest(customer.id)) {
      send(res, 429, { error: "AI_RATE_LIMITED", retryAfterSeconds: 60 });
      return true;
    }

    const apiKey = process.env.FLOWPAY_BALMZ_AI_API_KEY?.trim() ?? "";
    if (!apiKey) {
      send(res, 503, {
        error: "FLOWPAY_BALMZ_AI_NOT_CONFIGURED",
        assistant: "BALMZ AI",
        message: "BALMZ AI is available in FlowPay, but its service key has not been configured yet."
      });
      return true;
    }
    const model = process.env.FLOWPAY_BALMZ_AI_MODEL?.trim() || "gpt-6-luna";
    const customerName = customer.name?.trim().slice(0, 80) || "FlowPay customer";

    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          model,
          instructions: SYSTEM_INSTRUCTIONS + " Customer display name: " + customerName + ".",
          input: message,
          max_output_tokens: 500,
          store: false
        }),
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) {
        console.error("FlowPay BALMZ AI provider returned HTTP", response.status);
        send(res, 503, {
          error: "FLOWPAY_BALMZ_AI_PROVIDER_UNAVAILABLE",
          assistant: "BALMZ AI",
          message: "BALMZ AI is temporarily unavailable. Please try again or use Help & Support."
        });
        return true;
      }
      const payload: unknown = await response.json().catch(() => null);
      const reply = extractResponseText(payload);
      if (!reply) {
        send(res, 503, {
          error: "FLOWPAY_BALMZ_AI_EMPTY_RESPONSE",
          assistant: "BALMZ AI",
          message: "BALMZ AI could not prepare a reply. Please try again."
        });
        return true;
      }
      send(res, 200, {
        assistant: "BALMZ AI",
        configured: true,
        model,
        reply
      });
      return true;
    } catch (error) {
      console.error("FlowPay BALMZ AI request failed:", error instanceof Error ? error.message : "provider network error");
      send(res, 503, {
        error: "FLOWPAY_BALMZ_AI_PROVIDER_UNAVAILABLE",
        assistant: "BALMZ AI",
        message: "BALMZ AI is temporarily unavailable. Please try again or use Help & Support."
      });
      return true;
    }
  };
}
