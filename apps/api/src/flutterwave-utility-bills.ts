import { randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { createRemoteJWKSet } from "jose";
import { verifyFlowPayToken } from "./auth-tokens.js";
import { productionFaceVerificationAllowed } from "./customer-security.js";

type Options = {
  pool: Pool | null;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
  issuer?: string;
  audience?: string;
};
type Config = { environment: "test" | "live"; secretKey: string };
type ProviderBody = Record<string, unknown>;
type UtilityItem = {
  item_code: string;
  name: string;
  label_name: string;
  amount_minor: string | null;
  fee_minor: string;
  minimum_minor: string | null;
  maximum_minor: string | null;
  is_resolvable: boolean;
};
type BillRow = {
  transaction_id: string;
  user_id: string;
  account_id: string;
  idempotency_key: string;
  request_id: string;
  category_code: string;
  biller_code: string;
  biller_name: string;
  item_code: string;
  item_name: string;
  customer_id: string;
  amount_minor: string;
  bill_amount_minor: string;
  provider_fee_minor: string;
  status: "initiating" | "pending" | "unknown" | "success" | "failed";
  flw_tx_ref: string | null;
  flw_reference: string | null;
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function safeString(value: unknown, max = 160): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function jwtError(error: unknown): boolean {
  return error instanceof Error && ["JWTExpired", "JWSSignatureVerificationFailed", "JWTClaimValidationFailed", "JWSInvalid", "JWTInvalid"].includes(error.name);
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
function validCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{2,40}$/.test(value);
}
function validUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function amountMinor(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{0,11}$/.test(value) && BigInt(value) <= 10_000_000_000n;
}
function decimalToMinor(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = /^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,4}))?$/.exec(String(value).trim());
  if (!match) return null;
  const fractional = match[2] ?? "";
  if (fractional.length > 2 && /[1-9]/.test(fractional.slice(2))) return null;
  const result = BigInt(match[1]) * 100n + BigInt(fractional.slice(0, 2).padEnd(2, "0"));
  return result <= 10_000_000_000n ? result.toString() : null;
}
function positiveDecimalToMinor(value: unknown): string | null {
  const amount = decimalToMinor(value);
  return amount && BigInt(amount) > 0n ? amount : null;
}
export function flutterwaveBillWalletDebitMinor(billAmountMinor: string, feeMinor: string): string {
  if (!/^[1-9][0-9]{0,11}$/.test(billAmountMinor) || !/^[0-9]{1,11}$/.test(feeMinor)) {
    throw new Error("INVALID_FLUTTERWAVE_BILL_AMOUNT");
  }
  const total = BigInt(billAmountMinor) + BigInt(feeMinor);
  if (total > 10_000_000_000n) throw new Error("FLUTTERWAVE_BILL_TOTAL_OUT_OF_RANGE");
  return total.toString();
}
function minorToNaira(value: string): string {
  const amount = BigInt(value);
  return (amount / 100n).toString() + "." + (amount % 100n).toString().padStart(2, "0");
}
function isElectricityBiller(value: unknown, code?: unknown): boolean {
  const billerCode = safeString(code, 12).toUpperCase();
  const documentedElectricityCodes = new Set(["BIL112", "BIL113", "BIL114", "BIL115", "BIL116", "BIL117", "BIL118", "BIL119", "BIL120", "BIL204"]);
  return documentedElectricityCodes.has(billerCode) || /\b(electric|electricity|disco|power)\b/i.test(safeString(value, 200));
}
function utilityCategory(value: unknown): boolean {
  return safeString(value, 60).toUpperCase() === "UTILITYBILLS";
}
function providerState(body: ProviderBody): "success" | "failed" | "pending" | "unknown" {
  const data = record(body.data);
  const state = safeString(data.status ?? data.state ?? body.status, 40).toLowerCase();
  if (["successful", "success", "completed", "delivered", "approved"].includes(state)) return "success";
  if (["failed", "failure", "declined", "rejected", "cancelled", "canceled"].includes(state)) return "failed";
  if (["pending", "processing", "initiated", "queued"].includes(state)) return "pending";
  return "unknown";
}
export function resolveFlutterwaveBillsConfig(): Config | null {
  const secretKey = process.env.FLW_SECRET_KEY?.trim() ?? "";
  const environment = process.env.FLW_BILLS_ENVIRONMENT?.trim().toLowerCase();
  if (environment === "test" && process.env.NODE_ENV !== "production" &&
      process.env.FLOWPAY_RUNTIME_ENV === "development" && secretKey.startsWith("FLWSECK_TEST-")) {
    return { environment: "test", secretKey };
  }
  if (environment === "live" && process.env.NODE_ENV === "production" &&
      process.env.FLW_BILLS_LIVE_ENABLED === "true" && secretKey.startsWith("FLWSECK_LIVE-")) {
    return { environment: "live", secretKey };
  }
  return null;
}
export function classifyFlutterwaveBillStatus(
  body: ProviderBody,
  expectedTxRef: string,
  expectedAmountMinor: string,
  expectedFeeMinor?: string
): "success" | "failed" | "pending" | "unknown" {
  const data = record(body.data);
  const explicit = providerState(body);
  if (explicit === "failed" || explicit === "pending") return explicit;
  const txRef = safeString(data.tx_ref, 120);
  const returnedAmount = decimalToMinor(data.amount);
  const returnedFee = decimalToMinor(data.fee);
  const currency = safeString(data.currency, 8).toUpperCase();
  const amountMatches = txRef === expectedTxRef && returnedAmount === expectedAmountMinor &&
    (expectedFeeMinor === undefined || returnedFee === expectedFeeMinor) &&
    (!currency || currency === "NGN");
  if ((explicit === "success" || safeString(body.status, 30).toLowerCase() === "success") && amountMatches) {
    return "success";
  }
  return "unknown";
}
async function authenticate(pool: Pool, jwks: ReturnType<typeof createRemoteJWKSet>, issuer: string, audience: string | undefined, req: IncomingMessage): Promise<string | null> {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  const { payload } = await verifyFlowPayToken(token, jwks, {
    algorithms: ["EdDSA"], issuer, ...(audience ? { audience } : {})
  });
  if (typeof payload.sub !== "string" || !payload.sub) return null;
  const result = await pool.query(
    'SELECT app_user.id FROM neon_auth."user" AS auth_user JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text WHERE auth_user.id::text = $1 AND auth_user."emailVerified" = true AND app_user.status = \'active\' AND app_user.role IN (\'customer\',\'super_admin\') LIMIT 1',
    [payload.sub]
  );
  return result.rowCount === 1 ? String(result.rows[0].id) : null;
}
async function providerRequest(cfg: Config, method: "GET" | "POST", endpoint: string, payload?: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: ProviderBody }> {
  const response = await fetch("https://api.flutterwave.com/v3" + endpoint, {
    method,
    headers: {
      Authorization: "Bearer " + cfg.secretKey,
      Accept: "application/json",
      ...(method === "POST" ? { "Content-Type": "application/json" } : {})
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(15_000)
  });
  const body = record(await response.json().catch(() => null));
  return { ok: response.ok, status: response.status, body };
}
function providerData(body: ProviderBody): Record<string, unknown> {
  return record(body.data);
}
function providerRows(body: ProviderBody): Record<string, unknown>[] {
  return Array.isArray(body.data) ? body.data.map(record) : [];
}
async function getElectricityBiller(cfg: Config, categoryCode: string, billerCode: string): Promise<Record<string, unknown> | null> {
  if (!utilityCategory(categoryCode) || !validCode(billerCode)) return null;
  const response = await providerRequest(cfg, "GET", "/bills/" + encodeURIComponent(categoryCode) + "/billers?country=NG");
  if (!response.ok || response.body.status !== "success") throw new Error("FLUTTERWAVE_BILLER_CATALOG_UNAVAILABLE");
  const biller = providerRows(response.body).find(row =>
    safeString(row.biller_code, 40) === billerCode && isElectricityBiller(row.name ?? row.short_name ?? row.description, row.biller_code));
  return biller ?? null;
}
async function getUtilityItem(cfg: Config, billerCode: string, itemCode: string): Promise<UtilityItem | null> {
  if (!validCode(billerCode) || !validCode(itemCode)) return null;
  const response = await providerRequest(cfg, "GET", "/billers/" + encodeURIComponent(billerCode) + "/items");
  if (!response.ok || response.body.status !== "success") throw new Error("FLUTTERWAVE_BILL_ITEMS_UNAVAILABLE");
  const row = providerRows(response.body).find(item => safeString(item.item_code, 40) === itemCode);
  if (!row) return null;
  const amount = decimalToMinor(row.amount);
  const fee = decimalToMinor(row.fee) ?? "0";
  return {
    item_code: itemCode,
    name: safeString(row.name ?? row.short_name, 160) || itemCode,
    label_name: safeString(row.label_name, 100) || "Meter number",
    amount_minor: amount && BigInt(amount) > 0n ? amount : null,
    fee_minor: fee,
    minimum_minor: positiveDecimalToMinor(row.minimum),
    maximum_minor: positiveDecimalToMinor(row.maximum),
    is_resolvable: row.is_resolvable === true || String(row.is_resolvable).toLowerCase() === "true"
  };
}
async function verifyPin(client: PoolClient, userId: string, pin: string): Promise<"verified" | "missing" | "locked" | "invalid"> {
  const result = await client.query(
    "SELECT pin_salt, pin_hash, failed_attempts, locked_until FROM public.fp_transaction_pins WHERE user_id = $1 FOR UPDATE",
    [userId]
  );
  if (result.rowCount !== 1) return "missing";
  const saved = result.rows[0];
  if (saved.locked_until && new Date(saved.locked_until).getTime() > Date.now()) return "locked";
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(pin, saved.pin_salt, 64, (error, value) => error ? reject(error) : resolve(value as Buffer));
  });
  if (derived.length !== saved.pin_hash.length || !timingSafeEqual(derived, saved.pin_hash)) {
    const attempts = Math.min(5, Number(saved.failed_attempts) + 1);
    await client.query(
      "UPDATE public.fp_transaction_pins SET failed_attempts=$2,locked_until=CASE WHEN $2>=5 THEN NOW()+INTERVAL '15 minutes' ELSE NULL END,updated_at=NOW() WHERE user_id=$1",
      [userId, attempts]
    );
    return attempts >= 5 ? "locked" : "invalid";
  }
  await client.query("UPDATE public.fp_transaction_pins SET failed_attempts=0,locked_until=NULL,updated_at=NOW() WHERE user_id=$1", [userId]);
  return "verified";
}
async function reconcile(pool: Pool, bill: BillRow, state: "success" | "failed" | "pending" | "unknown", provider: ProviderBody): Promise<"success" | "failed" | "pending" | "unknown"> {
  const data = providerData(provider);
  const txRef = safeString(data.tx_ref, 120) || bill.flw_tx_ref;
  const providerRef = safeString(data.flw_ref ?? data.reference, 120) || bill.flw_reference;
  const token = safeString(data.extra ?? data.token ?? data.recharge_token, 180);
  const providerStatus = safeString(data.status ?? provider.message ?? provider.status, 100);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<BillRow>(
      "SELECT transaction_id,user_id,account_id,idempotency_key,request_id,category_code,biller_code,biller_name,item_code,item_name,customer_id,amount_minor::text AS amount_minor,bill_amount_minor::text AS bill_amount_minor,provider_fee_minor::text AS provider_fee_minor,status,flw_tx_ref,flw_reference FROM public.fp_flutterwave_bill_payments WHERE request_id=$1 FOR UPDATE",
      [bill.request_id]
    );
    if (locked.rowCount !== 1) throw new Error("FLUTTERWAVE_BILL_NOT_FOUND");
    const saved = locked.rows[0];
    const transaction = await client.query<{ status: string }>("SELECT status FROM public.fp_ledger_transactions WHERE id=$1 FOR UPDATE", [saved.transaction_id]);
    if (transaction.rowCount !== 1) throw new Error("FLUTTERWAVE_BILL_LEDGER_NOT_FOUND");
    const wallet = await client.query(
      "SELECT id FROM public.fp_accounts WHERE id=$1 AND user_id=$2 AND account_type='customer' AND currency='NGN' AND status='active' FOR UPDATE",
      [saved.account_id, saved.user_id]
    );
    if (wallet.rowCount !== 1) throw new Error("FLUTTERWAVE_CUSTOMER_WALLET_NOT_ACTIVE");
    if (saved.status === "success") {
      await client.query(
        "UPDATE public.fp_flutterwave_bill_payments SET flw_tx_ref=COALESCE($2,flw_tx_ref),flw_reference=COALESCE($3,flw_reference),provider_token=COALESCE(NULLIF($4,''),provider_token),provider_status=NULLIF($5,''),updated_at=NOW() WHERE request_id=$1",
        [bill.request_id, txRef, providerRef, token, providerStatus]
      );
      await client.query("COMMIT");
      return "success";
    }
    if (saved.status === "failed") {
      await client.query("COMMIT");
      return "failed";
    }
    if (state === "success") {
      if (transaction.rows[0].status !== "pending") throw new Error("FLUTTERWAVE_BILL_LEDGER_STATE_CONFLICT");
      const priorEntries = await client.query("SELECT COUNT(*)::int AS count FROM public.fp_ledger_entries WHERE transaction_id=$1", [saved.transaction_id]);
      if (Number(priorEntries.rows[0]?.count ?? 0) !== 0) throw new Error("FLUTTERWAVE_BILL_LEDGER_RECONCILIATION_REQUIRED");
      const accounts = await client.query<{ id: string }>(
        "SELECT id FROM public.fp_accounts WHERE account_type='system' AND currency='NGN' AND system_account_role='flutterwave_ngn_clearing' AND status='active' FOR UPDATE"
      );
      if (accounts.rowCount !== 1) throw new Error("FLUTTERWAVE_CLEARING_ACCOUNT_NOT_CONFIGURED");
      const wallet = await client.query(
        "SELECT id FROM public.fp_accounts WHERE id=$1 AND user_id=$2 AND account_type='customer' AND currency='NGN' AND status='active' FOR UPDATE",
        [saved.account_id, saved.user_id]
      );
      if (wallet.rowCount !== 1) throw new Error("FLUTTERWAVE_CUSTOMER_WALLET_NOT_ACTIVE");
      await client.query(
        "INSERT INTO public.fp_ledger_entries(transaction_id,account_id,amount_minor,currency) VALUES($1,$2,$3,'NGN'),($1,$4,$5,'NGN')",
        [saved.transaction_id, saved.account_id, (-BigInt(saved.amount_minor)).toString(), accounts.rows[0].id, saved.amount_minor]
      );
      const posted = await client.query(
        "UPDATE public.fp_ledger_transactions SET status='posted',posted_at=NOW() WHERE id=$1 AND status='pending'",
        [saved.transaction_id]
      );
      if (posted.rowCount !== 1) throw new Error("FLUTTERWAVE_BILL_LEDGER_POST_FAILED");
      await client.query(
        "UPDATE public.fp_flutterwave_bill_payments SET status='success',flw_tx_ref=COALESCE($2,flw_tx_ref),flw_reference=COALESCE($3,flw_reference),provider_token=COALESCE(NULLIF($4,''),provider_token),provider_status=NULLIF($5,''),status_note=NULL,verified_at=NOW(),updated_at=NOW() WHERE request_id=$1",
        [bill.request_id, txRef, providerRef, token, providerStatus]
      );
      await client.query("COMMIT");
      return "success";
    }
    if (state === "failed") {
      if (transaction.rows[0].status !== "pending") throw new Error("FLUTTERWAVE_BILL_FAILURE_AFTER_POST");
      await client.query("UPDATE public.fp_ledger_transactions SET status='failed' WHERE id=$1 AND status='pending'", [saved.transaction_id]);
      await client.query(
        "UPDATE public.fp_flutterwave_bill_payments SET status='failed',flw_tx_ref=COALESCE($2,flw_tx_ref),flw_reference=COALESCE($3,flw_reference),provider_status=NULLIF($4,''),status_note='Flutterwave confirmed that the utility bill was not completed. No wallet debit was posted.',verified_at=NOW(),updated_at=NOW() WHERE request_id=$1",
        [bill.request_id, txRef, providerRef, providerStatus]
      );
      await client.query("COMMIT");
      return "failed";
    }
    const next = state === "pending" ? "pending" : "unknown";
    await client.query(
      "UPDATE public.fp_flutterwave_bill_payments SET status=$2,flw_tx_ref=COALESCE($3,flw_tx_ref),flw_reference=COALESCE($4,flw_reference),provider_status=NULLIF($5,''),status_note='Flutterwave has not confirmed the final bill outcome. The wallet amount remains reserved.',updated_at=NOW() WHERE request_id=$1",
      [bill.request_id, next, txRef, providerRef, providerStatus]
    );
    await client.query("COMMIT");
    return next;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
function requestId(): string { return "FPB-" + randomUUID(); }

export function createFlutterwaveUtilityBillsHandler(options: Options) {
  const { pool, jwks, issuer, audience } = options;
  return async function handleFlutterwaveUtilityBills(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const supported =
      (req.method === "POST" && path === "/webhooks/flutterwave/bills") ||
      (req.method === "GET" && [
        "/customer/flutterwave/bills/categories", "/customer/flutterwave/bills/billers",
        "/customer/flutterwave/bills/items", "/customer/flutterwave/bills/status"
      ].includes(path)) ||
      (req.method === "POST" && [
        "/customer/flutterwave/bills/validate", "/customer/flutterwave/bills/purchase"
      ].includes(path));
    if (!supported) return false;
    if (req.method === "POST" && path === "/webhooks/flutterwave/bills") {
      const cfg = resolveFlutterwaveBillsConfig();
      const secretHash = process.env.FLW_BILLS_WEBHOOK_SECRET_HASH?.trim() ?? "";
      const supplied = req.headers["verif-hash"];
      if (!pool || !cfg || !secretHash) {
        send(res, 503, { error: "FLUTTERWAVE_BILL_WEBHOOK_NOT_CONFIGURED" });
        return true;
      }
      const expectedBytes = Buffer.from(secretHash, "utf8");
      const suppliedBytes = typeof supplied === "string" ? Buffer.from(supplied, "utf8") : Buffer.alloc(0);
      if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
        send(res, 401, { error: "INVALID_FLUTTERWAVE_BILL_WEBHOOK_SIGNATURE" });
        return true;
      }
      try {
        const payload = await readJson(req);
        const data = record(payload.data);
        const reference = safeString(data.tx_ref ?? data.reference, 120);
        if (!reference) {
          send(res, 200, { received: true, processed: false, reason: "BILL_REFERENCE_MISSING" });
          return true;
        }
        const found = await pool.query<BillRow>(
          "SELECT transaction_id,user_id,account_id,idempotency_key,request_id,category_code,biller_code,biller_name,item_code,item_name,customer_id,amount_minor::text AS amount_minor,bill_amount_minor::text AS bill_amount_minor,provider_fee_minor::text AS provider_fee_minor,status,flw_tx_ref,flw_reference FROM public.fp_flutterwave_bill_payments WHERE flw_tx_ref=$1 OR flw_reference=$1 OR provider_reference=$1 LIMIT 1",
          [reference]
        );
        if (found.rowCount !== 1) {
          send(res, 200, { received: true, processed: false, reason: "FLOWPAY_BILL_NOT_FOUND" });
          return true;
        }
        const bill = found.rows[0];
        if (!bill.flw_tx_ref) {
          send(res, 200, { received: true, processed: false, reason: "PROVIDER_TRANSACTION_REFERENCE_PENDING" });
          return true;
        }
        const statusResult = await providerRequest(cfg, "GET", "/bills/" + encodeURIComponent(bill.flw_tx_ref) + "?verbose=1");
        if (!statusResult.ok) {
          send(res, 503, { error: "FLUTTERWAVE_BILL_STATUS_REQUERY_FAILED" });
          return true;
        }
        const state = classifyFlutterwaveBillStatus(statusResult.body, bill.flw_tx_ref, bill.bill_amount_minor, bill.provider_fee_minor);
        const finalState = await reconcile(pool, bill, state, statusResult.body);
        send(res, 200, { received: true, processed: ["success", "failed"].includes(finalState), requestId: bill.request_id, status: finalState });
      } catch (error) {
        console.error("FlowPay Flutterwave bill webhook processing failed:", error instanceof Error ? error.message : "unknown error");
        send(res, 503, { error: "FLUTTERWAVE_BILL_WEBHOOK_PROCESSING_UNAVAILABLE" });
      }
      return true;
    }
    if (!pool || !jwks || !issuer) {
      send(res, 503, { error: "FLUTTERWAVE_BILL_SERVICE_NOT_CONFIGURED" });
      return true;
    }
    let userId: string | null;
    try {
      userId = await authenticate(pool, jwks, issuer, audience, req);
      if (!userId) {
        send(res, req.headers.authorization ? 403 : 401, {
          error: req.headers.authorization ? "ACTIVE_VERIFIED_CUSTOMER_REQUIRED" : "AUTHENTICATION_REQUIRED"
        });
        return true;
      }
    } catch (error) {
      send(res, jwtError(error) ? 401 : 503, { error: jwtError(error) ? "INVALID_SESSION" : "FLUTTERWAVE_BILL_AUTH_UNAVAILABLE" });
      return true;
    }
    const cfg = resolveFlutterwaveBillsConfig();
    if (!cfg) {
      send(res, 503, {
        error: "FLUTTERWAVE_BILL_PROVIDER_NOT_CONFIGURED",
        message: "Configure FLW_BILLS_ENVIRONMENT and the matching Flutterwave secret key. Live bills also require FLW_BILLS_LIVE_ENABLED=true."
      });
      return true;
    }

    if (req.method === "GET" && path === "/customer/flutterwave/bills/categories") {
      try {
        const result = await providerRequest(cfg, "GET", "/top-bill-categories?country=NG");
        if (!result.ok || result.body.status !== "success") throw new Error("FLUTTERWAVE_BILL_CATEGORIES_UNAVAILABLE");
        const categories = providerRows(result.body).filter(row => utilityCategory(row.code) || /utility/i.test(safeString(row.name ?? row.description, 120)));
        send(res, 200, { categories: categories.map(row => ({
          code: safeString(row.code, 40), name: safeString(row.name, 100), description: safeString(row.description, 160)
        })).filter(row => row.code) });
      } catch (error) {
        send(res, 503, { error: error instanceof Error ? error.message : "FLUTTERWAVE_BILL_CATEGORIES_UNAVAILABLE" });
      }
      return true;
    }

    if (req.method === "GET" && path === "/customer/flutterwave/bills/billers") {
      const categoryCode = url.searchParams.get("categoryCode") ?? "";
      if (!utilityCategory(categoryCode)) {
        send(res, 400, { error: "INVALID_UTILITY_CATEGORY" }); return true;
      }
      try {
        const result = await providerRequest(cfg, "GET", "/bills/" + encodeURIComponent(categoryCode) + "/billers?country=NG");
        if (!result.ok || result.body.status !== "success") throw new Error("FLUTTERWAVE_BILLERS_UNAVAILABLE");
        const billers = providerRows(result.body).filter(row => isElectricityBiller(row.name ?? row.short_name ?? row.description));
        send(res, 200, { billers: billers.map(row => ({
          code: safeString(row.biller_code, 40), name: safeString(row.name ?? row.short_name, 160),
          description: safeString(row.description, 200), logo: safeString(row.logo, 500)
        })).filter(row => row.code && row.name) });
      } catch (error) {
        send(res, 503, { error: error instanceof Error ? error.message : "FLUTTERWAVE_BILLERS_UNAVAILABLE" });
      }
      return true;
    }

    if (req.method === "GET" && path === "/customer/flutterwave/bills/items") {
      const billerCode = url.searchParams.get("billerCode") ?? "";
      try {
        if (!validCode(billerCode)) { send(res, 400, { error: "INVALID_BILLER_CODE" }); return true; }
        const billers = await providerRequest(cfg, "GET", "/bills/UTILITYBILLS/billers?country=NG");
        const biller = providerRows(billers.body).find(row =>
          safeString(row.biller_code, 40) === billerCode && isElectricityBiller(row.name ?? row.short_name ?? row.description));
        if (!billers.ok || billers.body.status !== "success" || !biller) {
          send(res, 400, { error: "UNSUPPORTED_ELECTRICITY_BILLER" }); return true;
        }
        const response = await providerRequest(cfg, "GET", "/billers/" + encodeURIComponent(billerCode) + "/items");
        if (!response.ok || response.body.status !== "success") throw new Error("FLUTTERWAVE_BILL_ITEMS_UNAVAILABLE");
        const items = providerRows(response.body).map(row => ({
          code: safeString(row.item_code, 40),
          name: safeString(row.name ?? row.short_name, 160),
          label: safeString(row.label_name, 100) || "Meter number",
          amountMinor: decimalToMinor(row.amount),
          feeMinor: decimalToMinor(row.fee) ?? "0",
          minimumMinor: positiveDecimalToMinor(row.minimum),
          maximumMinor: positiveDecimalToMinor(row.maximum),
          resolvable: row.is_resolvable === true || String(row.is_resolvable).toLowerCase() === "true"
        })).filter(row => row.code && row.name);
        send(res, 200, { items });
      } catch (error) {
        send(res, 503, { error: error instanceof Error ? error.message : "FLUTTERWAVE_BILL_ITEMS_UNAVAILABLE" });
      }
      return true;
    }

    if (req.method === "POST" && path === "/customer/flutterwave/bills/validate") {
      let input: Record<string, unknown>;
      try { input = await readJson(req); }
      catch (error) { send(res, error instanceof Error && error.message === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: error instanceof Error ? error.message : "INVALID_PAYLOAD" }); return true; }
      const billerCode = input.billerCode;
      const itemCode = input.itemCode;
      const customerId = typeof input.customerId === "string" ? input.customerId.trim() : "";
      if (!validCode(billerCode) || !validCode(itemCode) || !/^[0-9A-Za-z+ .-]{5,40}$/.test(customerId)) {
        send(res, 400, { error: "INVALID_UTILITY_BILL_DETAILS" }); return true;
      }
      try {
        const biller = await getElectricityBiller(cfg, "UTILITYBILLS", billerCode);
        if (!biller) { send(res, 400, { error: "UNSUPPORTED_ELECTRICITY_BILLER" }); return true; }
        const item = await getUtilityItem(cfg, billerCode, itemCode);
        if (!item) { send(res, 400, { error: "UNSUPPORTED_UTILITY_BILL_ITEM" }); return true; }
        const result = await providerRequest(cfg, "GET",
          "/bill-items/" + encodeURIComponent(itemCode) + "/validate?customer=" + encodeURIComponent(customerId));
        if (!result.ok || result.body.status !== "success") {
          send(res, 422, { error: "UTILITY_CUSTOMER_VALIDATION_FAILED", message: safeString(result.body.message, 160) || "Flutterwave could not verify this meter number." });
          return true;
        }
        const data = providerData(result.body);
        const responseCode = safeString(data.response_code, 12);
        if (responseCode && responseCode !== "00") {
          send(res, 422, { error: "UTILITY_CUSTOMER_NOT_VERIFIED", message: safeString(data.response_message, 160) || "Flutterwave did not verify this meter number." });
          return true;
        }
        const minimum = positiveDecimalToMinor(data.minimum) ?? item.minimum_minor;
        const maximum = positiveDecimalToMinor(data.maximum) ?? item.maximum_minor;
        if (!item.amount_minor && (!minimum || !maximum)) {
          send(res, 422, { error: "UTILITY_BILL_AMOUNT_LIMITS_UNAVAILABLE", message: "Flutterwave did not return an allowed amount range for this bill item." });
          return true;
        }
        send(res, 200, {
          verified: true, customerName: safeString(data.name, 160),
          address: safeString(data.address, 240), minimumMinor: minimum,
          maximumMinor: maximum, feeMinor: decimalToMinor(data.fee) ?? item.fee_minor,
          itemName: item.name, label: item.label_name
        });
      } catch (error) {
        send(res, 503, { error: error instanceof Error ? error.message : "UTILITY_CUSTOMER_VALIDATION_UNAVAILABLE" });
      }
      return true;
    }

    if (req.method === "POST" && path === "/customer/flutterwave/bills/purchase") {
      if (!(await productionFaceVerificationAllowed(pool, userId))) {
        send(res, 403, { error: "FACE_VERIFICATION_REQUIRED", message: "Complete the required identity verification before paying a utility bill." });
        return true;
      }
      let input: Record<string, unknown>;
      try { input = await readJson(req); }
      catch (error) { send(res, error instanceof Error && error.message === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: error instanceof Error ? error.message : "INVALID_PAYLOAD" }); return true; }
      const billerCode = input.billerCode;
      const itemCode = input.itemCode;
      const customerId = typeof input.customerId === "string" ? input.customerId.trim() : "";
      const pin = typeof input.transactionPin === "string" ? input.transactionPin : "";
      const idempotencyKey = input.idempotencyKey;
      const requestedAmount = typeof input.amountMinor === "string" ? input.amountMinor : "";
      if (Object.keys(input).some(key => !["billerCode", "itemCode", "customerId", "amountMinor", "transactionPin", "idempotencyKey"].includes(key)) ||
          !validCode(billerCode) || !validCode(itemCode) || !/^[0-9A-Za-z+ .-]{5,40}$/.test(customerId) ||
          !amountMinor(requestedAmount) || !/^\d{6}$/.test(pin) || !validUuid(idempotencyKey)) {
        send(res, 400, { error: "INVALID_UTILITY_BILL_PAYMENT_DETAILS" }); return true;
      }
      let biller: Record<string, unknown> | null;
      let item: UtilityItem | null;
      let validation: ProviderBody;
      let providerFeeMinor = "0";
      try {
        biller = await getElectricityBiller(cfg, "UTILITYBILLS", billerCode);
        item = biller ? await getUtilityItem(cfg, billerCode, itemCode) : null;
        if (!biller || !item) { send(res, 400, { error: "UNSUPPORTED_ELECTRICITY_BILL_ITEM" }); return true; }
        const check = await providerRequest(cfg, "GET", "/bill-items/" + encodeURIComponent(itemCode) + "/validate?customer=" + encodeURIComponent(customerId));
        validation = check.body;
        const details = providerData(validation);
        if (!check.ok || validation.status !== "success" ||
            (safeString(details.response_code, 12) && safeString(details.response_code, 12) !== "00")) {
          send(res, 422, { error: "UTILITY_CUSTOMER_VALIDATION_FAILED", message: safeString(details.response_message ?? validation.message, 160) || "Verify the meter number before paying." });
          return true;
        }
        const min = positiveDecimalToMinor(details.minimum) ?? item.minimum_minor;
        const max = positiveDecimalToMinor(details.maximum) ?? item.maximum_minor;
        providerFeeMinor = decimalToMinor(details.fee) ?? item.fee_minor;
        if (item.amount_minor) {
          if (requestedAmount !== item.amount_minor) {
            send(res, 422, { error: "UTILITY_BILL_AMOUNT_MISMATCH", message: "Use the exact amount returned by Flutterwave for this bill item." }); return true;
          }
        } else if (!min || !max) {
          send(res, 422, { error: "UTILITY_BILL_AMOUNT_LIMITS_UNAVAILABLE" }); return true;
        } else if (BigInt(requestedAmount) < BigInt(min) || BigInt(requestedAmount) > BigInt(max)) {
          send(res, 422, { error: "UTILITY_BILL_AMOUNT_OUT_OF_RANGE", minimumMinor: min, maximumMinor: max }); return true;
        }
      } catch (error) {
        send(res, 503, { error: error instanceof Error ? error.message : "UTILITY_BILL_VALIDATION_UNAVAILABLE" }); return true;
      }

      let walletAmountMinor: string;
      try {
        walletAmountMinor = flutterwaveBillWalletDebitMinor(requestedAmount, providerFeeMinor);
      } catch {
        send(res, 422, { error: "UTILITY_BILL_TOTAL_OUT_OF_RANGE" }); return true;
      }
      const dbKey = "flutterwave-utility-bill:" + userId + ":" + idempotencyKey;
      const localRequestId = requestId();
      const providerReference = randomUUID();
      const client = await pool.connect();
      let bill: BillRow | null = null;
      try {
        await client.query("BEGIN");
        const prior = await client.query<BillRow>(
          "SELECT transaction_id,user_id,account_id,idempotency_key,request_id,category_code,biller_code,biller_name,item_code,item_name,customer_id,amount_minor::text AS amount_minor,bill_amount_minor::text AS bill_amount_minor,provider_fee_minor::text AS provider_fee_minor,status,flw_tx_ref,flw_reference FROM public.fp_flutterwave_bill_payments WHERE idempotency_key=$1 FOR UPDATE",
          [dbKey]
        );
        if (prior.rowCount === 1) {
          const saved = prior.rows[0];
          const same = saved.biller_code === billerCode && saved.item_code === itemCode &&
            saved.customer_id === customerId && saved.bill_amount_minor === requestedAmount;
          await client.query("COMMIT");
          if (!same) { send(res, 409, { error: "BILL_IDEMPOTENCY_KEY_REUSED" }); return true; }
          send(res, 200, { requestId: saved.request_id, status: saved.status, duplicate: true, final: ["success", "failed"].includes(saved.status), amountMinor: saved.amount_minor, billAmountMinor: saved.bill_amount_minor, feeMinor: saved.provider_fee_minor });
          return true;
        }
        const pinState = await verifyPin(client, userId, pin);
        if (pinState !== "verified") {
          await client.query("COMMIT");
          const code = pinState === "missing" ? "TRANSACTION_PIN_SETUP_REQUIRED" : pinState === "locked" ? "TRANSACTION_PIN_TEMPORARILY_LOCKED" : "INVALID_TRANSACTION_PIN";
          send(res, pinState === "missing" ? 403 : pinState === "locked" ? 429 : 401, { error: code });
          return true;
        }
        const wallets = await client.query(
          "SELECT id,status FROM public.fp_accounts WHERE user_id=$1 AND account_type='customer' AND currency='NGN' ORDER BY id FOR UPDATE",
          [userId]
        );
        if (wallets.rowCount !== 1 || wallets.rows[0].status !== "active") {
          await client.query("ROLLBACK"); send(res, 409, { error: "ACTIVE_NGN_WALLET_REQUIRED" }); return true;
        }
        const walletId = String(wallets.rows[0].id);
        const [balance, held] = await Promise.all([
          client.query(
            "SELECT COALESCE(SUM(entry.amount_minor),0)::text AS amount_minor FROM public.fp_ledger_entries entry JOIN public.fp_ledger_transactions tx ON tx.id=entry.transaction_id WHERE entry.account_id=$1 AND entry.currency='NGN' AND tx.status='posted'",
            [walletId]
          ),
          client.query(
            "SELECT COALESCE(SUM(amount_minor),0)::text AS amount_minor FROM public.fp_flutterwave_bill_payments WHERE account_id=$1 AND status IN ('initiating','pending','unknown')",
            [walletId]
          )
        ]);
        const available = BigInt(balance.rows[0]?.amount_minor ?? "0") - BigInt(held.rows[0]?.amount_minor ?? "0");
        if (available < BigInt(walletAmountMinor)) {
          await client.query("ROLLBACK"); send(res, 409, { error: "INSUFFICIENT_AVAILABLE_BALANCE", availableMinor: available.toString() }); return true;
        }
        const transaction = await client.query(
          "INSERT INTO public.fp_ledger_transactions(idempotency_key,transaction_type,status,description) VALUES($1,'flutterwave_utility_bill','pending','Flutterwave NGN utility bill payment') RETURNING id",
          [dbKey]
        );
        const transactionId = String(transaction.rows[0].id);
        await client.query(
          "INSERT INTO public.fp_flutterwave_bill_payments(transaction_id,user_id,account_id,idempotency_key,request_id,category_code,biller_code,biller_name,item_code,item_name,customer_id,amount_minor,bill_amount_minor,provider_fee_minor,status,provider_reference) VALUES($1,$2,$3,$4,$5,'UTILITYBILLS',$6,$7,$8,$9,$10,$11,$12,$13,'initiating',$14)",
          [transactionId, userId, walletId, dbKey, localRequestId, billerCode,
            safeString(biller.name ?? biller.short_name, 160), itemCode, item.name, customerId, walletAmountMinor, requestedAmount, providerFeeMinor, providerReference]
        );
        await client.query("COMMIT");
        bill = {
          transaction_id: transactionId, user_id: userId, account_id: walletId, idempotency_key: dbKey,
          request_id: localRequestId, category_code: "UTILITYBILLS", biller_code: billerCode,
          biller_name: safeString(biller.name ?? biller.short_name, 160), item_code: itemCode,
          item_name: item.name, customer_id: customerId, amount_minor: walletAmountMinor,
          bill_amount_minor: requestedAmount, provider_fee_minor: providerFeeMinor,
          status: "initiating", flw_tx_ref: null, flw_reference: providerReference
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        console.error("FlowPay Flutterwave bill reservation failed:", error instanceof Error ? error.message : "database error");
        send(res, 503, { error: "UTILITY_BILL_RESERVATION_UNAVAILABLE" }); return true;
      } finally {
        client.release();
      }
      if (!bill) { send(res, 503, { error: "UTILITY_BILL_RESERVATION_UNAVAILABLE" }); return true; }

      try {
        const callbackUrl = process.env.FLW_BILLS_CALLBACK_URL?.trim();
        const result = await providerRequest(cfg, "POST",
          "/billers/" + encodeURIComponent(billerCode) + "/items/" + encodeURIComponent(itemCode) + "/payment",
          {
            country: "NG", customer_id: customerId, amount: minorToNaira(requestedAmount),
            reference: providerReference, ...(callbackUrl && callbackUrl.startsWith("https://") ? { callback_url: callbackUrl } : {})
          });
        const data = providerData(result.body);
        const txRef = safeString(data.tx_ref, 120);
        const createAmount = data.amount === undefined || data.amount === null ? null : decimalToMinor(data.amount);
        const createFee = data.fee === undefined || data.fee === null ? null : decimalToMinor(data.fee);
        const createAmountMismatch = createAmount !== null && createAmount !== bill.bill_amount_minor;
        const createFeeMismatch = createFee !== null && createFee !== bill.provider_fee_minor;
        if (!result.ok || result.body.status !== "success" || !txRef || createAmountMismatch || createFeeMismatch) {
          await pool.query(
            "UPDATE public.fp_flutterwave_bill_payments SET status='unknown',flw_tx_ref=NULLIF($2,''),provider_status=NULLIF($3,''),status_note='Flutterwave did not return a matching bill reference, amount and fee. Amount remains reserved; do not retry until reconciled.',updated_at=NOW() WHERE request_id=$1 AND status='initiating'",
            [bill.request_id, txRef, safeString(result.body.message, 120)]
          );
          send(res, 202, { requestId: bill.request_id, status: "unknown", final: false, amountMinor: bill.amount_minor, billAmountMinor: bill.bill_amount_minor, feeMinor: bill.provider_fee_minor, currency: "NGN", message: "Flutterwave has not confirmed this bill request. The amount remains reserved; check status before retrying." });
          return true;
        }
        const flwReference = safeString(data.reference, 120);
        await pool.query(
          "UPDATE public.fp_flutterwave_bill_payments SET status='pending',flw_tx_ref=$2,flw_reference=NULLIF($3,''),provider_status=NULLIF($4,''),updated_at=NOW() WHERE request_id=$1 AND status='initiating'",
          [bill.request_id, txRef, flwReference, safeString(result.body.message, 120)]
        );
        bill.flw_tx_ref = txRef;
        bill.flw_reference = flwReference || null;
        // Immediately query the authoritative status endpoint. The create response
        // itself is not treated as proof that electricity was delivered.
        const verified = await providerRequest(cfg, "GET", "/bills/" + encodeURIComponent(txRef) + "?verbose=1");
        const state = verified.ok
          ? classifyFlutterwaveBillStatus(verified.body, txRef, bill.bill_amount_minor, bill.provider_fee_minor)
          : "unknown";
        const finalState = await reconcile(pool, bill, state, verified.body);
        const tokenValue = safeString(providerData(verified.body).extra ?? providerData(verified.body).token, 180);
        send(res, finalState === "success" ? 201 : finalState === "failed" ? 502 : 202, {
          requestId: bill.request_id, status: finalState, final: ["success", "failed"].includes(finalState),
          amountMinor: bill.amount_minor, billAmountMinor: bill.bill_amount_minor, feeMinor: bill.provider_fee_minor, currency: "NGN", token: finalState === "success" ? tokenValue : undefined,
          message: finalState === "success"
            ? "Flutterwave confirmed the utility payment. FlowPay posted the matching wallet debit."
            : finalState === "failed"
              ? "Flutterwave confirmed the utility payment failed. No customer wallet debit was posted."
              : "Flutterwave has not returned a final bill status. The amount remains reserved; requery before retrying."
        });
        return true;
      } catch (error) {
        console.error("FlowPay Flutterwave bill outcome is unconfirmed:", error instanceof Error ? error.message : "provider network error");
        await pool.query(
          "UPDATE public.fp_flutterwave_bill_payments SET status='unknown',status_note='Provider outcome is unconfirmed. Amount remains reserved; requery before retrying.',updated_at=NOW() WHERE request_id=$1 AND status IN ('initiating','pending')",
          [bill.request_id]
        ).catch(() => undefined);
        send(res, 202, { requestId: bill.request_id, status: "unknown", final: false, amountMinor: bill.amount_minor, billAmountMinor: bill.bill_amount_minor, feeMinor: bill.provider_fee_minor, currency: "NGN", message: "The provider outcome is unconfirmed. The amount remains reserved; requery this request before retrying." });
        return true;
      }
    }

    if (req.method === "GET" && path === "/customer/flutterwave/bills/status") {
      const request = url.searchParams.get("requestId") ?? "";
      if (!/^FPB-[0-9a-f-]{36}$/i.test(request)) { send(res, 400, { error: "INVALID_BILL_REQUEST_ID" }); return true; }
      try {
        const found = await pool.query<BillRow>(
          "SELECT transaction_id,user_id,account_id,idempotency_key,request_id,category_code,biller_code,biller_name,item_code,item_name,customer_id,amount_minor::text AS amount_minor,bill_amount_minor::text AS bill_amount_minor,provider_fee_minor::text AS provider_fee_minor,status,flw_tx_ref,flw_reference FROM public.fp_flutterwave_bill_payments WHERE request_id=$1 AND user_id=$2 LIMIT 1",
          [request, userId]
        );
        if (found.rowCount !== 1) { send(res, 404, { error: "UTILITY_BILL_PAYMENT_NOT_FOUND" }); return true; }
        const bill = found.rows[0];
        if (["success", "failed"].includes(bill.status)) {
          const saved = await pool.query<{ provider_token: string | null }>(
            "SELECT provider_token FROM public.fp_flutterwave_bill_payments WHERE request_id=$1", [bill.request_id]
          );
          send(res, 200, { requestId: bill.request_id, status: bill.status, final: true, amountMinor: bill.amount_minor, billAmountMinor: bill.bill_amount_minor, feeMinor: bill.provider_fee_minor, token: saved.rows[0]?.provider_token ?? undefined });
          return true;
        }
        if (!bill.flw_tx_ref) {
          send(res, 202, { requestId: bill.request_id, status: "unknown", final: false, amountMinor: bill.amount_minor, billAmountMinor: bill.bill_amount_minor, feeMinor: bill.provider_fee_minor, message: "Flutterwave has not supplied a transaction reference. Funds remain reserved and this request needs provider reconciliation." });
          return true;
        }
        const statusResult = await providerRequest(cfg, "GET", "/bills/" + encodeURIComponent(bill.flw_tx_ref) + "?verbose=1");
        if (!statusResult.ok) {
          send(res, 202, { requestId: bill.request_id, status: bill.status, final: false, amountMinor: bill.amount_minor, billAmountMinor: bill.bill_amount_minor, feeMinor: bill.provider_fee_minor, message: "Flutterwave status is not final yet. The amount remains reserved." });
          return true;
        }
        const state = classifyFlutterwaveBillStatus(statusResult.body, bill.flw_tx_ref, bill.bill_amount_minor);
        const finalState = await reconcile(pool, bill, state, statusResult.body);
        const tokenValue = safeString(providerData(statusResult.body).extra ?? providerData(statusResult.body).token, 180);
        send(res, 200, {
          requestId: bill.request_id, status: finalState, final: ["success", "failed"].includes(finalState),
          amountMinor: bill.amount_minor, billAmountMinor: bill.bill_amount_minor, feeMinor: bill.provider_fee_minor, token: finalState === "success" ? tokenValue : undefined,
          message: finalState === "success" ? "Flutterwave confirmed this utility bill payment." :
            finalState === "failed" ? "Flutterwave confirmed this utility bill payment failed." :
            "Flutterwave has not returned a final result. Funds remain reserved."
        });
      } catch (error) {
        console.error("FlowPay Flutterwave bill status check failed:", error instanceof Error ? error.message : "unknown error");
        send(res, 503, { error: "FLUTTERWAVE_BILL_STATUS_UNAVAILABLE" });
      }
      return true;
    }
    return false;
  };
}
