import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getSelectedPaystackCredential } from "./paystack-config.js";

type Options = {
  pool: Pool | null;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
  issuer?: string;
  audience?: string;
};
type Bank = { code: string; name: string };
type PaystackBank = {
  code?: unknown; name?: unknown; active?: unknown; is_deleted?: unknown;
  country?: unknown; currency?: unknown; type?: unknown;
};
type PaystackResponse = {
  status?: unknown;
  data?: unknown;
  meta?: { next?: unknown; perPage?: unknown };
};
let bankCache: { expiresAt: number; banks: Bank[] } | null = null;
const lookups = new Map<string, number[]>();

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
    if (Buffer.byteLength(raw, "utf8") > 4_096) throw new Error("PAYLOAD_TOO_LARGE");
  }
  const parsed: unknown = JSON.parse(raw || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_PAYLOAD");
  return parsed as Record<string, unknown>;
}
async function paystackGet(secret: string, path: string): Promise<PaystackResponse> {
  const response = await fetch("https://api.paystack.co" + path, {
    headers: { Authorization: "Bearer " + secret, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000)
  });
  const body = await response.json().catch(() => null) as PaystackResponse | null;
  if (!response.ok || body?.status !== true) throw new Error("PAYSTACK_BANK_API_UNAVAILABLE");
  return body;
}
async function fetchBanks(secret: string): Promise<Bank[]> {
  if (bankCache && bankCache.expiresAt > Date.now()) return bankCache.banks;
  const banks: Bank[] = [];
  let next: string | null = null;
  let page = 0;
  do {
    const url = new URL("https://api.paystack.co/bank");
    url.searchParams.set("country", "nigeria");
    url.searchParams.set("currency", "NGN");
    url.searchParams.set("perPage", "100");
    url.searchParams.set("use_cursor", "true");
    if (next) url.searchParams.set("next", next);
    const result = await paystackGet(secret, url.pathname + url.search);
    if (!Array.isArray(result.data)) throw new Error("PAYSTACK_BANK_LIST_INVALID");
    for (const item of result.data as PaystackBank[]) {
      if (
        typeof item.code === "string" && item.code.trim() &&
        typeof item.name === "string" && item.name.trim() &&
        item.active !== false && item.is_deleted !== true &&
        (!item.country || String(item.country).toLowerCase() === "nigeria") &&
        (!item.currency || String(item.currency).toUpperCase() === "NGN") &&
        (!item.type || String(item.type).toLowerCase() === "nuban")
      ) banks.push({ code: item.code.trim(), name: item.name.trim() });
    }
    next = typeof result.meta?.next === "string" && result.meta.next.trim()
      ? result.meta.next.trim() : null;
    page += 1;
  } while (next && page < 10);
  const unique = [...new Map(banks.map(bank => [bank.code, bank])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!unique.length) throw new Error("PAYSTACK_BANK_LIST_EMPTY");
  bankCache = { expiresAt: Date.now() + 5 * 60_000, banks: unique };
  return unique;
}

export function createBankAccountLookupHandler(options: Options) {
  const { pool, jwks, issuer, audience } = options;
  return async function handleBankAccountLookup(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
    if (!["GET", "POST"].includes(req.method ?? "") ||
        !["/customer/banks", "/customer/bank-account-lookup"].includes(pathname)) return false;
    if (!pool || !jwks || !issuer || !audience) {
      send(res, 503, { error: "BANK_LOOKUP_AUTH_NOT_CONFIGURED" }); return true;
    }
    const auth = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if (!auth) { send(res, 401, { error: "AUTHENTICATION_REQUIRED" }); return true; }
    let userId: string;
    try {
      const { payload } = await jwtVerify(auth[1], jwks, { algorithms: ["EdDSA"], issuer, audience });
      if (typeof payload.sub !== "string" || !payload.sub) {
        send(res, 401, { error: "INVALID_SESSION" }); return true;
      }
      const identity = await pool.query(
        'SELECT app_user.id FROM neon_auth."user" AS auth_user JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text WHERE auth_user.id::text = $1 AND auth_user."emailVerified" = true AND app_user.status = $2 LIMIT 1',
        [payload.sub, "active"]);
      if (identity.rowCount !== 1) {
        send(res, 403, { error: "ACTIVE_VERIFIED_CUSTOMER_REQUIRED" }); return true;
      }
      userId = String(identity.rows[0].id);
    } catch (error) {
      if (isJwtError(error)) send(res, 401, { error: "INVALID_SESSION" });
      else send(res, 503, { error: "BANK_LOOKUP_AUTH_UNAVAILABLE" });
      return true;
    }
    const credential = getSelectedPaystackCredential();
    const secret = credential?.secretKey ?? "";
    if (!credential) { send(res, 503, { error: "PAYSTACK_CREDENTIALS_NOT_CONFIGURED" }); return true; }
    try {
      if (req.method === "GET" && pathname === "/customer/banks") {
        const banks = await fetchBanks(secret);
        send(res, 200, { banks, country: "NG", currency: "NGN", provider: "Paystack", environment: credential.environment });
        return true;
      }
      let input: Record<string, unknown>;
      try { input = await readJson(req); }
      catch (error) {
        send(res, error instanceof Error && error.message === "PAYLOAD_TOO_LARGE" ? 413 : 400,
          { error: error instanceof Error ? error.message : "INVALID_PAYLOAD" });
        return true;
      }
      if (Object.keys(input).some(key => !["accountNumber", "bankCode"].includes(key))) {
        send(res, 400, { error: "UNSUPPORTED_LOOKUP_FIELD" }); return true;
      }
      const accountNumber = typeof input.accountNumber === "string" ? input.accountNumber.trim() : "";
      const bankCode = typeof input.bankCode === "string" ? input.bankCode.trim() : "";
      if (!/^\d{10}$/.test(accountNumber) || !/^[A-Za-z0-9_-]{2,12}$/.test(bankCode)) {
        send(res, 400, { error: "VALID_NIGERIAN_ACCOUNT_AND_BANK_REQUIRED" }); return true;
      }
      const banks = await fetchBanks(secret);
      const bank = banks.find(item => item.code === bankCode);
      if (!bank) { send(res, 400, { error: "UNSUPPORTED_BANK_CODE" }); return true; }
      const now = Date.now();
      const recent = (lookups.get(userId) ?? []).filter(time => now - time < 60_000);
      if (recent.length >= 8) { send(res, 429, { error: "BANK_LOOKUP_RATE_LIMITED" }); return true; }
      recent.push(now); lookups.set(userId, recent);
      const url = new URL("https://api.paystack.co/bank/resolve");
      url.searchParams.set("account_number", accountNumber);
      url.searchParams.set("bank_code", bankCode);
      const response = await fetch(url, {
        headers: { Authorization: "Bearer " + secret, Accept: "application/json" },
        signal: AbortSignal.timeout(12_000)
      });
      const body = await response.json().catch(() => null) as {
        status?: unknown; data?: { account_number?: unknown; account_name?: unknown }
      } | null;
      const returnedNumber = typeof body?.data?.account_number === "string" ? body.data.account_number : "";
      const accountName = typeof body?.data?.account_name === "string" ? body.data.account_name.trim() : "";
      if (!response.ok || body?.status !== true || returnedNumber !== accountNumber ||
          !accountName || accountName.length > 160) {
        send(res, 422, { verified: false, error: "ACCOUNT_NAME_NOT_VERIFIED",
          message: "Paystack could not verify this account. Check the bank and account number." });
        return true;
      }
      send(res, 200, {
        verified: true, accountNumber, bankCode, bankName: bank.name,
        accountName, provider: "Paystack", environment: "test"
      });
      return true;
    } catch (error) {
      console.error("FlowPay Paystack bank account lookup failed:", error instanceof Error ? error.message : "unknown provider error");
      send(res, 503, { error: "PAYSTACK_BANK_LOOKUP_TEMPORARILY_UNAVAILABLE" });
      return true;
    }
  };
}
