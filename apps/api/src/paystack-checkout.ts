import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { createRemoteJWKSet, jwtVerify } from "jose";

type Options = { pool: Pool | null; jwks: ReturnType<typeof createRemoteJWKSet> | null; issuer?: string; audience?: string };
type Identity = { id: string; email: string; name: string | null };
type Deposit = { id: string; status: "pending" | "posted" | "failed"; amount_minor: string; checkout_url: string | null };

function send(res: ServerResponse, status: number, body: unknown) { res.writeHead(status); res.end(JSON.stringify(body)); }
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(raw, "utf8") > 8192) throw Object.assign(new Error("PAYLOAD_TOO_LARGE"), { statusCode: 413 });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw || "{}"); } catch { throw Object.assign(new Error("INVALID_JSON"), { statusCode: 400 }); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Object.assign(new Error("INVALID_PAYLOAD"), { statusCode: 400 });
  return parsed as Record<string, unknown>;
}
function validAmount(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (!/^\d{1,15}$/.test(String(value))) return null;
  const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function validUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : null;
}
function httpsUrl(value: string | undefined): string | null {
  try { const u = new URL(value ?? ""); return u.protocol === "https:" ? u.toString() : null; } catch { return null; }
}
async function failDeposit(pool: Pool, transactionId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE public.fp_paystack_deposits SET status='failed' WHERE transaction_id=$1 AND status='pending'", [transactionId]);
    await client.query("UPDATE public.fp_ledger_transactions SET status='failed' WHERE id=$1 AND status='pending'", [transactionId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export function createPaystackCheckoutHandler(options: Options) {
  const { pool, jwks, issuer, audience } = options;
  return async function handlePaystackCheckout(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
    if (req.method !== "POST" || path !== "/customer/paystack/deposits") return false;
    if (!pool || !jwks || !issuer || !audience) { send(res, 503, { error: "PAYSTACK_CHECKOUT_SERVICE_NOT_CONFIGURED" }); return true; }
    const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if (!bearer) { send(res, 401, { error: "AUTHENTICATION_REQUIRED" }); return true; }

    let identity: Identity;
    try {
      const { payload } = await jwtVerify(bearer[1], jwks, { algorithms: ["EdDSA"], issuer, audience });
      if (typeof payload.sub !== "string" || !payload.sub) { send(res, 401, { error: "INVALID_SESSION" }); return true; }
      const result = await pool.query<Identity>(
        `SELECT u.id, a.email, a.name FROM neon_auth."user" a
          JOIN public.fp_users u ON u.auth_subject=a.id::text
         WHERE a.id::text=$1 AND a."emailVerified"=true AND u.status='active' LIMIT 1`, [payload.sub]);
      if (result.rowCount !== 1 || !result.rows[0].email) { send(res, 403, { error: "ACTIVE_VERIFIED_CUSTOMER_REQUIRED" }); return true; }
      identity = result.rows[0];
    } catch (error) {
      if (error instanceof Error && ["JWTExpired","JWSSignatureVerificationFailed","JWTClaimValidationFailed","JWSInvalid","JWTInvalid"].includes(error.name)) { send(res, 401, { error: "INVALID_SESSION" }); return true; }
      console.error("FlowPay Paystack authentication failed:", error instanceof Error ? error.message : "unknown error");
      send(res, 503, { error: "PAYSTACK_AUTH_UNAVAILABLE" }); return true;
    }

    let input: Record<string, unknown>;
    try { input = await readJson(req); }
    catch (error) {
      const status = error && typeof error === "object" && "statusCode" in error ? Number((error as {statusCode: unknown}).statusCode) : 400;
      send(res, status, { error: error instanceof Error ? error.message : "INVALID_PAYLOAD" }); return true;
    }
    if (Object.keys(input).some(k => !["amountMinor","idempotencyKey"].includes(k))) { send(res, 400, { error: "UNSUPPORTED_DEPOSIT_FIELD" }); return true; }
    const amountMinor = validAmount(input.amountMinor);
    const idempotencyKey = validUuid(input.idempotencyKey);
    if (amountMinor === null) { send(res, 400, { error: "INVALID_AMOUNT_MINOR" }); return true; }
    if (!idempotencyKey) { send(res, 400, { error: "VALID_IDEMPOTENCY_KEY_REQUIRED" }); return true; }

    const secret = process.env.PAYSTACK_SECRET_KEY?.trim() ?? "";
    const callback = httpsUrl(process.env.PAYSTACK_CALLBACK_URL?.trim());
    const min = Number(process.env.PAYSTACK_DEPOSIT_MIN_MINOR);
    const max = Number(process.env.PAYSTACK_DEPOSIT_MAX_MINOR);
    if (process.env.PAYSTACK_ENVIRONMENT !== "test" || !secret.startsWith("sk_test_") || !callback ||
        !Number.isSafeInteger(min) || min <= 0 || !Number.isSafeInteger(max) || max < min) {
      send(res, 503, { error: "PAYSTACK_SANDBOX_CONFIGURATION_REQUIRED" }); return true;
    }
    if (amountMinor < min || amountMinor > max) { send(res, 400, { error: "DEPOSIT_AMOUNT_OUT_OF_RANGE", minimumMinor: min, maximumMinor: max }); return true; }

    const dbKey = `paystack-deposit:${identity.id}:${idempotencyKey}`;
    const reference = `flowpay-ps-${randomUUID().replace(/-/g, "")}`;
    let transactionId = "";
    let existingUrl: string | null = null;
    let created = false;
    let client: PoolClient;
    try { client = await pool.connect(); }
    catch { send(res, 503, { error: "DEPOSIT_DATABASE_UNAVAILABLE" }); return true; }
    try {
      await client.query("BEGIN");
      const accounts = await client.query<{id:string}>(
        `SELECT id FROM public.fp_accounts WHERE user_id=$1 AND account_type='customer'
          AND currency='NGN' AND status='active' ORDER BY created_at FOR SHARE`, [identity.id]);
      if (accounts.rowCount !== 1) {
        await client.query("ROLLBACK");
        send(res, 409, { error: accounts.rowCount === 0 ? "ACTIVE_NGN_WALLET_REQUIRED" : "MULTIPLE_ACTIVE_NGN_WALLETS_REQUIRE_REVIEW" });
        return true;
      }
      const inserted = await client.query<{id:string}>(
        `INSERT INTO public.fp_ledger_transactions (idempotency_key,transaction_type,status,description)
         VALUES ($1,'paystack_deposit','pending','Paystack NGN sandbox deposit')
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`, [dbKey]);
      if (inserted.rowCount === 1) {
        transactionId = inserted.rows[0].id;
        await client.query(
          `INSERT INTO public.fp_paystack_deposits (transaction_id,user_id,account_id,reference,amount_minor,currency,status)
           VALUES ($1,$2,$3,$4,$5,'NGN','pending')`,
          [transactionId, identity.id, accounts.rows[0].id, reference, String(amountMinor)]);
        created = true;
      } else {
        const existing = await client.query<Deposit>(
          `SELECT t.id,d.status,d.amount_minor::text,d.checkout_url FROM public.fp_ledger_transactions t
            JOIN public.fp_paystack_deposits d ON d.transaction_id=t.id WHERE t.idempotency_key=$1 FOR UPDATE OF t`, [dbKey]);
        if (existing.rowCount !== 1) throw new Error("IDEMPOTENCY_RECORD_UNAVAILABLE");
        transactionId = existing.rows[0].id;
        existingUrl = existing.rows[0].checkout_url;
        if (Number(existing.rows[0].amount_minor) !== amountMinor) { await client.query("ROLLBACK"); send(res,409,{error:"IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_AMOUNT"}); return true; }
        if (existing.rows[0].status !== "pending" || !existingUrl) { await client.query("ROLLBACK"); send(res,409,{error:"DEPOSIT_REQUEST_ALREADY_PROCESSING_OR_FINAL"}); return true; }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(()=>undefined);
      console.error("FlowPay Paystack deposit setup failed:", error instanceof Error ? error.message : "database error");
      send(res,503,{error:"DEPOSIT_SETUP_UNAVAILABLE"}); return true;
    } finally { client.release(); }
    if (existingUrl) { send(res,200,{transactionId,status:"pending",environment:"test",checkoutUrl:existingUrl}); return true; }
    if (!created) { send(res,409,{error:"DEPOSIT_REQUEST_ALREADY_PROCESSING"}); return true; }

    let providerResponse: Response;
    let providerBody: unknown;
    try {
      providerResponse = await fetch("https://api.paystack.co/transaction/initialize", {
        method:"POST",
        headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json",Accept:"application/json"},
        body:JSON.stringify({
          email:identity.email, amount:String(amountMinor), currency:"NGN", reference,
          callback_url:callback, metadata:{flowpay_transaction_id:transactionId, flowpay_environment:"test"}
        }),
        signal:AbortSignal.timeout(12000)
      });
      providerBody = await providerResponse.json().catch(()=>null);
    } catch (error) {
      console.error("FlowPay Paystack checkout outcome uncertain:", error instanceof Error ? error.message : "network error");
      send(res,502,{error:"PAYSTACK_CHECKOUT_OUTCOME_UNCONFIRMED",transactionId,status:"pending"}); return true;
    }
    const body = providerBody && typeof providerBody==="object" && !Array.isArray(providerBody) ? providerBody as Record<string,unknown> : {};
    const data = body.data && typeof body.data==="object" && !Array.isArray(body.data) ? body.data as Record<string,unknown> : {};
    const checkoutUrl = typeof data.authorization_url==="string" ? data.authorization_url : "";
    let safeUrl = false;
    try { const u=new URL(checkoutUrl); safeUrl=u.protocol==="https:" && u.hostname==="checkout.paystack.com"; } catch { safeUrl=false; }
    if (providerResponse.status>=500) { send(res,502,{error:"PAYSTACK_CHECKOUT_OUTCOME_UNCONFIRMED",transactionId,status:"pending"}); return true; }
    if (!providerResponse.ok || body.status!==true || data.reference!==reference || !safeUrl) {
      try { await failDeposit(pool,transactionId); } catch (error) { console.error("Could not record Paystack checkout failure:",error instanceof Error?error.message:"database error"); }
      send(res,502,{error:"PAYSTACK_CHECKOUT_CREATION_FAILED"}); return true;
    }
    try {
      const saved=await pool.query(
        "UPDATE public.fp_paystack_deposits SET checkout_url=$2 WHERE transaction_id=$1 AND status='pending'",
        [transactionId,checkoutUrl]);
      if(saved.rowCount!==1) throw new Error("CHECKOUT_LINK_NOT_SAVED");
    } catch(error) {
      console.error("Could not save Paystack checkout link:",error instanceof Error?error.message:"database error");
      send(res,503,{error:"CHECKOUT_LINK_PERSISTENCE_FAILED",transactionId,status:"pending"}); return true;
    }
    send(res,201,{transactionId,providerReference:reference,status:"pending",environment:"test",checkoutUrl});
    return true;
  };
}
