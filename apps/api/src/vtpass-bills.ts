import { randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { createRemoteJWKSet, jwtVerify } from "jose";

type Options = {
  pool: Pool | null;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
  issuer?: string;
  audience?: string;
};
type Config = { environment: "sandbox" | "live"; baseUrl: string; apiKey: string; publicKey: string; secretKey: string };
type BillStatus = "initiating" | "pending" | "unknown" | "success" | "failed" | "reversed";
type BillRow = {
  transaction_id: string; user_id: string; account_id: string; idempotency_key: string;
  request_id: string; category: string; service_id: string; variation_code: string | null;
  customer_reference: string; customer_phone: string; amount_minor: string; status: BillStatus;
};
type ProviderBody = Record<string, unknown>;

const CATALOG = {
  airtime: [
    { id: "mtn", label: "MTN" }, { id: "airtel", label: "Airtel" },
    { id: "glo", label: "Glo" }, { id: "etisalat", label: "9mobile" }
  ],
  data: [
    { id: "mtn-data", label: "MTN Data" }, { id: "airtel-data", label: "Airtel Data" },
    { id: "glo-data", label: "Glo Data" }, { id: "etisalat-data", label: "9mobile Data" }
  ],
  electricity: [
    { id: "ikeja-electric", label: "Ikeja Electric (IKEDC)" },
    { id: "eko-electric", label: "Eko Electric (EKEDC)" },
    { id: "abuja-electric", label: "Abuja Electric (AEDC)" },
    { id: "ibadan-electric", label: "Ibadan Electric (IBEDC)" },
    { id: "kano-electric", label: "Kano Electric (KEDCO)" },
    { id: "portharcourt-electric", label: "Port Harcourt Electric (PHED)" },
    { id: "jos-electric", label: "Jos Electric" },
    { id: "kaduna-electric", label: "Kaduna Electric" }
  ]
} as const;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function jwtError(error: unknown) {
  return error instanceof Error && ["JWTExpired","JWSSignatureVerificationFailed","JWTClaimValidationFailed","JWSInvalid","JWTInvalid"].includes(error.name);
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
function config(): Config | null {
  const environment = process.env.VTPASS_ENVIRONMENT;
  const apiKey = process.env.VTPASS_API_KEY?.trim() ?? "";
  const publicKey = process.env.VTPASS_PUBLIC_KEY?.trim() ?? "";
  const secretKey = process.env.VTPASS_SECRET_KEY?.trim() ?? "";
  if (!apiKey || !publicKey || !secretKey) return null;
  if (environment === "sandbox" && process.env.NODE_ENV !== "production") {
    return { environment: "sandbox", baseUrl: "https://sandbox.vtpass.com/api", apiKey, publicKey, secretKey };
  }
  if (environment === "live" && process.env.NODE_ENV === "production" && process.env.VTPASS_LIVE_ENABLED === "true") {
    return { environment: "live", baseUrl: "https://vtpass.com/api", apiKey, publicKey, secretKey };
  }
  return null;
}
async function providerRequest(cfg: Config, method: "GET" | "POST", endpoint: string, payload?: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: ProviderBody }> {
  const url = new URL(cfg.baseUrl + endpoint);
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      ...(method === "GET"
        ? { "api-key": cfg.apiKey, "public-key": cfg.publicKey }
        : { "api-key": cfg.apiKey, "secret-key": cfg.secretKey, "Content-Type": "application/json" })
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(15_000)
  });
  const body = record(await response.json().catch(() => null));
  return { ok: response.ok, status: response.status, body };
}
async function authenticate(pool: Pool, jwks: ReturnType<typeof createRemoteJWKSet>, issuer: string, audience: string, req: IncomingMessage): Promise<string | null> {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  const { payload } = await jwtVerify(token, jwks, { algorithms: ["EdDSA"], issuer, audience });
  if (typeof payload.sub !== "string" || !payload.sub) return null;
  const result = await pool.query(
    'SELECT app_user.id FROM neon_auth."user" AS auth_user JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text WHERE auth_user.id::text = $1 AND auth_user."emailVerified" = true AND app_user.status = \'active\' AND app_user.role IN (\'customer\',\'super_admin\') LIMIT 1',
    [payload.sub]
  );
  return result.rowCount === 1 ? String(result.rows[0].id) : null;
}
function validUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function amountMinor(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9]\d{0,12}$/.test(value)) return false;
  return BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
}
function nairaAmount(minor: string): number { return Number(minor) / 100; }
export function normalizePhone(value: unknown): string {
  if (typeof value !== "string") return "";
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("234") && digits.length === 13) digits = "0" + digits.slice(3);
  return /^0\d{10}$/.test(digits) ? digits : "";
}
export function requestId(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  const prefix = value("year") + value("month") + value("day") + value("hour") + value("minute");
  return prefix + randomUUID().replace(/-/g, "").slice(0, 12);
}
export function serviceAllowed(category: string, serviceId: string): boolean {
  return Object.prototype.hasOwnProperty.call(CATALOG, category) &&
    (CATALOG as Record<string, readonly { id: string; label: string }[]>)[category].some(item => item.id === serviceId);
}
function providerTransaction(body: ProviderBody): Record<string, unknown> {
  const content = record(body.content);
  return record(content.transactions ?? content.transaction ?? content);
}
export function providerState(body: ProviderBody): BillStatus {
  const tx = providerTransaction(body);
  const status = String(tx.status ?? body.status ?? body.response_description ?? "").toLowerCase();
  const code = String(body.code ?? body.responseCode ?? "");
  if (["delivered","success","successful","completed"].includes(status) || code === "000") return "success";
  if (["reversed","refunded"].includes(status)) return "reversed";
  if (["failed","declined","cancelled","canceled"].includes(status)) return "failed";
  if (["pending","processing","queued","initiated"].includes(status) || code === "099") return "pending";
  return "unknown";
}
function providerTransactionId(body: ProviderBody): string | null {
  const tx = providerTransaction(body);
  const candidate = tx.transactionId ?? tx.transaction_id ?? tx.transactionReference ?? body.transactionId;
  return typeof candidate === "string" || typeof candidate === "number" ? String(candidate).slice(0, 100) : null;
}
function derivePin(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(pin, salt, 64, (error, derived) => error ? reject(error) : resolve(derived as Buffer));
  });
}
async function verifyPin(client: PoolClient, userId: string, pin: string): Promise<"verified" | "missing" | "locked" | "invalid"> {
  const result = await client.query(
    "SELECT pin_salt, pin_hash, failed_attempts, locked_until FROM public.fp_transaction_pins WHERE user_id = $1 FOR UPDATE",
    [userId]
  );
  if (result.rowCount !== 1) return "missing";
  const saved = result.rows[0];
  if (saved.locked_until && new Date(saved.locked_until).getTime() > Date.now()) return "locked";
  const derived = await derivePin(pin, saved.pin_salt);
  if (derived.length !== saved.pin_hash.length || !timingSafeEqual(derived, saved.pin_hash)) {
    const attempts = Math.min(5, Number(saved.failed_attempts) + 1);
    await client.query("UPDATE public.fp_transaction_pins SET failed_attempts = $2, locked_until = CASE WHEN $2 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END, updated_at = NOW() WHERE user_id = $1", [userId, attempts]);
    return attempts >= 5 ? "locked" : "invalid";
  }
  await client.query("UPDATE public.fp_transaction_pins SET failed_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE user_id = $1", [userId]);
  return "verified";
}
function classifyAndReturn(body: ProviderBody): BillStatus {
  return providerState(body);
}
async function verifyElectricity(cfg: Config, serviceId: string, reference: string, meterType: string): Promise<{ valid: boolean; name: string; address: string; body: ProviderBody }> {
  const response = await providerRequest(cfg, "POST", "/merchant-verify", {
    billersCode: reference, serviceID: serviceId, type: meterType
  });
  const content = record(response.body.content);
  const details = record(content.transactions ?? content);
  const code = String(response.body.code ?? "");
  const name = String(details.Customer_Name ?? details.customer_name ?? details.name ?? "").trim();
  const address = String(details.Address ?? details.address ?? "").trim();
  const valid = response.ok && (code === "000" || response.body.response_description === "000") &&
    (name.length > 0 || Object.keys(details).length > 0);
  return { valid, name: name.slice(0, 160), address: address.slice(0, 240), body: response.body };
}
async function reconcile(pool: Pool, bill: BillRow, state: BillStatus, body: ProviderBody): Promise<BillStatus> {
  const txData = providerTransaction(body);
  const providerId = providerTransactionId(body);
  const providerCode = String(body.code ?? body.responseCode ?? "").slice(0, 32);
  const providerStatus = String(txData.status ?? body.response_description ?? "").slice(0, 80);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<BillRow>(
      "SELECT transaction_id, user_id, account_id, idempotency_key, request_id, category, service_id, variation_code, customer_reference, customer_phone, amount_minor::text AS amount_minor, status FROM public.fp_vtpass_bill_payments WHERE request_id = $1 FOR UPDATE",
      [bill.request_id]
    );
    if (locked.rowCount !== 1) throw new Error("VTPASS_BILL_NOT_FOUND");
    const saved = locked.rows[0];
    const transaction = await client.query("SELECT status FROM public.fp_ledger_transactions WHERE id = $1 FOR UPDATE", [saved.transaction_id]);
    if (transaction.rowCount !== 1) throw new Error("VTPASS_LEDGER_TRANSACTION_NOT_FOUND");
    const current = String(saved.status);
    if (current === "success" && state === "success") {
      await client.query("UPDATE public.fp_vtpass_bill_payments SET provider_transaction_id = COALESCE($2, provider_transaction_id), provider_code = NULLIF($3,''), provider_status = NULLIF($4,''), verified_at = COALESCE(verified_at,NOW()), updated_at = NOW() WHERE request_id = $1", [bill.request_id, providerId, providerCode, providerStatus]);
      await client.query("COMMIT");
      return "success";
    }
    if (current === "failed" || current === "reversed") {
      await client.query("COMMIT");
      return current as BillStatus;
    }
    if (state === "success") {
      if (transaction.rows[0].status !== "pending") throw new Error("VTPASS_LEDGER_STATE_REQUIRES_RECONCILIATION");
      const existing = await client.query("SELECT COUNT(*)::int AS count FROM public.fp_ledger_entries WHERE transaction_id = $1", [saved.transaction_id]);
      if (Number(existing.rows[0]?.count ?? 0) !== 0) throw new Error("VTPASS_LEDGER_ENTRIES_REQUIRE_RECONCILIATION");
      const clearing = await client.query("SELECT id FROM public.fp_accounts WHERE account_type = 'system' AND currency = 'NGN' AND system_account_role = 'vtpass_ngn_clearing' AND status = 'active' FOR UPDATE");
      if (clearing.rowCount !== 1) throw new Error("VTPASS_CLEARING_ACCOUNT_NOT_CONFIGURED");
      await client.query("INSERT INTO public.fp_ledger_entries (transaction_id, account_id, amount_minor, currency) VALUES ($1,$2,$3,'NGN'),($1,$4,$5,'NGN')", [
        saved.transaction_id, saved.account_id, (-BigInt(saved.amount_minor)).toString(), clearing.rows[0].id, saved.amount_minor
      ]);
      const posted = await client.query("UPDATE public.fp_ledger_transactions SET status = 'posted', posted_at = NOW() WHERE id = $1 AND status = 'pending'", [saved.transaction_id]);
      if (posted.rowCount !== 1) throw new Error("VTPASS_LEDGER_POST_FAILED");
      await client.query("UPDATE public.fp_vtpass_bill_payments SET status = 'success', provider_transaction_id = COALESCE($2,provider_transaction_id), provider_code = NULLIF($3,''), provider_status = NULLIF($4,''), status_note = NULL, verified_at = NOW(), updated_at = NOW() WHERE request_id = $1", [bill.request_id, providerId, providerCode, providerStatus]);
      await client.query("COMMIT");
      return "success";
    }
    if (state === "failed") {
      if (transaction.rows[0].status !== "pending") throw new Error("VTPASS_FAILURE_AFTER_POST_REQUIRES_RECONCILIATION");
      await client.query("UPDATE public.fp_ledger_transactions SET status = 'failed' WHERE id = $1 AND status = 'pending'", [saved.transaction_id]);
      await client.query("UPDATE public.fp_vtpass_bill_payments SET status = 'failed', provider_transaction_id = COALESCE($2,provider_transaction_id), provider_code = NULLIF($3,''), provider_status = NULLIF($4,''), status_note = 'VTpass confirmed that the bill request did not complete.', verified_at = NOW(), updated_at = NOW() WHERE request_id = $1", [bill.request_id, providerId, providerCode, providerStatus]);
      await client.query("COMMIT");
      return "failed";
    }
    if (state === "reversed" && transaction.rows[0].status === "posted") {
      const reversalKey = "vtpass-bill-reversal:" + saved.transaction_id;
      const prior = await client.query("SELECT id,status FROM public.fp_ledger_transactions WHERE idempotency_key = $1 FOR UPDATE", [reversalKey]);
      let reversalId = "";
      if (prior.rowCount === 1) reversalId = String(prior.rows[0].id);
      else {
        const inserted = await client.query("INSERT INTO public.fp_ledger_transactions (idempotency_key,transaction_type,status,description) VALUES ($1,'vtpass_bill_reversal','pending','VTpass confirmed bill reversal') RETURNING id", [reversalKey]);
        reversalId = String(inserted.rows[0].id);
      }
      const clearing = await client.query("SELECT id FROM public.fp_accounts WHERE account_type = 'system' AND currency = 'NGN' AND system_account_role = 'vtpass_ngn_clearing' AND status = 'active' FOR UPDATE");
      if (clearing.rowCount !== 1) throw new Error("VTPASS_CLEARING_ACCOUNT_NOT_CONFIGURED");
      const entries = await client.query("SELECT account_id::text,SUM(amount_minor)::text AS amount_minor,COUNT(*)::int AS count FROM public.fp_ledger_entries WHERE transaction_id = $1 GROUP BY account_id", [reversalId]);
      if (entries.rowCount === 0) {
        await client.query("INSERT INTO public.fp_ledger_entries (transaction_id,account_id,amount_minor,currency) VALUES ($1,$2,$3,'NGN'),($1,$4,$5,'NGN')", [reversalId, saved.account_id, saved.amount_minor, clearing.rows[0].id, (-BigInt(saved.amount_minor)).toString()]);
      } else if (entries.rowCount !== 2) throw new Error("VTPASS_REVERSAL_LEDGER_REQUIRES_RECONCILIATION");
      const posted = await client.query("UPDATE public.fp_ledger_transactions SET status = 'posted',posted_at = NOW() WHERE id = $1 AND status = 'pending'", [reversalId]);
      if (posted.rowCount !== 1 && prior.rowCount === 0) throw new Error("VTPASS_REVERSAL_POST_FAILED");
      await client.query("UPDATE public.fp_vtpass_bill_payments SET status = 'reversed', provider_code = NULLIF($2,''), provider_status = NULLIF($3,''), status_note = 'Provider confirmed a bill reversal and the customer wallet was credited back.', verified_at = NOW(), updated_at = NOW() WHERE request_id = $1", [bill.request_id, providerCode, providerStatus]);
      await client.query("COMMIT");
      return "reversed";
    }
    const next = state === "pending" ? "pending" : "unknown";
    await client.query("UPDATE public.fp_vtpass_bill_payments SET status = $2, provider_transaction_id = COALESCE($3,provider_transaction_id), provider_code = NULLIF($4,''), provider_status = NULLIF($5,''), status_note = 'Provider has not yet returned a final bill-payment status. Funds remain reserved.', updated_at = NOW() WHERE request_id = $1", [bill.request_id, next, providerId, providerCode, providerStatus]);
    await client.query("COMMIT");
    return next;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function createVtpassBillsHandler(options: Options) {
  const { pool, jwks, issuer, audience } = options;
  return async function handleVtpassBills(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const supported =
      (req.method === "GET" && ["/customer/bills/catalog", "/customer/bills/status"].includes(path)) ||
      (req.method === "POST" && ["/customer/bills/validate", "/customer/bills/purchase"].includes(path));
    if (!supported) return false;
    if (!pool || !jwks || !issuer || !audience) {
      send(res, 503, { error: "VTPASS_BILLS_SERVICE_NOT_CONFIGURED" }); return true;
    }
    let userId: string | null;
    try {
      userId = await authenticate(pool, jwks, issuer, audience, req);
      if (!userId) {
        send(res, req.headers.authorization ? 403 : 401, { error: req.headers.authorization ? "ACTIVE_VERIFIED_CUSTOMER_REQUIRED" : "AUTHENTICATION_REQUIRED" });
        return true;
      }
    } catch (error) {
      send(res, jwtError(error) ? 401 : 503, { error: jwtError(error) ? "INVALID_SESSION" : "VTPASS_AUTH_UNAVAILABLE" });
      return true;
    }
    const cfg = config();
    if (!cfg) {
      send(res, 503, { error: "VTPASS_PROVIDER_NOT_CONFIGURED", message: "VTpass sandbox/live credentials and the matching environment switch are required on the API service." });
      return true;
    }

    if (req.method === "GET" && path === "/customer/bills/catalog") {
      const category = url.searchParams.get("category") ?? "";
      if (!Object.prototype.hasOwnProperty.call(CATALOG, category)) {
        send(res, 400, { error: "INVALID_BILL_CATEGORY" }); return true;
      }
      const services = CATALOG[category as keyof typeof CATALOG];
      const serviceId = url.searchParams.get("serviceID") ?? "";
      if (serviceId && !serviceAllowed(category, serviceId)) {
        send(res, 400, { error: "UNSUPPORTED_BILL_SERVICE" }); return true;
      }
      let variations: unknown[] = [];
      if (serviceId && (category === "data" || category === "electricity")) {
        try {
          const response = await providerRequest(cfg, "GET", "/service-variations?serviceID=" + encodeURIComponent(serviceId));
          const content = record(response.body.content);
          const candidates = content.varations ?? content.variations;
          if (response.ok && Array.isArray(candidates)) {
            variations = candidates.slice(0, 100).map(item => {
              const row = record(item);
              return {
                code: String(row.variation_code ?? row.variationCode ?? "").slice(0, 80),
                name: String(row.name ?? row.variation_name ?? "").slice(0, 120),
                amount: String(row.variation_amount ?? row.amount ?? "").slice(0, 24)
              };
            }).filter(item => item.code && item.name);
          }
        } catch {
          send(res, 503, { error: "VTPASS_CATALOG_UNAVAILABLE" }); return true;
        }
      }
      send(res, 200, { category, services, variations, environment: cfg.environment });
      return true;
    }

    if (req.method === "POST" && path === "/customer/bills/validate") {
      let input: Record<string, unknown>;
      try { input = await readJson(req); }
      catch (error) { send(res, error instanceof Error && error.message === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: error instanceof Error ? error.message : "INVALID_PAYLOAD" }); return true; }
      if (Object.keys(input).some(key => !["serviceID","customerReference","meterType"].includes(key))) {
        send(res, 400, { error: "UNSUPPORTED_VALIDATION_FIELD" }); return true;
      }
      const serviceId = typeof input.serviceID === "string" ? input.serviceID : "";
      const reference = typeof input.customerReference === "string" ? input.customerReference.trim() : "";
      const meterType = typeof input.meterType === "string" ? input.meterType.toLowerCase() : "";
      if (!serviceAllowed("electricity", serviceId) || !/^[0-9A-Za-z-]{5,30}$/.test(reference) || !["prepaid","postpaid"].includes(meterType)) {
        send(res, 400, { error: "INVALID_ELECTRICITY_METER_DETAILS" }); return true;
      }
      try {
        const result = await verifyElectricity(cfg, serviceId, reference, meterType);
        if (!result.valid) {
          send(res, 422, { verified: false, error: "ELECTRICITY_METER_NOT_VERIFIED", providerCode: String(result.body.code ?? "") });
          return true;
        }
        const details = record(record(result.body.content).transactions ?? result.body.content);
        send(res, 200, {
          verified: true, customerReference: reference, serviceID: serviceId, meterType,
          customerName: result.name || String(details.Customer_Name ?? details.customer_name ?? "Verified customer").slice(0, 160),
          address: result.address, environment: cfg.environment
        });
        return true;
      } catch {
        send(res, 503, { error: "VTPASS_METER_VERIFICATION_UNAVAILABLE" }); return true;
      }
    }

    if (req.method === "GET" && path === "/customer/bills/status") {
      const request = url.searchParams.get("requestId")?.trim() ?? "";
      if (!/^\d{12,40}$/.test(request)) { send(res, 400, { error: "VALID_REQUEST_ID_REQUIRED" }); return true; }
      try {
        const found = await pool.query<BillRow>(
          "SELECT transaction_id,user_id,account_id,idempotency_key,request_id,category,service_id,variation_code,customer_reference,customer_phone,amount_minor::text AS amount_minor,status FROM public.fp_vtpass_bill_payments WHERE request_id = $1 AND user_id = $2 LIMIT 1",
          [request, userId]
        );
        if (found.rowCount !== 1) { send(res, 404, { error: "BILL_PAYMENT_NOT_FOUND" }); return true; }
        const bill = found.rows[0];
        if (["success","failed","reversed"].includes(bill.status)) {
          send(res, 200, { requestId: bill.request_id, status: bill.status, final: true, amountMinor: bill.amount_minor });
          return true;
        }
        const result = await providerRequest(cfg, "POST", "/requery", { request_id: bill.request_id });
        if (!result.ok) {
          send(res, 202, { requestId: bill.request_id, status: bill.status, final: false, message: "Provider status is not available. Funds remain reserved." });
          return true;
        }
        const finalStatus = await reconcile(pool, bill, providerState(result.body), result.body);
        send(res, 200, { requestId: bill.request_id, status: finalStatus, final: ["success","failed","reversed"].includes(finalStatus), amountMinor: bill.amount_minor });
        return true;
      } catch (error) {
        console.error("FlowPay VTpass status reconciliation failed:", error instanceof Error ? error.message : "unknown error");
        send(res, 503, { error: "VTPASS_STATUS_UNAVAILABLE" }); return true;
      }
    }

    if (req.method === "POST" && path === "/customer/bills/purchase") {
      let input: Record<string, unknown>;
      try { input = await readJson(req); }
      catch (error) { send(res, error instanceof Error && error.message === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: error instanceof Error ? error.message : "INVALID_PAYLOAD" }); return true; }
      if (Object.keys(input).some(key => !["category","serviceID","variationCode","customerReference","phone","meterType","amountMinor","transactionPin","idempotencyKey"].includes(key))) {
        send(res, 400, { error: "UNSUPPORTED_BILL_PAYMENT_FIELD" }); return true;
      }
      const category = typeof input.category === "string" ? input.category : "";
      const serviceId = typeof input.serviceID === "string" ? input.serviceID : "";
      const variationCode = typeof input.variationCode === "string" ? input.variationCode.trim() : "";
      const customerReference = typeof input.customerReference === "string" ? input.customerReference.trim() : "";
      const phone = normalizePhone(input.phone);
      const meterType = typeof input.meterType === "string" ? input.meterType.toLowerCase() : "";
      const idempotencyKey = input.idempotencyKey;
      if (!serviceAllowed(category, serviceId) || !validUuid(idempotencyKey) || !phone ||
          typeof input.transactionPin !== "string" || !/^\d{6}$/.test(input.transactionPin)) {
        send(res, 400, { error: "INVALID_BILL_PAYMENT_DETAILS" }); return true;
      }
      if (category === "electricity" && (!/^[0-9A-Za-z-]{5,30}$/.test(customerReference) || !["prepaid","postpaid"].includes(meterType))) {
        send(res, 400, { error: "INVALID_ELECTRICITY_METER_DETAILS" }); return true;
      }
      if (category === "data" && !/^[A-Za-z0-9_-]{1,80}$/.test(variationCode)) {
        send(res, 400, { error: "DATA_BUNDLE_REQUIRED" }); return true;
      }
      if (category === "airtime" && !amountMinor(input.amountMinor)) {
        send(res, 400, { error: "VALID_AIRTIME_AMOUNT_REQUIRED" }); return true;
      }

      let amount = typeof input.amountMinor === "string" ? input.amountMinor : "";
      if (category === "data") {
        try {
          const catalog = await providerRequest(cfg, "GET", "/service-variations?serviceID=" + encodeURIComponent(serviceId));
          const content = record(catalog.body.content);
          const variations = content.varations ?? content.variations;
          const list = Array.isArray(variations) ? variations.map(record) : [];
          const selected = list.find(item => String(item.variation_code ?? item.variationCode ?? "") === variationCode);
          const price = Number(selected?.variation_amount ?? selected?.amount);
          if (!catalog.ok || !selected || !Number.isFinite(price) || price <= 0 || price > 1000000) {
            send(res, 422, { error: "DATA_BUNDLE_NOT_AVAILABLE" }); return true;
          }
          amount = String(Math.round(price * 100));
        } catch {
          send(res, 503, { error: "VTPASS_DATA_CATALOG_UNAVAILABLE" }); return true;
        }
      }
      if (category === "electricity") {
        if (!amountMinor(amount)) { send(res, 400, { error: "VALID_ELECTRICITY_AMOUNT_REQUIRED" }); return true; }
        try {
          const verified = await verifyElectricity(cfg, serviceId, customerReference, meterType);
          if (!verified.valid) { send(res, 422, { error: "ELECTRICITY_METER_NOT_VERIFIED" }); return true; }
        } catch {
          send(res, 503, { error: "ELECTRICITY_METER_VERIFICATION_UNAVAILABLE" }); return true;
        }
      }
      if (!amountMinor(amount) || BigInt(amount) > 10000000000n) {
        send(res, 400, { error: "BILL_AMOUNT_OUT_OF_RANGE" }); return true;
      }

      const dbKey = "vtpass-bill:" + userId + ":" + idempotencyKey;
      const request = requestId();
      const client = await pool.connect();
      let bill: BillRow | null = null;
      try {
        await client.query("BEGIN");
        const prior = await client.query<BillRow>(
          "SELECT transaction_id,user_id,account_id,idempotency_key,request_id,category,service_id,variation_code,customer_reference,customer_phone,amount_minor::text AS amount_minor,status FROM public.fp_vtpass_bill_payments WHERE idempotency_key = $1 LIMIT 1 FOR UPDATE",
          [dbKey]
        );
        if (prior.rowCount === 1) {
          const saved = prior.rows[0];
          const same = saved.category === category && saved.service_id === serviceId &&
            saved.customer_reference === customerReference && saved.customer_phone === phone &&
            saved.amount_minor === amount && saved.variation_code === (variationCode || null);
          await client.query("COMMIT");
          if (!same) { send(res, 409, { error: "BILL_IDEMPOTENCY_KEY_REUSED" }); return true; }
          send(res, 200, { requestId: saved.request_id, status: saved.status, duplicate: true, final: ["success","failed","reversed"].includes(saved.status), amountMinor: saved.amount_minor });
          return true;
        }
        const pin = await verifyPin(client, userId, input.transactionPin as string);
        if (pin !== "verified") {
          await client.query("COMMIT");
          const code = pin === "missing" ? "TRANSACTION_PIN_SETUP_REQUIRED" : pin === "locked" ? "TRANSACTION_PIN_TEMPORARILY_LOCKED" : "INVALID_TRANSACTION_PIN";
          send(res, pin === "missing" ? 403 : pin === "locked" ? 429 : 401, { error: code });
          return true;
        }
        const wallets = await client.query(
          "SELECT id,status FROM public.fp_accounts WHERE user_id = $1 AND account_type = 'customer' AND currency = 'NGN' ORDER BY id FOR UPDATE",
          [userId]
        );
        if (wallets.rowCount !== 1 || wallets.rows[0].status !== "active") {
          await client.query("ROLLBACK"); send(res, 409, { error: "ACTIVE_NGN_WALLET_REQUIRED" }); return true;
        }
        const walletId = String(wallets.rows[0].id);
        const [balanceRows, heldRows] = await Promise.all([
          client.query("SELECT COALESCE(SUM(entry.amount_minor),0)::text AS amount_minor FROM public.fp_ledger_entries entry JOIN public.fp_ledger_transactions tx ON tx.id = entry.transaction_id WHERE entry.account_id = $1 AND entry.currency = 'NGN' AND tx.status = 'posted'", [walletId]),
          client.query("SELECT COALESCE(SUM(amount_minor),0)::text AS amount_minor FROM public.fp_vtpass_bill_payments WHERE account_id = $1 AND status IN ('initiating','pending','unknown')", [walletId])
        ]);
        const available = BigInt(balanceRows.rows[0]?.amount_minor ?? "0") - BigInt(heldRows.rows[0]?.amount_minor ?? "0");
        if (available < BigInt(amount)) {
          await client.query("ROLLBACK"); send(res, 409, { error: "INSUFFICIENT_AVAILABLE_BALANCE", availableMinor: available.toString() }); return true;
        }
        const transaction = await client.query(
          "INSERT INTO public.fp_ledger_transactions (idempotency_key,transaction_type,status,description) VALUES ($1,'vtpass_bill_payment','pending','VTpass NGN bill payment') RETURNING id",
          [dbKey]
        );
        const transactionId = String(transaction.rows[0].id);
        await client.query(
          "INSERT INTO public.fp_vtpass_bill_payments (transaction_id,user_id,account_id,idempotency_key,request_id,category,service_id,variation_code,customer_reference,customer_phone,amount_minor,status) VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,''),$9,$10,$11,'initiating')",
          [transactionId, userId, walletId, dbKey, request, category, serviceId, variationCode, customerReference, phone, amount]
        );
        await client.query("COMMIT");
        bill = {
          transaction_id: transactionId, user_id: userId, account_id: walletId, idempotency_key: dbKey,
          request_id: request, category, service_id: serviceId, variation_code: variationCode || null,
          customer_reference: customerReference, customer_phone: phone, amount_minor: amount, status: "initiating"
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        console.error("FlowPay VTpass bill reservation failed:", error instanceof Error ? error.message : "database error");
        send(res, 503, { error: "BILL_PAYMENT_RESERVATION_UNAVAILABLE" }); return true;
      } finally {
        client.release();
      }
      if (!bill) { send(res, 503, { error: "BILL_PAYMENT_RESERVATION_UNAVAILABLE" }); return true; }

      const payload: Record<string, unknown> = {
        request_id: bill.request_id, serviceID: bill.service_id, phone: bill.customer_phone,
        billersCode: bill.customer_phone, amount: nairaAmount(bill.amount_minor)
      };
      if (category === "data") {
        payload.variation_code = bill.variation_code;
        payload.billersCode = bill.customer_phone;
      } else if (category === "electricity") {
        payload.variation_code = meterType;
        payload.billersCode = bill.customer_reference;
      }
      try {
        const response = await providerRequest(cfg, "POST", "/pay", payload);
        const classified = providerState(response.body);
        const state = response.ok ? classified : (classified === "success" || classified === "failed" ? "unknown" : classified);
        const result = await reconcile(pool, bill, state, response.body);
        send(res, result === "success" ? 201 : result === "failed" ? 502 : 202, {
          requestId: bill.request_id, status: result, final: ["success","failed","reversed"].includes(result),
          amountMinor: bill.amount_minor, currency: "NGN", environment: cfg.environment,
          message: result === "success"
            ? "VTpass reported successful delivery and FlowPay posted the matching wallet debit."
            : result === "failed"
              ? "VTpass reported that this bill payment failed. No customer debit was posted."
              : "VTpass has not confirmed a final result. Funds remain reserved; requery this request before retrying."
        });
        return true;
      } catch (error) {
        console.error("FlowPay VTpass purchase outcome is unconfirmed:", error instanceof Error ? error.message : "network error");
        await pool.query("UPDATE public.fp_vtpass_bill_payments SET status = 'unknown', status_note = 'The provider response was lost or could not be confirmed. Requery before retrying.', updated_at = NOW() WHERE request_id = $1 AND status = 'initiating'", [bill.request_id]).catch(() => undefined);
        send(res, 202, { requestId: bill.request_id, status: "unknown", final: false, amountMinor: bill.amount_minor, currency: "NGN", message: "Payment outcome is unknown. The amount remains reserved. Check this request's status before retrying." });
        return true;
      }
    }
    return false;
  };
}
