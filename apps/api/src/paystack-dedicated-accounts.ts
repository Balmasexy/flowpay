import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createRemoteJWKSet, jwtVerify } from "jose";

type Options = {
  pool: Pool | null;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
  issuer?: string;
};
type PaystackBody = { status?: unknown; message?: unknown; data?: unknown };
type PaystackRecord = Record<string, unknown>;
type Identity = {
  id: string;
  role: string;
  name: string;
  email: string;
  phone: string;
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}
function record(value: unknown): PaystackRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as PaystackRecord : {};
}
function isJwtError(error: unknown) {
  return error instanceof Error && [
    "JWTExpired", "JWSSignatureVerificationFailed", "JWTClaimValidationFailed",
    "JWSInvalid", "JWTInvalid"
  ].includes(error.name);
}
async function readJson(req: IncomingMessage): Promise<PaystackRecord> {
  let raw = "";
  for await (const chunk of req) {
    raw += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(raw, "utf8") > 4_096) throw new Error("PAYLOAD_TOO_LARGE");
  }
  let value: unknown;
  try { value = JSON.parse(raw || "{}"); } catch { throw new Error("INVALID_JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PAYLOAD");
  return value as PaystackRecord;
}
function sandboxEnabled() {
  const secret = process.env.PAYSTACK_SECRET_KEY?.trim() ?? "";
  return process.env.PAYSTACK_ENVIRONMENT === "test" &&
    secret.startsWith("sk_test_") &&
    process.env.FLOWPAY_RUNTIME_ENV === "development" &&
    process.env.NODE_ENV !== "production" &&
    process.env.PAYSTACK_DEDICATED_ACCOUNTS_ENABLED === "true";
}
function phoneE164(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (/^0\d{10}$/.test(digits)) return "+234" + digits.slice(1);
  if (/^234\d{10}$/.test(digits)) return "+" + digits;
  return null;
}
function splitLegalName(value: string): { firstName: string; lastName: string } | null {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.join(" ").length > 100) return null;
  return { firstName: tokens[0], lastName: tokens.slice(1).join(" ") };
}
async function paystack(secret: string, path: string, payload?: PaystackRecord): Promise<{ ok: boolean; status: number; body: PaystackBody }> {
  const response = await fetch("https://api.paystack.co" + path, {
    method: payload ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + secret,
      Accept: "application/json",
      ...(payload ? { "Content-Type": "application/json" } : {})
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(12_000)
  });
  const body = await response.json().catch(() => null);
  const parsed = record(body);
  return { ok: response.ok && parsed.status === true, status: response.status, body: parsed as PaystackBody };
}
async function authenticate(pool: Pool, jwks: ReturnType<typeof createRemoteJWKSet>, issuer: string, req: IncomingMessage): Promise<Identity | null> {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
  if (!bearer) return null;
  // Neon Managed Auth documents the branch Auth URL's origin as the JWT issuer.
  // It does not require an API audience claim, so verify the signature and issuer only.
  const { payload } = await jwtVerify(bearer[1], jwks, { algorithms: ["EdDSA"], issuer });
  if (typeof payload.sub !== "string" || !payload.sub) return null;
  const result = await pool.query<Identity>(
    `SELECT app_user.id, app_user.role,
            COALESCE(NULLIF(BTRIM(auth_user.name), ''), '') AS name,
            COALESCE(NULLIF(BTRIM(auth_user.email), ''), '') AS email,
            COALESCE(NULLIF(BTRIM(profile.phone_number), ''), '') AS phone
       FROM neon_auth."user" AS auth_user
       JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
       LEFT JOIN public.fp_customer_profiles AS profile ON profile.user_id = app_user.id
      WHERE auth_user.id::text = $1
        AND auth_user."emailVerified" = true
        AND app_user.status = 'active'
        AND app_user.role IN ('customer','admin','super_admin')
      LIMIT 1`,
    [payload.sub]
  );
  return result.rowCount === 1 ? result.rows[0] : null;
}
type DedicatedAccountRow = {
  user_id: string;
  paystack_customer_code: string | null;
  dedicated_account_id: string | null;
  account_number: string | null;
  bank_name: string | null;
  account_name: string | null;
  status: string;
};
function view(row: DedicatedAccountRow | null) {
  return row?.status === "assigned" && row.account_number && row.bank_name && row.account_name
    ? {
        assigned: true,
        status: "assigned",
        accountNumber: row.account_number.trim(),
        bankName: row.bank_name,
        accountName: row.account_name
      }
    : {
        assigned: false,
        status: row?.status ?? "not_requested",
        accountNumber: null,
        bankName: null,
        accountName: null
      };
}

export async function processPaystackDedicatedAccountWebhook(pool: Pool, event: PaystackRecord) {
  if (!sandboxEnabled()) return false;
  const eventName = typeof event.event === "string" ? event.event : "";
  if (![
    "dedicatedaccount.assign.success",
    "dedicatedaccount.assign.failed",
    "customeridentification.success",
    "customeridentification.failed"
  ].includes(eventName)) return false;
  const data = record(event.data);
  const customerCode = typeof data.customer_code === "string" ? data.customer_code : "";
  if (!customerCode) return true;
  if (eventName === "customeridentification.failed" || eventName === "dedicatedaccount.assign.failed") {
    await pool.query(
      `UPDATE public.fp_paystack_dedicated_accounts
          SET status = 'failed', last_error_code = $2, updated_at = NOW()
        WHERE paystack_customer_code = $1 AND status <> 'assigned'`,
      [customerCode, eventName.replace(/[^a-z.]/g, "").slice(0, 80)]
    );
    return true;
  }
  if (eventName === "dedicatedaccount.assign.success") {
    const account = record(data.dedicated_account ?? data);
    const bank = record(account.bank);
    const accountNumber = typeof account.account_number === "string" ? account.account_number : "";
    const bankName = typeof bank.name === "string" ? bank.name.trim() : "";
    const accountName = typeof account.account_name === "string" ? account.account_name.trim() : "";
    if (/^\d{10}$/.test(accountNumber) && bankName && accountName &&
        account.assigned === true && account.active === true &&
        (account.currency === undefined || account.currency === "NGN")) {
      await pool.query(
        `UPDATE public.fp_paystack_dedicated_accounts
            SET dedicated_account_id = $2, account_number = $3,
                bank_name = $4, account_name = $5, status = 'assigned',
                last_error_code = NULL, updated_at = NOW()
          WHERE paystack_customer_code = $1`,
        [customerCode, String(account.id ?? ""), accountNumber, bankName, accountName]
      );
    }
  }
  return true;
}

export function createPaystackDedicatedAccountsHandler(options: Options) {
  const { pool, jwks, issuer } = options;
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
    const get = req.method === "GET" && path === "/customer/dedicated-bank-account";
    const post = req.method === "POST" && path === "/customer/dedicated-bank-account";
    if (!get && !post) return false;
    if (!pool || !jwks || !issuer) {
      send(res, 503, { error: "DEDICATED_BANK_ACCOUNT_SERVICE_NOT_CONFIGURED" }); return true;
    }
    let identity: Identity | null;
    try {
      identity = await authenticate(pool, jwks, issuer, req);
      if (!identity) {
        send(res, req.headers.authorization ? 403 : 401, {
          error: req.headers.authorization ? "ACTIVE_VERIFIED_PROFILE_REQUIRED" : "AUTHENTICATION_REQUIRED"
        });
        return true;
      }
    } catch (error) {
      if (isJwtError(error)) send(res, 401, { error: "INVALID_SESSION" });
      else {
        console.error("FlowPay dedicated account authentication failed:", error instanceof Error ? error.message : "unknown error");
        send(res, 503, { error: "DEDICATED_BANK_ACCOUNT_AUTH_UNAVAILABLE" });
      }
      return true;
    }

    try {
      const saved = await pool.query<DedicatedAccountRow>(
        `SELECT user_id, paystack_customer_code, dedicated_account_id,
                account_number, bank_name, account_name, status
           FROM public.fp_paystack_dedicated_accounts
          WHERE user_id = $1 LIMIT 1`,
        [identity.id]
      );
      const current = saved.rows[0] ?? null;
      if (get) {
        send(res, 200, { provider: "Paystack", environment: "test", virtualBankAccount: view(current), livePaymentsEnabled: false });
        return true;
      }

      let input: PaystackRecord;
      try { input = await readJson(req); }
      catch (error) {
        const message = error instanceof Error ? error.message : "INVALID_PAYLOAD";
        send(res, message === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: message }); return true;
      }
      if (Object.keys(input).some(key => key !== "consent") || input.consent !== true) {
        send(res, 400, { error: "EXPRESS_CONSENT_REQUIRED" }); return true;
      }
      if (current?.status === "assigned") {
        send(res, 200, { provider: "Paystack", environment: "test", virtualBankAccount: view(current), duplicate: true, livePaymentsEnabled: false });
        return true;
      }
      if (current?.status === "pending") {
        send(res, 202, {
          provider: "Paystack", environment: "test",
          virtualBankAccount: view(current),
          message: "A Paystack dedicated-account request is already pending for this profile. FlowPay will not submit a duplicate request.",
          livePaymentsEnabled: false
        });
        return true;
      }
      if (!sandboxEnabled()) {
        send(res, 503, {
          error: "PAYSTACK_DEDICATED_ACCOUNTS_NOT_ENABLED",
          message: "Dedicated-account assignment is not enabled on an isolated development API. No account was created.",
          requiredConfiguration: [
            "PAYSTACK_ENVIRONMENT=test",
            "PAYSTACK_SECRET_KEY=sk_test_…",
            "FLOWPAY_RUNTIME_ENV=development",
            "PAYSTACK_DEDICATED_ACCOUNTS_ENABLED=true"
          ],
          livePaymentsEnabled: false
        });
        return true;
      }
      const identityFields = splitLegalName(identity.name);
      const phone = phoneE164(identity.phone);
      if (!identityFields || !identity.email.includes("@") || !phone) {
        send(res, 422, { error: "CUSTOMER_PROFILE_INCOMPLETE", required: ["full legal name", "email", "Nigerian phone number"] });
        return true;
      }

      const requestClaim = await pool.query(
        `INSERT INTO public.fp_paystack_dedicated_accounts AS existing
           (user_id, status, consent_at, last_error_code)
         VALUES ($1, 'pending', NOW(), NULL)
         ON CONFLICT (user_id) DO UPDATE
           SET status = 'pending',
               consent_at = EXCLUDED.consent_at,
               last_error_code = NULL,
               updated_at = NOW()
         WHERE existing.status = 'failed'
         RETURNING user_id`,
        [identity.id]
      );
      if (requestClaim.rowCount !== 1) {
        const latest = await pool.query<DedicatedAccountRow>(
          `SELECT user_id, paystack_customer_code, dedicated_account_id,
                  account_number, bank_name, account_name, status
             FROM public.fp_paystack_dedicated_accounts
            WHERE user_id = $1 LIMIT 1`,
          [identity.id]
        );
        const latestRow = latest.rows[0] ?? current;
        send(res, latestRow?.status === "assigned" ? 200 : 202, {
          provider: "Paystack", environment: "test",
          virtualBankAccount: view(latestRow),
          duplicate: true,
          message: "A dedicated-account request already exists for this profile. FlowPay did not create another Paystack account.",
          livePaymentsEnabled: false
        });
        return true;
      }

      const secret = process.env.PAYSTACK_SECRET_KEY!.trim();
      let customerCode = current?.paystack_customer_code ?? null;
      if (!customerCode) {
        const createdCustomer = await paystack(secret, "/customer", {
          email: identity.email,
          first_name: identityFields.firstName,
          last_name: identityFields.lastName,
          phone
        });
        const customerData = record(createdCustomer.body.data);
        customerCode = typeof customerData.customer_code === "string" ? customerData.customer_code : null;
        if (!createdCustomer.ok || !customerCode || !/^CUS_[A-Za-z0-9]+$/.test(customerCode) ||
            (customerData.domain !== undefined && customerData.domain !== "test")) {
          await pool.query(
            `UPDATE public.fp_paystack_dedicated_accounts
                SET status = 'failed', last_error_code = 'PAYSTACK_CUSTOMER_CREATE_FAILED', updated_at = NOW()
              WHERE user_id = $1`,
            [identity.id]
          );
          send(res, 502, { error: "PAYSTACK_CUSTOMER_CREATE_FAILED", message: "Paystack could not create the test customer. No virtual bank account was assigned." });
          return true;
        }
        await pool.query(
          `UPDATE public.fp_paystack_dedicated_accounts
              SET paystack_customer_code = $2, updated_at = NOW()
            WHERE user_id = $1`,
          [identity.id, customerCode]
        );
      }

      const assigned = await paystack(secret, "/dedicated_account", {
        customer: customerCode,
        preferred_bank: "test-bank"
      });
      const account = record(assigned.body.data);
      const bank = record(account.bank);
      const accountNumber = typeof account.account_number === "string" ? account.account_number : "";
      const bankName = typeof bank.name === "string" ? bank.name.trim() : "";
      const accountName = typeof account.account_name === "string" ? account.account_name.trim() : "";
      if (!assigned.ok) {
        const providerMessage = typeof assigned.body.message === "string"
          ? assigned.body.message.replace(/[\r\n\t]+/g, " ").slice(0, 240)
          : "Paystack did not provide a rejection reason.";
        console.error("Paystack dedicated account assignment rejected:", {
          httpStatus: assigned.status,
          providerMessage
        });
        await pool.query(
          `UPDATE public.fp_paystack_dedicated_accounts
              SET status = 'failed', last_error_code = 'PAYSTACK_DEDICATED_ACCOUNT_FAILED', updated_at = NOW()
            WHERE user_id = $1`,
          [identity.id]
        );
        send(res, 502, {
          error: "PAYSTACK_DEDICATED_ACCOUNT_FAILED",
          message: "Paystack did not issue a test virtual bank account. No placeholder number was saved.",
          providerStatus: assigned.status,
          providerMessage,
          livePaymentsEnabled: false
        });
        return true;
      }
      if (account.assigned === true && account.active === true &&
          /^\d{10}$/.test(accountNumber) && bankName && accountName &&
          account.currency === "NGN") {
        const result = await pool.query<DedicatedAccountRow>(
          `UPDATE public.fp_paystack_dedicated_accounts
              SET dedicated_account_id = $2, account_number = $3, bank_name = $4,
                  account_name = $5, status = 'assigned', last_error_code = NULL,
                  updated_at = NOW()
            WHERE user_id = $1
            RETURNING user_id, paystack_customer_code, dedicated_account_id,
                      account_number, bank_name, account_name, status`,
          [identity.id, String(account.id ?? ""), accountNumber, bankName, accountName]
        );
        send(res, 201, {
          provider: "Paystack", environment: "test",
          virtualBankAccount: view(result.rows[0]),
          livePaymentsEnabled: false,
          message: "Paystack confirmed a test virtual bank account assignment. This is separate from the FlowPay wallet number and virtual card."
        });
        return true;
      }

      await pool.query(
        `UPDATE public.fp_paystack_dedicated_accounts
            SET status = 'pending', last_error_code = NULL, updated_at = NOW()
          WHERE user_id = $1`,
        [identity.id]
      );
      send(res, 202, {
        provider: "Paystack", environment: "test",
        virtualBankAccount: { assigned: false, status: "pending", accountNumber: null, bankName: null, accountName: null },
        message: "Paystack accepted the dedicated-account request. The verified account number will appear after assignment confirmation.",
        livePaymentsEnabled: false
      });
      return true;
    } catch (error) {
      console.error("FlowPay dedicated account request failed:", error instanceof Error ? error.message : "provider or database error");
      send(res, 503, { error: "DEDICATED_BANK_ACCOUNT_UNAVAILABLE" });
      return true;
    }
  };
}
