import { createServer } from "node:http";
import { Pool } from "pg";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createFaceVerificationHandler } from "./face-verification.js";
import { createFlutterwaveCheckoutHandler } from "./flutterwave-checkout.js";
import { createFlutterwaveWebhookHandler } from "./flutterwave-webhook.js";
import { createPaystackCheckoutHandler } from "./paystack-checkout.js";
import { createPaystackWebhookHandler } from "./paystack-webhook.js";
import { createPaystackDepositStatusHandler } from "./paystack-status.js";
import { createSupportRequestsHandler } from "./support-requests.js";
import { createBankAccountLookupHandler } from "./bank-account-lookup.js";
import { createFlowPayTransfersHandler } from "./flowpay-transfers.js";
import { createPaystackBankTransfersHandler } from "./paystack-bank-transfers.js";
import { createCustomerAiHandler } from "./customer-ai.js";
import { createDepositReceiptsHandler } from "./deposit-receipts.js";

const port = Number(process.env.PORT ?? 3000);
const databaseUrl = process.env.DATABASE_URL?.trim();
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 5, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000, allowExitOnIdle: true })
  : null;

pool?.on("error", (error) => console.error("FlowPay database pool error:", error.message));

const allowedOrigins = new Set(
  [process.env.WEB_ORIGIN, "https://flowpay-web-jx7i.onrender.com", "http://localhost:5173", "https://localhost"].filter(
    (origin): origin is string => Boolean(origin)
  )
);

const jwksUrl = process.env.NEON_AUTH_JWKS_URL;
const issuer = process.env.NEON_AUTH_ISSUER;
const audience = process.env.NEON_AUTH_AUDIENCE;
const jwks = jwksUrl ? createRemoteJWKSet(new URL(jwksUrl)) : null;
const faceVerificationHandler = createFaceVerificationHandler({ pool, jwks, issuer, audience });
const flutterwaveCheckoutHandler = createFlutterwaveCheckoutHandler({ pool, jwks, issuer, audience });
const flutterwaveWebhookHandler = createFlutterwaveWebhookHandler({ pool });
const paystackCheckoutHandler = createPaystackCheckoutHandler({ pool, jwks, issuer, audience });
const paystackWebhookHandler = createPaystackWebhookHandler({ pool });
const paystackDepositStatusHandler = createPaystackDepositStatusHandler({ pool, jwks, issuer, audience });
const supportRequestsHandler = createSupportRequestsHandler({ pool, jwks, issuer, audience });
const bankAccountLookupHandler = createBankAccountLookupHandler({ pool, jwks, issuer, audience });
const flowPayTransfersHandler = createFlowPayTransfersHandler({ pool, jwks, issuer, audience });
const paystackBankTransfersHandler = createPaystackBankTransfersHandler({ pool, jwks, issuer, audience });
const customerAiHandler = createCustomerAiHandler({ pool, jwks, issuer, audience });
const depositReceiptsHandler = createDepositReceiptsHandler({ pool, jwks, issuer, audience });

function send(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (await depositReceiptsHandler(req, res)) return;
  if (await faceVerificationHandler(req, res)) return;
  if (await flutterwaveWebhookHandler(req, res)) return;
  if (await paystackWebhookHandler(req, res)) return;
  if (await paystackDepositStatusHandler(req, res)) return;
  if (await paystackCheckoutHandler(req, res)) return;
  if (await flutterwaveCheckoutHandler(req, res)) return;
  if (await supportRequestsHandler(req, res)) return;
  if (await customerAiHandler(req, res)) return;
  if (await flowPayTransfersHandler(req, res)) return;
  if (await paystackBankTransfersHandler(req, res)) return;
  if (await bankAccountLookupHandler(req, res)) return;

  if (req.method === "GET" && pathname === "/") {
    send(res, 200, { service: "flowpay-api", status: "ok", endpoints: ["/health", "/ready", "/admin/session", "/customer/profile", "/customer/overview", "/customer/activity", "/customer/cards", "/customer/money-received", "/customer/money-sent", "/customer/security", "/customer/flutterwave/deposits", "/webhooks/flutterwave", "/customer/paystack/deposits", "/customer/paystack/deposits/status", "/webhooks/paystack", "/face-verification/status", "/face-verification/callback", "/customer/face-verification", "/customer/support-requests", "/customer/banks", "/customer/bank-account-lookup", "/customer/flowpay/recipients/lookup", "/customer/transfers/flowpay", "/customer/transaction-pin/status", "/customer/transaction-pin/setup", "/customer-ai/chat", "/customer/deposit-receipts", "/admin/deposit-receipts"] }); return;
  }
  if (req.method === "GET" && pathname === "/health") {
    send(res, 200, { service: "flowpay-api", status: "ok", environment: process.env.NODE_ENV ?? "development" }); return;
  }
  if (req.method === "GET" && pathname === "/ready") {
    if (!pool) { send(res, 503, { service: "flowpay-api", status: "not_ready", database: "not_configured", payments: "disabled" }); return; }
    try {
      const result = await pool.query<{ database_name: string }>("SELECT current_database() AS database_name");
      send(res, 200, { service: "flowpay-api", status: "ready", database: "connected", database_name: result.rows[0]?.database_name, payments: "disabled" });
    } catch (error) {
      console.error("FlowPay readiness database check failed:", error instanceof Error ? error.message : "unknown database error");
      send(res, 503, { service: "flowpay-api", status: "not_ready", database: "unavailable", payments: "disabled" });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/customer/overview") {
    if (!pool || !jwks || !issuer || !audience) { send(res, 503, { error: "OVERVIEW_SERVICE_NOT_CONFIGURED" }); return; }
    const match = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) { send(res, 401, { error: "AUTHENTICATION_REQUIRED" }); return; }
    try {
      const { payload } = await jwtVerify(match[1], jwks, { algorithms: ["EdDSA"], issuer, audience });
      if (typeof payload.sub !== "string" || !payload.sub) { send(res, 401, { error: "INVALID_SESSION" }); return; }
      const identity = await pool.query(
        `SELECT app_user.id
           FROM neon_auth."user" AS auth_user
           JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
          WHERE auth_user.id::text = $1 AND auth_user."emailVerified" = true
            AND app_user.status = 'active' LIMIT 1`, [payload.sub]);
      if (identity.rowCount !== 1) { send(res, 403, { error: "ACTIVE_CUSTOMER_ACCOUNT_REQUIRED" }); return; }
      const userId = identity.rows[0].id;
      const [accounts, recentActivity, balanceRows, transactionCounts] = await Promise.all([
        pool.query(
          `SELECT currency, status, COUNT(*)::int AS account_count
             FROM public.fp_accounts
            WHERE user_id = $1 AND account_type = 'customer'
            GROUP BY currency, status
            ORDER BY currency, status`, [userId]),
        pool.query(
          `SELECT t.id, t.transaction_type, t.description, t.status, t.created_at, t.posted_at
             FROM public.fp_ledger_transactions AS t
             JOIN public.fp_ledger_entries AS e ON e.transaction_id = t.id
             JOIN public.fp_accounts AS a ON a.id = e.account_id
            WHERE a.user_id = $1 AND a.account_type = 'customer'
              AND t.status IN ('posted', 'reversed')
            GROUP BY t.id
            ORDER BY COALESCE(t.posted_at, t.created_at) DESC
            LIMIT 5`, [userId]),
        pool.query(
          `SELECT a.currency,
                  COALESCE(SUM(e.amount_minor) FILTER (WHERE t.status = 'posted'), 0)::text AS amount_minor
             FROM public.fp_accounts AS a
             LEFT JOIN public.fp_ledger_entries AS e ON e.account_id = a.id
             LEFT JOIN public.fp_ledger_transactions AS t ON t.id = e.transaction_id
            WHERE a.user_id = $1 AND a.account_type = 'customer' AND a.status = 'active'
            GROUP BY a.currency
            ORDER BY a.currency`, [userId]),
        pool.query(
          `SELECT t.status, COUNT(DISTINCT t.id)::int AS transaction_count
             FROM public.fp_ledger_transactions AS t
             JOIN public.fp_ledger_entries AS e ON e.transaction_id = t.id
             JOIN public.fp_accounts AS a ON a.id = e.account_id
            WHERE a.user_id = $1 AND a.account_type = 'customer'
              AND t.status IN ('posted', 'reversed')
            GROUP BY t.status`, [userId])
      ]);
      // Ledger convention: customer wallet credits are positive entries;
      // debits are negative entries. Every posted provider deposit is balanced
      // against its provider-specific system clearing account in the same DB transaction.
      const balances = balanceRows.rows.map(row => ({
        currency: String(row.currency).trim(),
        amountMinor: String(row.amount_minor ?? "0")
      }));
      send(res, 200, {
        overview: {
          accounts: accounts.rows.map(row => ({ currency: row.currency, status: row.status, count: row.account_count })),
          recentActivity: recentActivity.rows.map(row => ({
            id: row.id, type: row.transaction_type, description: row.description ?? "",
            status: row.status, createdAt: row.created_at, postedAt: row.posted_at
          })),
          transactionSummary: {
            postedCount: Number(transactionCounts.rows.find(row => row.status === "posted")?.transaction_count ?? 0),
            reversedCount: Number(transactionCounts.rows.find(row => row.status === "reversed")?.transaction_count ?? 0)
          },
          balance: { available: true, balances },
          paymentsEnabled: false,
          generatedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      if (error instanceof Error && ["JWTExpired","JWSSignatureVerificationFailed","JWTClaimValidationFailed","JWSInvalid","JWTInvalid"].includes(error.name)) { send(res, 401, { error: "INVALID_SESSION" }); return; }
      console.error("FlowPay customer overview request failed:", error instanceof Error ? error.message : "unknown overview error");
      send(res, 503, { error: "OVERVIEW_SERVICE_UNAVAILABLE" });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/customer/money-sent") {
    if (!pool || !jwks || !issuer || !audience) { send(res, 503, { error: "MONEY_SENT_SERVICE_NOT_CONFIGURED" }); return; }
    const match = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) { send(res, 401, { error: "AUTHENTICATION_REQUIRED" }); return; }
    try {
      const { payload } = await jwtVerify(match[1], jwks, { algorithms: ["EdDSA"], issuer, audience });
      if (typeof payload.sub !== "string" || !payload.sub) { send(res, 401, { error: "INVALID_SESSION" }); return; }
      const identity = await pool.query(
        `SELECT app_user.id FROM neon_auth."user" AS auth_user
           JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
          WHERE auth_user.id::text = $1 AND auth_user."emailVerified" = true
            AND app_user.status = 'active' LIMIT 1`, [payload.sub]);
      if (identity.rowCount !== 1) { send(res, 403, { error: "ACTIVE_CUSTOMER_ACCOUNT_REQUIRED" }); return; }
      const result = await pool.query(
        `SELECT t.id, t.transaction_type, t.status, t.created_at,
                d.destination_account
           FROM public.fp_simulated_transfer_details AS d
           JOIN public.fp_ledger_transactions AS t ON t.id = d.transaction_id
           JOIN public.fp_ledger_entries AS e ON e.transaction_id = t.id
           JOIN public.fp_accounts AS a ON a.id = e.account_id
          WHERE a.user_id = $1 AND a.account_type = 'customer'
          UNION ALL
         SELECT t.id, t.transaction_type, t.status, t.created_at,
                d.recipient_account_number AS destination_account
           FROM public.fp_internal_transfer_details AS d
           JOIN public.fp_ledger_transactions AS t ON t.id = d.transaction_id
          WHERE d.sender_user_id = $1
          ORDER BY created_at DESC LIMIT 100`, [identity.rows[0].id]);
      const payoutSchema = await pool.query<{ available: boolean }>(
        "SELECT to_regclass('public.fp_paystack_bank_transfers') IS NOT NULL AS available"
      );
      const bankPayoutsEnabled = payoutSchema.rows[0]?.available === true &&
        process.env.PAYSTACK_ENVIRONMENT === "test" &&
        (process.env.PAYSTACK_SECRET_KEY ?? "").startsWith("sk_test_") &&
        process.env.PAYSTACK_TRANSFERS_ENABLED === "true";
      const bankPayoutRows = payoutSchema.rows[0]?.available === true
        ? await pool.query(
            `SELECT t.id, t.transaction_type,
                    CASE WHEN d.status = 'success' THEN 'posted'
                         WHEN d.status IN ('failed','blocked','abandoned','rejected') THEN 'failed'
                         ELSE d.status END AS status,
                    d.created_at, d.account_number_last4 AS destination_account
               FROM public.fp_paystack_bank_transfers AS d
               JOIN public.fp_ledger_transactions AS t ON t.id = d.transaction_id
              WHERE d.user_id = $1
              ORDER BY d.created_at DESC LIMIT 100`,
            [identity.rows[0].id]
          )
        : { rows: [] as Array<Record<string, unknown>> };
      const transfers = [...result.rows, ...bankPayoutRows.rows]
        .sort((a, b) => new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime())
        .slice(0, 100);
      send(res, 200, { transfers: transfers.map(row => ({
        id: row.id, type: row.transaction_type, status: row.status,
        createdAt: row.created_at,
        destinationAccountMasked: "******" + String(row.destination_account).slice(-4)
      })), simulationOnly: false, liveTransfersEnabled: false, internalWalletTransfersEnabled: true, bankPayoutsEnabled, bankPayoutEnvironment: "test" });
    } catch (error) {
      if (error instanceof Error && ["JWTExpired","JWSSignatureVerificationFailed","JWTClaimValidationFailed","JWSInvalid","JWTInvalid"].includes(error.name)) { send(res, 401, { error: "INVALID_SESSION" }); return; }
      console.error("FlowPay money sent request failed:", error instanceof Error ? error.message : "unknown money sent error");
      send(res, 503, { error: "MONEY_SENT_SERVICE_UNAVAILABLE" });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/customer/money-received") {
    if (!pool || !jwks || !issuer || !audience) { send(res, 503, { error: "MONEY_RECEIVED_SERVICE_NOT_CONFIGURED" }); return; }
    const match = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) { send(res, 401, { error: "AUTHENTICATION_REQUIRED" }); return; }
    try {
      const { payload } = await jwtVerify(match[1], jwks, { algorithms: ["EdDSA"], issuer, audience });
      if (typeof payload.sub !== "string" || !payload.sub) { send(res, 401, { error: "INVALID_SESSION" }); return; }
      const identity = await pool.query(
        `SELECT app_user.id FROM neon_auth."user" AS auth_user
           JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
          WHERE auth_user.id::text = $1 AND auth_user."emailVerified" = true
            AND app_user.status = 'active' LIMIT 1`, [payload.sub]);
      if (identity.rowCount !== 1) { send(res, 403, { error: "ACTIVE_CUSTOMER_ACCOUNT_REQUIRED" }); return; }
      const userId = identity.rows[0].id;
      const [flutterwaveResult, paystackTable] = await Promise.all([
        pool.query(
          `SELECT d.transaction_id, d.provider_tx_ref, d.amount_minor::text AS amount_minor,
                  d.currency, d.status, d.created_at, d.verified_at
             FROM public.fp_flutterwave_deposits AS d
            WHERE d.user_id = $1 AND d.status = 'posted'
            ORDER BY COALESCE(d.verified_at, d.created_at) DESC LIMIT 100`, [userId]),
        pool.query<{ available: boolean; clearing_account_available: boolean }>(
          `SELECT
             to_regclass('public.fp_paystack_deposits') IS NOT NULL AS available,
             EXISTS (
               SELECT 1 FROM public.fp_accounts
                WHERE account_type = 'system' AND currency = 'NGN'
                  AND system_account_role = 'paystack_ngn_clearing' AND status = 'active'
             ) AS clearing_account_available`)
      ]);
      const paystackAvailable = paystackTable.rows[0]?.available === true &&
        paystackTable.rows[0]?.clearing_account_available === true;
      const paystackResult = paystackTable.rows[0]?.available === true
        ? await pool.query(
            `SELECT d.transaction_id, d.reference, d.amount_minor::text AS amount_minor,
                    d.currency, d.status, d.created_at, d.verified_at
               FROM public.fp_paystack_deposits AS d
              WHERE d.user_id = $1
              ORDER BY d.created_at DESC LIMIT 100`, [userId])
        : { rows: [] as Array<Record<string, unknown>> };
      const deposits = [
        ...flutterwaveResult.rows.map(row => ({
          id: row.transaction_id, provider: "Flutterwave", reference: row.provider_tx_ref,
          amountMinor: row.amount_minor, currency: String(row.currency).trim(),
          status: row.status, createdAt: row.created_at, verifiedAt: row.verified_at
        })),
        ...paystackResult.rows.map(row => ({
          id: row.transaction_id, provider: "Paystack", reference: row.reference,
          amountMinor: row.amount_minor, currency: String(row.currency).trim(),
          status: row.status, createdAt: row.created_at, verifiedAt: row.verified_at
        }))
      ].sort((a, b) => new Date(b.verifiedAt ?? b.createdAt).getTime() - new Date(a.verifiedAt ?? a.createdAt).getTime()).slice(0, 100);
      const paystackConfigured = paystackAvailable &&
        process.env.PAYSTACK_ENVIRONMENT === "test" &&
        (process.env.PAYSTACK_SECRET_KEY ?? "").startsWith("sk_test_") &&
        (process.env.PAYSTACK_CALLBACK_URL ?? "").startsWith("https://") &&
        Number.isSafeInteger(Number(process.env.PAYSTACK_DEPOSIT_MIN_MINOR)) &&
        Number(process.env.PAYSTACK_DEPOSIT_MIN_MINOR) > 0 &&
        Number.isSafeInteger(Number(process.env.PAYSTACK_DEPOSIT_MAX_MINOR)) &&
        Number(process.env.PAYSTACK_DEPOSIT_MAX_MINOR) >= Number(process.env.PAYSTACK_DEPOSIT_MIN_MINOR);
      send(res, 200, {
        deposits, environment: "test", livePaymentsEnabled: false,
        depositProviders: { paystack: paystackConfigured, flutterwave: false }
      });
    } catch (error) {
      if (error instanceof Error && ["JWTExpired","JWSSignatureVerificationFailed","JWTClaimValidationFailed","JWSInvalid","JWTInvalid"].includes(error.name)) { send(res, 401, { error: "INVALID_SESSION" }); return; }
      console.error("FlowPay money received request failed:", error instanceof Error ? error.message : "unknown money received error");
      send(res, 503, { error: "MONEY_RECEIVED_SERVICE_UNAVAILABLE" });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/customer/cards") {
    if (!pool || !jwks || !issuer || !audience) { send(res, 503, { error: "CARDS_SERVICE_NOT_CONFIGURED" }); return; }
    const match = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) { send(res, 401, { error: "AUTHENTICATION_REQUIRED" }); return; }
    try {
      const { payload } = await jwtVerify(match[1], jwks, { algorithms: ["EdDSA"], issuer, audience });
      if (typeof payload.sub !== "string" || !payload.sub) { send(res, 401, { error: "INVALID_SESSION" }); return; }
      const identity = await pool.query(
        `SELECT app_user.id, auth_user.name AS cardholder_name
           FROM neon_auth."user" AS auth_user
           JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
          WHERE auth_user.id::text = $1 AND auth_user."emailVerified" = true
            AND app_user.status = 'active' LIMIT 1`, [payload.sub]);
      if (identity.rowCount !== 1) { send(res, 403, { error: "ACTIVE_CUSTOMER_ACCOUNT_REQUIRED" }); return; }
      const result = await pool.query(
        `SELECT id, provider, card_type, status, last4, expiry_month, expiry_year, created_at, updated_at
           FROM public.fp_cards
          WHERE user_id = $1
          ORDER BY created_at DESC`, [identity.rows[0].id]);
      send(res, 200, {
        cardholderName: typeof identity.rows[0].cardholder_name === "string" && identity.rows[0].cardholder_name.trim()
          ? identity.rows[0].cardholder_name.trim() : null,
        cards: result.rows.map(row => ({
          id: row.id, provider: row.provider, type: row.card_type, status: row.status,
          last4: row.last4 ? String(row.last4).trim() : null,
          expiryMonth: row.expiry_month, expiryYear: row.expiry_year,
          createdAt: row.created_at, updatedAt: row.updated_at
        })),
        actionsEnabled: false,
        cardIssuanceAvailable: false
      });
    } catch (error) {
      if (error instanceof Error && ["JWTExpired","JWSSignatureVerificationFailed","JWTClaimValidationFailed","JWSInvalid","JWTInvalid"].includes(error.name)) { send(res, 401, { error: "INVALID_SESSION" }); return; }
      console.error("FlowPay customer cards request failed:", error instanceof Error ? error.message : "unknown cards error");
      send(res, 503, { error: "CARDS_SERVICE_UNAVAILABLE" });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/customer/activity") {
    if (!pool || !jwks || !issuer || !audience) { send(res, 503, { error: "ACTIVITY_SERVICE_NOT_CONFIGURED" }); return; }
    const match = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) { send(res, 401, { error: "AUTHENTICATION_REQUIRED" }); return; }
    try {
      const { payload } = await jwtVerify(match[1], jwks, { algorithms: ["EdDSA"], issuer, audience });
      if (typeof payload.sub !== "string" || !payload.sub) { send(res, 401, { error: "INVALID_SESSION" }); return; }
      const identity = await pool.query(
        `SELECT app_user.id
           FROM neon_auth."user" AS auth_user
           JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
          WHERE auth_user.id::text = $1 AND auth_user."emailVerified" = true
            AND app_user.status = 'active' LIMIT 1`, [payload.sub]);
      if (identity.rowCount !== 1) { send(res, 403, { error: "ACTIVE_CUSTOMER_ACCOUNT_REQUIRED" }); return; }
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      const parsedLimit = Number(params.get("limit") ?? "50");
      const parsedOffset = Number(params.get("offset") ?? "0");
      const limit = Number.isInteger(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 50;
      const offset = Number.isInteger(parsedOffset) ? Math.min(2147483647, Math.max(0, parsedOffset)) : 0;
      const fromDate = params.get("fromDate");
      const toDate = params.get("toDate");
      const validDate = (value: string | null) => {
        if (value === null) return true;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const parsed = new Date(value + "T00:00:00.000Z");
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
      };
      if (!validDate(fromDate) || !validDate(toDate) || (fromDate && toDate && fromDate > toDate)) {
        send(res, 400, { error: "INVALID_ACTIVITY_DATE_RANGE" }); return;
      }
      const dateValues = [identity.rows[0].id, fromDate, toDate];
      const [result, count] = await Promise.all([
        pool.query(
          `SELECT t.id, t.transaction_type, t.description, t.status, t.created_at, t.posted_at,
                  e.currency, SUM(e.amount_minor)::text AS customer_ledger_amount_minor,
                  CASE WHEN SUM(e.amount_minor) > 0 THEN 'received'
                       WHEN SUM(e.amount_minor) < 0 THEN 'sent'
                       ELSE 'neutral' END AS direction,
                  COUNT(e.id)::int AS customer_entry_count
             FROM public.fp_ledger_transactions AS t
             JOIN public.fp_ledger_entries AS e ON e.transaction_id = t.id
             JOIN public.fp_accounts AS a ON a.id = e.account_id
            WHERE a.user_id = $1 AND a.account_type = 'customer'
              AND t.status IN ('posted', 'reversed')
              AND ($2::date IS NULL OR COALESCE(t.posted_at, t.created_at) >= $2::date)
              AND ($3::date IS NULL OR COALESCE(t.posted_at, t.created_at) < ($3::date + INTERVAL '1 day'))
            GROUP BY t.id, e.currency
            ORDER BY COALESCE(t.posted_at, t.created_at) DESC, t.id
            LIMIT $4 OFFSET $5`, [...dateValues, limit, offset]),
        pool.query(
          `SELECT COUNT(*)::int AS total
             FROM (
               SELECT t.id, e.currency
                 FROM public.fp_ledger_transactions AS t
                 JOIN public.fp_ledger_entries AS e ON e.transaction_id = t.id
                 JOIN public.fp_accounts AS a ON a.id = e.account_id
                WHERE a.user_id = $1 AND a.account_type = 'customer'
                  AND t.status IN ('posted', 'reversed')
                  AND ($2::date IS NULL OR COALESCE(t.posted_at, t.created_at) >= $2::date)
                  AND ($3::date IS NULL OR COALESCE(t.posted_at, t.created_at) < ($3::date + INTERVAL '1 day'))
                GROUP BY t.id, e.currency
             ) AS matching`, dateValues)
      ]);
      const total = count.rows[0]?.total ?? 0;
      send(res, 200, {
        transactions: result.rows.map(row => ({
          id: row.id, type: row.transaction_type, description: row.description ?? "",
          status: row.status, createdAt: row.created_at, postedAt: row.posted_at,
          currency: String(row.currency).trim(),
          customerLedgerAmountMinor: row.customer_ledger_amount_minor,
          direction: row.direction,
          customerEntryCount: row.customer_entry_count
        })),
        limit, offset, nextOffset: offset + result.rows.length, total, hasMore: offset + result.rows.length < total,
        directionAvailable: true,
        directionNote: "Direction is calculated from the signed customer ledger entries: positive is received, negative is sent, and zero is neutral."
      });
    } catch (error) {
      if (error instanceof Error && ["JWTExpired","JWSSignatureVerificationFailed","JWTClaimValidationFailed","JWSInvalid","JWTInvalid"].includes(error.name)) { send(res, 401, { error: "INVALID_SESSION" }); return; }
      console.error("FlowPay customer activity request failed:", error instanceof Error ? error.message : "unknown activity error");
      send(res, 503, { error: "ACTIVITY_SERVICE_UNAVAILABLE" });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/customer/account-details") {
    if (!pool || !jwks || !issuer || !audience) { send(res, 503, { error: "ACCOUNT_DETAILS_SERVICE_NOT_CONFIGURED" }); return; }
    const match = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) { send(res, 401, { error: "AUTHENTICATION_REQUIRED" }); return; }
    try {
      const { payload } = await jwtVerify(match[1], jwks, { algorithms: ["EdDSA"], issuer, audience });
      if (typeof payload.sub !== "string" || !payload.sub) { send(res, 401, { error: "INVALID_SESSION" }); return; }
      const identity = await pool.query(
        `SELECT app_user.id FROM neon_auth."user" AS auth_user
           JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
          WHERE auth_user.id::text = $1 AND auth_user."emailVerified" = true
            AND app_user.status = 'active' LIMIT 1`, [payload.sub]);
      if (identity.rowCount !== 1) { send(res, 403, { error: "ACTIVE_CUSTOMER_ACCOUNT_REQUIRED" }); return; }
      await pool.query(
        `INSERT INTO public.fp_customer_account_numbers (user_id, account_number)
         SELECT $1, nextval('public.fp_customer_account_number_seq')::TEXT
         WHERE NOT EXISTS (
           SELECT 1 FROM public.fp_customer_account_numbers WHERE user_id = $1
         )
         ON CONFLICT DO NOTHING`,
        [identity.rows[0].id]
      );
      const [accounts, flowpayAccount] = await Promise.all([
        pool.query(
          `SELECT currency, status, created_at
             FROM public.fp_accounts
            WHERE user_id = $1 AND account_type = 'customer'
            ORDER BY currency, created_at`, [identity.rows[0].id]),
        pool.query(
          `SELECT account_number FROM public.fp_customer_account_numbers
            WHERE user_id = $1 LIMIT 1`, [identity.rows[0].id])
      ]);
      send(res, 200, {
        walletAccounts: accounts.rows.map(row => ({
          currency: String(row.currency).trim(), status: row.status, createdAt: row.created_at
        })),
        flowpayAccountNumber: flowpayAccount.rows[0]?.account_number?.trim() ?? null,
        virtualBankAccount: { assigned: false, accountNumber: null, bankName: null, accountName: null },
        message: "Your FlowPay account number is for wallet-to-wallet transfers. It is not a provider-issued virtual bank account number."
      });
    } catch (error) {
      if (error instanceof Error && ["JWTExpired","JWSSignatureVerificationFailed","JWTClaimValidationFailed","JWSInvalid","JWTInvalid"].includes(error.name)) { send(res, 401, { error: "INVALID_SESSION" }); return; }
      console.error("FlowPay customer account details request failed:", error instanceof Error ? error.message : "unknown account details error");
      send(res, 503, { error: "ACCOUNT_DETAILS_SERVICE_UNAVAILABLE" });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/customer/security") {
    if (!pool || !jwks || !issuer || !audience) { send(res, 503, { error: "SECURITY_SERVICE_NOT_CONFIGURED" }); return; }
    const match = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) { send(res, 401, { error: "AUTHENTICATION_REQUIRED" }); return; }
    try {
      const { payload } = await jwtVerify(match[1], jwks, { algorithms: ["EdDSA"], issuer, audience });
      if (typeof payload.sub !== "string" || !payload.sub) { send(res, 401, { error: "INVALID_SESSION" }); return; }
      const identity = await pool.query(
        `SELECT app_user.id FROM neon_auth."user" AS auth_user
           JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
          WHERE auth_user.id::text = $1 AND auth_user."emailVerified" = true
            AND app_user.status = 'active' LIMIT 1`, [payload.sub]);
      if (identity.rowCount !== 1) { send(res, 403, { error: "ACTIVE_CUSTOMER_ACCOUNT_REQUIRED" }); return; }
      const userId = identity.rows[0].id;
      const [passkeys, events] = await Promise.all([
        pool.query(
          `SELECT name, device_type, backed_up, created_at, last_used_at
             FROM public.fp_passkeys
            WHERE user_id = $1 AND revoked_at IS NULL
            ORDER BY created_at DESC LIMIT 25`, [userId]),
        pool.query(
          `SELECT event_type, outcome, created_at
             FROM public.fp_security_audit_events
            WHERE user_id = $1
            ORDER BY created_at DESC LIMIT 20`, [userId])
      ]);
      send(res, 200, {
        passkeys: passkeys.rows.map(row => ({
          name: row.name, deviceType: row.device_type, backedUp: row.backed_up,
          createdAt: row.created_at, lastUsedAt: row.last_used_at
        })),
        recentEvents: events.rows.map(row => ({
          type: row.event_type, outcome: row.outcome, createdAt: row.created_at
        })),
        capabilities: {
          passkeyRegistrationEnabled: false,
          passwordChangeEnabled: false,
          twoStepVerificationEnabled: false,
          sessionRevocationEnabled: false,
          transactionPinEnabled: false
        },
        message: "This page shows recorded security data only. Enrollment and account-security changes remain disabled until their verified flows are implemented."
      });
    } catch (error) {
      if (error instanceof Error && ["JWTExpired","JWSSignatureVerificationFailed","JWTClaimValidationFailed","JWSInvalid","JWTInvalid"].includes(error.name)) { send(res, 401, { error: "INVALID_SESSION" }); return; }
      console.error("FlowPay customer security request failed:", error instanceof Error ? error.message : "unknown security error");
      send(res, 503, { error: "SECURITY_SERVICE_UNAVAILABLE" });
    }
    return;
  }

  if ((req.method === "GET" || req.method === "PATCH") && pathname === "/customer/profile") {
    if (!pool || !jwks || !issuer || !audience) { send(res, 503, { error: "PROFILE_SERVICE_NOT_CONFIGURED" }); return; }
    const match = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) { send(res, 401, { error: "AUTHENTICATION_REQUIRED" }); return; }
    try {
      const { payload } = await jwtVerify(match[1], jwks, { algorithms: ["EdDSA"], issuer, audience });
      if (typeof payload.sub !== "string" || !payload.sub) { send(res, 401, { error: "INVALID_SESSION" }); return; }
      const identity = await pool.query(
        `SELECT app_user.id, auth_user.name, auth_user.email
           FROM neon_auth."user" AS auth_user
           JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
          WHERE auth_user.id::text = $1 AND auth_user."emailVerified" = true
            AND app_user.status = 'active' LIMIT 1`, [payload.sub]);
      if (identity.rowCount !== 1) { send(res, 403, { error: "ACTIVE_CUSTOMER_ACCOUNT_REQUIRED" }); return; }
      const userId = identity.rows[0].id;
      if (req.method === "GET") {
        const result = await pool.query(
          `SELECT phone_number, residential_address, updated_at, encode(photo_data, 'base64') AS photo_base64, photo_mime_type FROM public.fp_customer_profiles WHERE user_id = $1 LIMIT 1`, [userId]);
        const profile = result.rows[0] ?? {};
        send(res, 200, { profile: { fullName: identity.rows[0].name ?? "", email: identity.rows[0].email ?? "",
          phoneNumber: profile.phone_number ?? "", residentialAddress: profile.residential_address ?? "", photoUrl: profile.photo_base64 && profile.photo_mime_type ? `data:${profile.photo_mime_type};base64,${profile.photo_base64}` : null, updatedAt: profile.updated_at ?? null } });
        return;
      }
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (raw.length > 4_500_000) { send(res, 413, { error: "PROFILE_PAYLOAD_TOO_LARGE" }); return; } }
      let body: unknown;
      try { body = JSON.parse(raw || "{}"); } catch { send(res, 400, { error: "INVALID_JSON" }); return; }
      if (!body || typeof body !== "object" || Array.isArray(body)) { send(res, 400, { error: "INVALID_PROFILE_PAYLOAD" }); return; }
      const input = body as Record<string, unknown>;
      if (Object.keys(input).some(key => !["phoneNumber", "residentialAddress", "photoDataUrl"].includes(key))) { send(res, 400, { error: "UNSUPPORTED_PROFILE_FIELD" }); return; }
      const phone = typeof input.phoneNumber === "string" ? input.phoneNumber.trim() : "";
      const address = typeof input.residentialAddress === "string" ? input.residentialAddress.trim() : "";
      if (phone.length > 24 || (phone && !/^\+?[0-9][0-9 ()-]{6,22}$/.test(phone))) { send(res, 400, { error: "INVALID_PHONE_NUMBER" }); return; }
      if (address.length > 500) { send(res, 400, { error: "ADDRESS_TOO_LONG" }); return; }
      let photoData: Buffer | null = null;
      let photoMime: string | null = null;
      const photoProvided = Object.prototype.hasOwnProperty.call(input, "photoDataUrl");
      if (photoProvided && input.photoDataUrl !== null && input.photoDataUrl !== "") {
        if (typeof input.photoDataUrl !== "string") { send(res, 400, { error: "INVALID_PROFILE_PHOTO" }); return; }
        const photoMatch = input.photoDataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
        if (!photoMatch) { send(res, 400, { error: "INVALID_PROFILE_PHOTO" }); return; }
        photoData = Buffer.from(photoMatch[2], "base64");
        if (!photoData.length || photoData.length > 3 * 1024 * 1024) { send(res, 413, { error: "PROFILE_PAYLOAD_TOO_LARGE" }); return; }
        photoMime = photoMatch[1];
      }
      const saved = await pool.query(
        `INSERT INTO public.fp_customer_profiles (user_id, phone_number, residential_address, photo_data, photo_mime_type, updated_at)
         VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), $4, $5, NOW())
         ON CONFLICT (user_id) DO UPDATE SET phone_number = EXCLUDED.phone_number,
           residential_address = EXCLUDED.residential_address,
           photo_data = CASE WHEN $6 THEN EXCLUDED.photo_data ELSE public.fp_customer_profiles.photo_data END,
           photo_mime_type = CASE WHEN $6 THEN EXCLUDED.photo_mime_type ELSE public.fp_customer_profiles.photo_mime_type END,
           updated_at = NOW()
         RETURNING phone_number, residential_address, updated_at, encode(photo_data, 'base64') AS photo_base64, photo_mime_type`,
        [userId, phone, address, photoData, photoMime, photoProvided]);
      send(res, 200, { saved: true, profile: { fullName: identity.rows[0].name ?? "", email: identity.rows[0].email ?? "",
        phoneNumber: saved.rows[0].phone_number ?? "", residentialAddress: saved.rows[0].residential_address ?? "",
        photoUrl: saved.rows[0].photo_base64 && saved.rows[0].photo_mime_type ? `data:${saved.rows[0].photo_mime_type};base64,${saved.rows[0].photo_base64}` : null,
        updatedAt: saved.rows[0].updated_at } });
    } catch (error) {
      if (error instanceof Error && ["JWTExpired","JWSSignatureVerificationFailed","JWTClaimValidationFailed","JWSInvalid","JWTInvalid"].includes(error.name)) { send(res, 401, { error: "INVALID_SESSION" }); return; }
      console.error("FlowPay customer profile request failed:", error instanceof Error ? error.message : "unknown error");
      send(res, 503, { error: "PROFILE_SERVICE_UNAVAILABLE" });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/admin/session") {
    if (!pool || !jwks || !issuer || !audience) {
      send(res, 503, { error: "ADMIN_AUTH_NOT_CONFIGURED" }); return;
    }
    const authorization = req.headers.authorization;
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) { send(res, 401, { error: "AUTHENTICATION_REQUIRED" }); return; }
    try {
      const { payload } = await jwtVerify(match[1], jwks, {
        algorithms: ["EdDSA"],
        issuer,
        audience
      });
      if (typeof payload.sub !== "string" || !payload.sub) {
        send(res, 401, { error: "INVALID_SESSION" }); return;
      }
      const result = await pool.query(
        `SELECT 1
           FROM neon_auth."user" AS auth_user
           JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
          WHERE auth_user.id::text = $1
            AND auth_user."emailVerified" = true
            AND app_user.status = 'active'
            AND app_user.role = 'super_admin'
          LIMIT 1`,
        [payload.sub]
      );
      if (result.rowCount !== 1) { send(res, 403, { error: "SUPER_ADMIN_ACCESS_REQUIRED" }); return; }
      send(res, 200, { authenticated: true, authorized: true, role: "super_admin" });
    } catch (error) {
      if (error instanceof Error && (error.name === "JWTExpired" || error.name === "JWSSignatureVerificationFailed" || error.name === "JWTClaimValidationFailed" || error.name === "JWSInvalid" || error.name === "JWTInvalid")) {
        send(res, 401, { error: "INVALID_SESSION" }); return;
      }
      console.error("FlowPay admin authorization failed:", error instanceof Error ? error.message : "unknown error");
      send(res, 503, { error: "ADMIN_AUTH_UNAVAILABLE" });
    }
    return;
  }

  send(res, 404, { error: "NOT_FOUND" });
});

server.listen(port, "0.0.0.0", () => console.log(`FlowPay API listening on port ${port}`));
async function shutdown() {
  server.close();
  if (pool) await pool.end();
}
process.on("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.on("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
