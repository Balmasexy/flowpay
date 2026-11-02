import { createPublicKey, timingSafeEqual, verify as verifySignature } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Pool } from "pg";
import { handlePasskeyRoute } from "./passkeys.js";

const port = Number(process.env.PORT ?? 3000);
const databaseUrl = process.env.DATABASE_URL?.trim();
const pool = databaseUrl ? new Pool({
  connectionString: databaseUrl,
  max: 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle: true
}) : null;

pool?.on("error", (error) => console.error("FlowPay database pool error:", error.message));
const allowedOrigins = new Set(
  [process.env.WEB_ORIGIN, "http://localhost:5173", "https://localhost"].filter(
    (origin): origin is string => Boolean(origin)
  )
);

type Jwk = { kid?: string; kty?: string; use?: string; alg?: string; [key: string]: unknown };
type JwtClaims = { sub?: string; iss?: string; aud?: string | string[]; exp?: number; nbf?: number };
type AuthResult = { subject: string } | { error: "missing" | "invalid" | "not_configured" };
type Customer = { id: string; email: string | null; status: string; created_at: Date };
let jwksCache: { expiresAt: number; keys: Jwk[] } | null = null;

function authConfig() {
  const jwksUrl = process.env.NEON_AUTH_JWKS_URL?.trim();
  const issuer = process.env.NEON_AUTH_ISSUER?.trim();
  const audience = process.env.NEON_AUTH_AUDIENCE?.trim();
  if (!jwksUrl || !issuer || !audience) return null;
  try { if (new URL(jwksUrl).protocol !== "https:") return null; }
  catch { return null; }
  return { jwksUrl, issuer, audience };
}

async function getJwks(jwksUrl: string): Promise<Jwk[]> {
  if (jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const response = await fetch(jwksUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error("JWKS endpoint unavailable");
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("keys" in body) || !Array.isArray(body.keys)) {
    throw new Error("Invalid JWKS response");
  }
  const keys = body.keys.filter((key): key is Jwk =>
    typeof key === "object" && key !== null &&
    "kid" in key && typeof key.kid === "string" &&
    "kty" in key &&
    ((key.kty === "RSA" && (!("alg" in key) || key.alg === "RS256")) ||
      (key.kty === "OKP" && "crv" in key && key.crv === "Ed25519" &&
        (!("alg" in key) || key.alg === "EdDSA"))) &&
    (!("use" in key) || key.use === "sig")
  );
  if (keys.length === 0) throw new Error("No supported signing keys found");
  jwksCache = { keys, expiresAt: Date.now() + 5 * 60_000 };
  return keys;
}

async function authenticate(req: IncomingMessage): Promise<AuthResult> {
  const authorization = req.headers.authorization;
  if (!authorization) return { error: "missing" };
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization);
  if (!match || match[1].length > 16_384) return { error: "invalid" };
  const config = authConfig();
  if (!config) return { error: "not_configured" };
  try {
    const parts = match[1].split(".");
    if (parts.length !== 3) return { error: "invalid" };
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { alg?: string; kid?: string };
    if ((header.alg !== "RS256" && header.alg !== "EdDSA") || typeof header.kid !== "string") return { error: "invalid" };
    const keys = await getJwks(config.jwksUrl);
    const jwk = keys.find((key) => key.kid === header.kid);
    if (!jwk) { jwksCache = null; return { error: "invalid" }; }
    const publicKey = createPublicKey({ key: JSON.parse(JSON.stringify(jwk)), format: "jwk" });
    const verificationAlgorithm = header.alg === "EdDSA" ? null : "RSA-SHA256";
    if (!verifySignature(verificationAlgorithm, Buffer.from(parts[0] + "." + parts[1]), publicKey, Buffer.from(parts[2], "base64url"))) {
      return { error: "invalid" };
    }
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as JwtClaims;
    const now = Math.floor(Date.now() / 1000);
    const audienceMatches = Array.isArray(claims.aud) ? claims.aud.includes(config.audience) : claims.aud === config.audience;
    if (typeof claims.sub !== "string" || !claims.sub.trim() ||
      claims.iss !== config.issuer || !audienceMatches ||
      typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= now ||
      (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > now))) {
      return { error: "invalid" };
    }
    return { subject: claims.sub };
  } catch {
    return { error: "invalid" };
  }
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

async function getCustomer(subject: string): Promise<Customer | null> {
  if (!pool) throw new Error("DATABASE_NOT_CONFIGURED");
  const result = await pool.query<Customer>(
    "SELECT id, email, status, created_at FROM fp_users WHERE auth_subject = $1 LIMIT 1",
    [subject]
  );
  const customer = result.rows[0];
  if (!customer) return null;
  if (customer.status !== "active") throw new Error("CUSTOMER_PROFILE_INACTIVE");
  return customer;
}

function authError(res: ServerResponse, error: "missing" | "invalid" | "not_configured") {
  if (error === "not_configured") sendJson(res, 503, { error: "AUTH_NOT_CONFIGURED" });
  else if (error === "missing") sendJson(res, 401, { error: "AUTHENTICATION_REQUIRED" });
  else sendJson(res, 401, { error: "INVALID_ACCESS_TOKEN" });
}

async function handleProtected(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL) {
  const auth = await authenticate(req);
  if ("error" in auth) { authError(res, auth.error); return; }
  if (!pool) { sendJson(res, 503, { error: "DATABASE_NOT_CONFIGURED" }); return; }

  let customer: Customer | null;
  try {
    customer = await getCustomer(auth.subject);
  } catch (error) {
    if (error instanceof Error && error.message === "CUSTOMER_PROFILE_INACTIVE") {
      sendJson(res, 403, { error: "CUSTOMER_PROFILE_INACTIVE" });
    } else {
      sendJson(res, 503, { error: "CUSTOMER_DATA_UNAVAILABLE" });
    }
    return;
  }
  if (!customer) { sendJson(res, 404, { error: "CUSTOMER_PROFILE_NOT_FOUND" }); return; }

  try {
    if (req.method !== "GET") { sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" }); return; }

    if (pathname === "/v1/me/profile") {
      sendJson(res, 200, { profile: {
        id: customer.id, email: customer.email, status: customer.status, created_at: customer.created_at
      }});
      return;
    }

    if (pathname === "/v1/me/accounts") {
      const result = await pool.query(
        `SELECT a.id, a.currency, a.status,
          COALESCE(SUM(e.amount_minor) FILTER (WHERE t.status = 'posted'), 0)::text AS ledger_balance_minor
         FROM fp_accounts a
         LEFT JOIN fp_ledger_entries e ON e.account_id = a.id
         LEFT JOIN fp_ledger_transactions t ON t.id = e.transaction_id
         WHERE a.user_id = $1 AND a.account_type = 'customer'
         GROUP BY a.id, a.currency, a.status, a.created_at
         ORDER BY a.created_at ASC, a.id ASC`,
        [customer.id]
      );
      sendJson(res, 200, { accounts: result.rows.map((row) => ({
        ...row, currency: String(row.currency).trim(), ledger_balance_minor: String(row.ledger_balance_minor)
      })) });
      return;
    }

    if (pathname === "/v1/me/summary") {
      const result = await pool.query(
        `SELECT a.currency,
          COALESCE(SUM(e.amount_minor) FILTER (WHERE t.status = 'posted'), 0)::text AS net_balance_minor,
          COALESCE(SUM(e.amount_minor) FILTER (WHERE t.status = 'posted' AND e.amount_minor > 0), 0)::text AS money_received_minor,
          COALESCE(-SUM(e.amount_minor) FILTER (WHERE t.status = 'posted' AND e.amount_minor < 0), 0)::text AS money_sent_minor
         FROM fp_accounts a
         LEFT JOIN fp_ledger_entries e ON e.account_id = a.id
         LEFT JOIN fp_ledger_transactions t ON t.id = e.transaction_id
         WHERE a.user_id = $1 AND a.account_type = 'customer'
         GROUP BY a.currency ORDER BY a.currency`,
        [customer.id]
      );
      sendJson(res, 200, { totals: result.rows.map((row) => ({
        currency: String(row.currency).trim(),
        net_balance_minor: String(row.net_balance_minor),
        money_received_minor: String(row.money_received_minor),
        money_sent_minor: String(row.money_sent_minor)
      })) });
      return;
    }

    if (pathname === "/v1/me/transactions") {
      const requested = url.searchParams.get("type") ?? "all";
      if (!["all", "received", "sent", "transfers"].includes(requested)) {
        sendJson(res, 400, { error: "INVALID_TRANSACTION_FILTER" }); return;
      }
      const limitRaw = Number(url.searchParams.get("limit") ?? "50");
      const limit = Number.isInteger(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 50;
      const filter = requested === "received" ? "AND t.status = 'posted' AND e.amount_minor > 0"
        : requested === "sent" ? "AND t.status = 'posted' AND e.amount_minor < 0"
        : requested === "transfers" ? "AND t.transaction_type ILIKE '%transfer%'" : "";
      const result = await pool.query(
        `SELECT t.id, t.transaction_type, t.status, t.description, t.created_at,
          e.currency, SUM(e.amount_minor)::text AS amount_minor
         FROM fp_ledger_transactions t
         JOIN fp_ledger_entries e ON e.transaction_id = t.id
         JOIN fp_accounts a ON a.id = e.account_id
         WHERE a.user_id = $1 AND a.account_type = 'customer' ${filter}
         GROUP BY t.id, t.transaction_type, t.status, t.description, t.created_at, e.currency
         ORDER BY t.created_at DESC, t.id DESC LIMIT $2`,
        [customer.id, limit]
      );
      sendJson(res, 200, { transactions: result.rows.map((row) => ({
        ...row, currency: String(row.currency).trim(), amount_minor: String(row.amount_minor)
      })) });
      return;
    }

    if (pathname === "/v1/me/cards") {
      const result = await pool.query(
        `SELECT id, card_type, status, last4, expiry_month, expiry_year, created_at, updated_at
         FROM fp_cards WHERE user_id = $1 ORDER BY created_at DESC, id DESC`,
        [customer.id]
      );
      sendJson(res, 200, { cards: result.rows });
      return;
    }

    if (pathname === "/v1/me/card-events") {
      const limitRaw = Number(url.searchParams.get("limit") ?? "50");
      const limit = Number.isInteger(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 50;
      const result = await pool.query(
        `SELECT e.id, e.card_id, e.event_type, e.outcome, e.created_at
         FROM fp_card_events e
         JOIN fp_cards c ON c.id = e.card_id
         WHERE c.user_id = $1
         ORDER BY e.created_at DESC, e.id DESC LIMIT $2`,
        [customer.id, limit]
      );
      sendJson(res, 200, { events: result.rows });
      return;
    }

    const cardEventMatch = /^\/v1\/me\/cards\/([0-9a-f-]{36})\/events$/.exec(pathname);
    if (cardEventMatch) {
      const result = await pool.query(
        `SELECT e.id, e.event_type, e.outcome, e.created_at
         FROM fp_card_events e
         JOIN fp_cards c ON c.id = e.card_id
         WHERE c.id = $1 AND c.user_id = $2
         ORDER BY e.created_at DESC, e.id DESC LIMIT 100`,
        [cardEventMatch[1], customer.id]
      );
      sendJson(res, 200, { events: result.rows });
      return;
    }

    sendJson(res, 404, { error: "NOT_FOUND" });
  } catch (error) {
    console.error("FlowPay customer read API failed:", error instanceof Error ? error.message : "unknown error");
    sendJson(res, 503, { error: "CUSTOMER_DATA_UNAVAILABLE", detail: "Required read-only data is unavailable. Verify database migrations and schema." });
  }
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key, X-FlowPay-Bootstrap-Token");
  }
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Development-only ledger simulation. Never calls OPay or any payment provider.
  if (req.method === "POST" && pathname === "/dev/simulated-transfers/opay") {
    if (process.env.NODE_ENV !== "development" || process.env.FLOWPAY_SIMULATED_TRANSFERS_ENABLED !== "true") {
      sendJson(res, 404, { error: "NOT_FOUND" });
      return;
    }
    const auth = await authenticate(req);
    if ("error" in auth) { authError(res, auth.error); return; }
    if (!pool) { sendJson(res, 503, { error: "DATABASE_NOT_CONFIGURED" }); return; }
    const idempotencyKey = req.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      sendJson(res, 400, { error: "INVALID_IDEMPOTENCY_KEY" }); return;
    }
    let rawBody = "";
    try {
      for await (const chunk of req) {
        rawBody += chunk.toString("utf8");
        if (rawBody.length > 4096) {
          sendJson(res, 413, { error: "REQUEST_TOO_LARGE" }); return;
        }
      }
    } catch {
      sendJson(res, 400, { error: "INVALID_REQUEST_BODY" }); return;
    }
    let body: unknown;
    try { body = JSON.parse(rawBody); }
    catch { sendJson(res, 400, { error: "INVALID_JSON" }); return; }
    if (typeof body !== "object" || body === null) {
      sendJson(res, 400, { error: "INVALID_REQUEST_BODY" }); return;
    }
    const input = body as { accountId?: unknown; amountMinor?: unknown; destinationAccount?: unknown };
    if (typeof input.accountId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.accountId) ||
      typeof input.amountMinor !== "string" || !/^[1-9][0-9]{0,11}$/.test(input.amountMinor) ||
      typeof input.destinationAccount !== "string" || !/^[0-9]{10}$/.test(input.destinationAccount)) {
      sendJson(res, 400, { error: "INVALID_TRANSFER_FIELDS", details: "Provide accountId, positive amountMinor in kobo as a string, and a 10-digit simulated OPay account number." });
      return;
    }
    const amount = BigInt(input.amountMinor);
    if (amount > 100_000_000_000n) {
      sendJson(res, 400, { error: "AMOUNT_EXCEEDS_SIMULATION_LIMIT" }); return;
    }
    let customer: Customer | null;
    try { customer = await getCustomer(auth.subject); }
    catch (error) {
      sendJson(res, error instanceof Error && error.message === "CUSTOMER_PROFILE_INACTIVE" ? 403 : 503,
        { error: error instanceof Error && error.message === "CUSTOMER_PROFILE_INACTIVE" ? "CUSTOMER_PROFILE_INACTIVE" : "CUSTOMER_DATA_UNAVAILABLE" });
      return;
    }
    if (!customer) { sendJson(res, 404, { error: "CUSTOMER_PROFILE_NOT_FOUND" }); return; }

    const client = await pool.connect().catch(() => null);
    if (!client) { sendJson(res, 503, { error: "DATABASE_UNAVAILABLE" }); return; }
    try {
      await client.query("BEGIN");
      const accountResult = await client.query(
        "SELECT id, currency, status FROM fp_accounts WHERE id = $1 AND user_id = $2 AND account_type = 'customer' FOR UPDATE",
        [input.accountId, customer.id]
      );
      const account = accountResult.rows[0] as { id: string; currency: string; status: string } | undefined;
      if (!account) {
        await client.query("ROLLBACK");
        sendJson(res, 403, { error: "ACCOUNT_NOT_OWNED" }); return;
      }
      if (account.status !== "active") {
        await client.query("ROLLBACK");
        sendJson(res, 403, { error: "ACCOUNT_NOT_ACTIVE" }); return;
      }
      if (String(account.currency).trim() !== "NGN") {
        await client.query("ROLLBACK");
        sendJson(res, 400, { error: "ACCOUNT_CURRENCY_MUST_BE_NGN" }); return;
      }

      const replay = await client.query(
        `SELECT t.id, t.status, t.transaction_type, d.destination_account,
                COALESCE(-SUM(e.amount_minor) FILTER (WHERE e.account_id = $2), 0)::text AS amount_minor
         FROM fp_ledger_transactions t
         JOIN fp_ledger_entries e ON e.transaction_id = t.id
         JOIN fp_accounts a ON a.id = e.account_id
         LEFT JOIN fp_simulated_transfer_details d ON d.transaction_id = t.id
         WHERE t.idempotency_key = $1 AND a.id = $2
         GROUP BY t.id, d.destination_account`,
        [idempotencyKey, account.id]
      );
      if (replay.rows.length) {
        const previous = replay.rows[0] as { id: string; status: string; transaction_type: string; destination_account: string | null; amount_minor: string };
        if (previous.transaction_type !== "simulated_opay_transfer" ||
            previous.amount_minor !== input.amountMinor || previous.destination_account !== input.destinationAccount) {
          await client.query("ROLLBACK");
          sendJson(res, 409, { error: "IDEMPOTENCY_KEY_CONFLICT" }); return;
        }
        await client.query("COMMIT");
        sendJson(res, 200, { simulated: true, transactionId: previous.id, status: previous.status, amountMinor: previous.amount_minor, currency: "NGN", destination: "OPay", replayed: true });
        return;
      }

      const balanceResult = await client.query(
        `SELECT COALESCE(SUM(e.amount_minor) FILTER (WHERE t.status = 'posted'), 0)::text AS balance_minor
         FROM fp_ledger_entries e JOIN fp_ledger_transactions t ON t.id = e.transaction_id
         WHERE e.account_id = $1`,
        [account.id]
      );
      const balance = BigInt(String(balanceResult.rows[0]?.balance_minor ?? "0"));
      if (balance < amount) {
        await client.query("ROLLBACK");
        sendJson(res, 409, { error: "INSUFFICIENT_FUNDS" }); return;
      }
      const systemResult = await client.query(
        "SELECT id FROM fp_accounts WHERE account_type = 'system' AND currency = 'NGN' AND status = 'active' ORDER BY created_at, id LIMIT 1 FOR UPDATE"
      );
      const systemAccount = systemResult.rows[0] as { id: string } | undefined;
      if (!systemAccount) {
        await client.query("ROLLBACK");
        sendJson(res, 503, { error: "SIMULATION_CLEARING_ACCOUNT_NOT_CONFIGURED" }); return;
      }
      const transactionResult = await client.query(
        "INSERT INTO fp_ledger_transactions (idempotency_key, transaction_type, status, description) VALUES ($1, 'simulated_opay_transfer', 'pending', $2) RETURNING id",
        [idempotencyKey, "SIMULATED OPay transfer to ****" + input.destinationAccount.slice(-4)]
      );
      const transactionId = String(transactionResult.rows[0].id);
      await client.query(
        "INSERT INTO fp_ledger_entries (transaction_id, account_id, amount_minor, currency) VALUES ($1, $2, $3, 'NGN'), ($1, $4, $5, 'NGN')",
        [transactionId, account.id, (-amount).toString(), systemAccount.id, amount.toString()]
      );
      await client.query(
        "INSERT INTO fp_simulated_transfer_details (transaction_id, destination_account, simulation_only) VALUES ($1, $2, true)",
        [transactionId, input.destinationAccount]
      );
      await client.query(
        "UPDATE fp_ledger_transactions SET status = 'posted', posted_at = now() WHERE id = $1 AND status = 'pending'",
        [transactionId]
      );
      await client.query("COMMIT");
      sendJson(res, 201, { simulated: true, transactionId, status: "posted", amountMinor: input.amountMinor, currency: "NGN", destination: "OPay", destinationLast4: input.destinationAccount.slice(-4), replayed: false });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        sendJson(res, 409, { error: "IDEMPOTENCY_KEY_CONFLICT" });
      } else {
        console.error("FlowPay simulated transfer failed:", error instanceof Error ? error.message : "unknown error");
        sendJson(res, 503, { error: "SIMULATED_TRANSFER_UNAVAILABLE" });
      }
    } finally {
      client.release();
    }
    return;
  }
  if (req.method === "GET" && pathname === "/") {
    sendJson(res, 200, { service: "flowpay-api", status: "ok", endpoints: [
      "/health", "/ready", "/v1/me/profile", "/v1/me/accounts", "/v1/me/summary",
      "/v1/me/transactions", "/v1/me/cards", "/v1/me/card-events", "/v1/me/bootstrap"
    ]});
    return;
  }
  if (req.method === "GET" && pathname === "/health") {
    sendJson(res, 200, { service: "flowpay-api", status: "ok", environment: process.env.NODE_ENV ?? "development" });
    return;
  }
  if (req.method === "GET" && pathname === "/ready") {
    const requiredMigrations = ["001_core", "002_ledger_invariants", "003_customer_profile_cards", "004_passkeys_security", "005_admin_bootstrap"];
    if (!pool) {
      sendJson(res, 503, { service: "flowpay-api", status: "not_ready", database: "not_configured", schema: "unknown", payments: "disabled" });
      return;
    }
    let databaseName: string | undefined;
    try {
      const databaseResult = await pool.query<{ database_name: string }>("SELECT current_database() AS database_name");
      databaseName = databaseResult.rows[0]?.database_name;
    } catch (error) {
      console.error("FlowPay readiness database check failed:", error instanceof Error ? error.message : "unknown database error");
      sendJson(res, 503, { service: "flowpay-api", status: "not_ready", database: "unavailable", schema: "unknown", payments: "disabled" });
      return;
    }

    try {
      const migrationTable = await pool.query<{ exists: boolean }>(
        "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists"
      );
      if (!migrationTable.rows[0]?.exists) {
        sendJson(res, 503, {
          service: "flowpay-api", status: "not_ready", database: "connected", schema: "incomplete",
          database_name: databaseName, required_migrations: requiredMigrations,
          missing_migrations: requiredMigrations, payments: "disabled"
        });
        return;
      }
      const migrationResult = await pool.query<{ version: string }>(
        "SELECT version FROM schema_migrations WHERE version = ANY($1::text[])",
        [requiredMigrations]
      );
      const applied = new Set(migrationResult.rows.map((row) => row.version));
      const missingMigrations = requiredMigrations.filter((version) => !applied.has(version));
      if (missingMigrations.length > 0) {
        sendJson(res, 503, {
          service: "flowpay-api", status: "not_ready", database: "connected", schema: "incomplete",
          database_name: databaseName, required_migrations: requiredMigrations,
          missing_migrations: missingMigrations, payments: "disabled"
        });
        return;
      }
      sendJson(res, 200, {
        service: "flowpay-api", status: "ready", database: "connected", schema: "complete",
        database_name: databaseName, required_migrations: requiredMigrations,
        missing_migrations: [], payments: "disabled"
      });
    } catch (error) {
      console.error("FlowPay readiness schema check failed:", error instanceof Error ? error.message : "unknown schema error");
      sendJson(res, 503, {
        service: "flowpay-api", status: "not_ready", database: "connected", schema: "unavailable",
        database_name: databaseName, required_migrations: requiredMigrations,
        missing_migrations: requiredMigrations, payments: "disabled"
      });
    }
    return;
  }
  if (pathname === "/v1/admin/bootstrap") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
      return;
    }
    const auth = await authenticate(req);
    if ("error" in auth) { authError(res, auth.error); return; }
    const configuredToken = process.env.FLOWPAY_ADMIN_BOOTSTRAP_TOKEN;
    const suppliedToken = req.headers["x-flowpay-bootstrap-token"];
    if (!configuredToken || configuredToken.length < 32) {
      sendJson(res, 503, { error: "ADMIN_BOOTSTRAP_NOT_CONFIGURED" });
      return;
    }
    if (typeof suppliedToken !== "string" ||
      Buffer.byteLength(suppliedToken) !== Buffer.byteLength(configuredToken) ||
      !timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(configuredToken))) {
      sendJson(res, 403, { error: "ADMIN_BOOTSTRAP_FORBIDDEN" });
      return;
    }
    if (!pool) { sendJson(res, 503, { error: "DATABASE_NOT_CONFIGURED" }); return; }

    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      // Serialize competing first-admin attempts; only one can succeed.
      await client.query("SELECT pg_advisory_xact_lock(71020261029)");
      const admins = await client.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM fp_users WHERE role = 'admin'"
      );
      if (admins.rows[0]?.count !== "0") {
        await client.query("ROLLBACK");
        sendJson(res, 409, { error: "ADMIN_ALREADY_BOOTSTRAPPED" });
        return;
      }
      const promoted = await client.query<{ id: string }>(
        "UPDATE fp_users SET role = 'admin' WHERE auth_subject = $1 AND status = 'active' RETURNING id",
        [auth.subject]
      );
      if (promoted.rowCount !== 1) {
        await client.query("ROLLBACK");
        sendJson(res, 404, { error: "ACTIVE_LINKED_CUSTOMER_PROFILE_REQUIRED" });
        return;
      }
      await client.query(
        "INSERT INTO fp_admin_audit_events (user_id, auth_subject, action) VALUES ($1, $2, 'first_admin_bootstrap')",
        [promoted.rows[0].id, auth.subject]
      );
      await client.query("COMMIT");
      sendJson(res, 200, { status: "admin_bootstrapped", role: "admin", financial_actions: "disabled" });
    } catch (error) {
      if (client) {
        try { await client.query("ROLLBACK"); } catch { /* transaction may already be closed */ }
      }
      console.error("FlowPay admin bootstrap failed:", error instanceof Error ? error.message : "unknown error");
      sendJson(res, 503, { error: "ADMIN_BOOTSTRAP_UNAVAILABLE" });
    } finally {
      client?.release();
    }
    return;
  }
  if (pathname.startsWith("/v1/me/passkeys")) {
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const auth = await authenticate(req);
    if ("error" in auth) { authError(res, auth.error); return; }
    if (!pool) { sendJson(res, 503, { error: "DATABASE_NOT_CONFIGURED" }); return; }
    let customer: Customer | null;
    try {
      customer = await getCustomer(auth.subject);
    } catch (error) {
      if (error instanceof Error && error.message === "CUSTOMER_PROFILE_INACTIVE") {
        sendJson(res, 403, { error: "CUSTOMER_PROFILE_INACTIVE" });
      } else {
        sendJson(res, 503, { error: "CUSTOMER_DATA_UNAVAILABLE" });
      }
      return;
    }
    if (!customer) { sendJson(res, 404, { error: "CUSTOMER_PROFILE_NOT_FOUND" }); return; }
    await handlePasskeyRoute(req, res, pool, customer, pathname);
    return;
  }
  // Idempotently create the authenticated customer's FlowPay profile and internal NGN ledger account.
  // This does NOT create or imply a provider-issued bank account number.
  if (pathname === "/v1/me/bootstrap") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
      return;
    }
    const auth = await authenticate(req);
    if ("error" in auth) { authError(res, auth.error); return; }
    if (!pool) { sendJson(res, 503, { error: "DATABASE_NOT_CONFIGURED" }); return; }
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      const userResult = await client.query<{ id: string; status: string; email: string | null }>(
        `INSERT INTO fp_users (auth_subject, status)
         VALUES ($1, 'active')
         ON CONFLICT (auth_subject) WHERE auth_subject IS NOT NULL
         DO UPDATE SET auth_subject = EXCLUDED.auth_subject
         RETURNING id, status, email`,
        [auth.subject]
      );
      const user = userResult.rows[0];
      if (!user || user.status !== "active") {
        await client.query("ROLLBACK");
        sendJson(res, 403, { error: "CUSTOMER_PROFILE_INACTIVE" });
        return;
      }
      // Serialize account creation per user; repeated calls remain safe.
      await client.query("SELECT id FROM fp_users WHERE id = $1 FOR UPDATE", [user.id]);
      const accountResult = await client.query<{ id: string }>(
        "SELECT id FROM fp_accounts WHERE user_id = $1 AND account_type = 'customer' AND currency = 'NGN' ORDER BY created_at, id LIMIT 1",
        [user.id]
      );
      let accountId = accountResult.rows[0]?.id;
      let accountCreated = false;
      if (!accountId) {
        const created = await client.query<{ id: string }>(
          "INSERT INTO fp_accounts (user_id, account_type, currency, status) VALUES ($1, 'customer', 'NGN', 'active') RETURNING id",
          [user.id]
        );
        accountId = created.rows[0].id;
        accountCreated = true;
      }
      await client.query("COMMIT");
      sendJson(res, accountCreated ? 201 : 200, {
        status: "profile_ready",
        profile: { id: user.id, status: user.status },
        account: { id: accountId, currency: "NGN", status: "active" },
        bank_account_assignment: "pending_provider_integration",
        real_bank_account_number_available: false
      });
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => undefined);
      console.error("FlowPay customer bootstrap failed:", error instanceof Error ? error.message : "unknown error");
      sendJson(res, 503, { error: "CUSTOMER_BOOTSTRAP_UNAVAILABLE" });
    } finally {
      client?.release();
    }
    return;
  }

  if (pathname.startsWith("/v1/me/")) {
    if (!["GET", "OPTIONS"].includes(req.method ?? "")) { sendJson(res, 405, { error: "METHOD_NOT_ALLOWED", financial_actions: "disabled" }); return; }
    await handleProtected(req, res, pathname, url);
    return;
  }
  sendJson(res, 404, { error: "NOT_FOUND" });
});

server.listen(port, "0.0.0.0", () => console.log(`FlowPay API listening on port ${port}`));
async function shutdown() { server.close(); if (pool) await pool.end(); }
process.on("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.on("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
