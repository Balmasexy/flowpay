import type { IncomingMessage, ServerResponse } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";

type Options = {
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
  issuer?: string;
  audience?: string;
};

type Bank = { id?: number; code: string; name: string };
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

function sandboxSecret(): string | null {
  const secret = process.env.FLW_SECRET_KEY?.trim() ?? "";
  return process.env.FLW_ENVIRONMENT === "test" && secret.startsWith("FLWSECK_TEST-") ? secret : null;
}

async function fetchBanks(secret: string): Promise<Bank[]> {
  if (bankCache && bankCache.expiresAt > Date.now()) return bankCache.banks;
  const response = await fetch("https://api.flutterwave.com/v3/banks/NG?include_provider_type=1", {
    headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000)
  });
  const body = await response.json().catch(() => null) as { status?: string; data?: unknown } | null;
  if (!response.ok || body?.status !== "success" || !Array.isArray(body.data)) throw new Error("BANK_LIST_UNAVAILABLE");
  const banks = body.data.filter((item): item is Bank => !!item && typeof item === "object"
    && typeof (item as Bank).code === "string" && typeof (item as Bank).name === "string")
    .map(item => ({ code: item.code, name: item.name, ...(Number.isInteger(item.id) ? { id: item.id } : {}) }));
  bankCache = { expiresAt: Date.now() + 5 * 60_000, banks };
  return banks;
}

export function createBankAccountLookupHandler(options: Options) {
  const { jwks, issuer, audience } = options;
  return async function handleBankAccountLookup(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
    if (!["GET", "POST"].includes(req.method ?? "") || !["/customer/banks", "/customer/bank-account-lookup"].includes(pathname)) return false;
    if (!jwks || !issuer || !audience) {
      send(res, 503, { error: "BANK_LOOKUP_AUTH_NOT_CONFIGURED" }); return true;
    }
    const auth = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if (!auth) { send(res, 401, { error: "AUTHENTICATION_REQUIRED" }); return true; }
    let userId: string;
    try {
      const { payload } = await jwtVerify(auth[1], jwks, { algorithms: ["EdDSA"], issuer, audience });
      if (typeof payload.sub !== "string" || !payload.sub) { send(res, 401, { error: "INVALID_SESSION" }); return true; }
      userId = payload.sub;
    } catch (error) {
      if (isJwtError(error)) send(res, 401, { error: "INVALID_SESSION" });
      else send(res, 503, { error: "BANK_LOOKUP_AUTH_UNAVAILABLE" });
      return true;
    }
    const secret = sandboxSecret();
    if (!secret) { send(res, 503, { error: "BANK_LOOKUP_SANDBOX_NOT_CONFIGURED" }); return true; }
    try {
      if (req.method === "GET" && pathname === "/customer/banks") {
        const banks = await fetchBanks(secret);
        send(res, 200, { banks, country: "NG", provider: "Flutterwave", environment: "test" });
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
      if (!/^\d{10}$/.test(accountNumber) || !/^\d{2,8}$/.test(bankCode)) {
        send(res, 400, { error: "VALID_NIGERIAN_ACCOUNT_AND_BANK_REQUIRED" }); return true;
      }
      const banks = await fetchBanks(secret);
      const bank = banks.find(item => item.code === bankCode);
      if (!bank) { send(res, 400, { error: "UNSUPPORTED_BANK_CODE" }); return true; }
      const now = Date.now();
      const recent = (lookups.get(userId) ?? []).filter(time => now - time < 60_000);
      if (recent.length >= 8) { send(res, 429, { error: "BANK_LOOKUP_RATE_LIMITED" }); return true; }
      recent.push(now); lookups.set(userId, recent);
      const response = await fetch("https://api.flutterwave.com/v3/accounts/resolve", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ account_number: accountNumber, account_bank: bankCode }),
        signal: AbortSignal.timeout(12_000)
      });
      const body = await response.json().catch(() => null) as {
        status?: string; data?: { account_number?: unknown; account_name?: unknown }
      } | null;
      const returnedNumber = typeof body?.data?.account_number === "string" ? body.data.account_number : "";
      const accountName = typeof body?.data?.account_name === "string" ? body.data.account_name.trim() : "";
      if (!response.ok || body?.status !== "success" || returnedNumber !== accountNumber || !accountName || accountName.length > 160) {
        send(res, 422, { verified: false, error: "ACCOUNT_NAME_NOT_VERIFIED", message: "We could not verify this account. Check the bank and account number." });
        return true;
      }
      send(res, 200, {
        verified: true, accountNumber, bankCode, bankName: bank.name,
        accountName, provider: "Flutterwave", environment: "test"
      });
      return true;
    } catch (error) {
      console.error("FlowPay bank account lookup failed:", error instanceof Error ? error.message : "unknown provider error");
      send(res, 503, { error: "BANK_LOOKUP_TEMPORARILY_UNAVAILABLE" });
      return true;
    }
  };
}
