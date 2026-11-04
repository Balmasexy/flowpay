import { createServer } from "node:http";
import { Pool } from "pg";
import { createRemoteJWKSet, jwtVerify } from "jose";

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
    res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && pathname === "/") {
    send(res, 200, { service: "flowpay-api", status: "ok", endpoints: ["/health", "/ready", "/admin/session", "/customer/profile", "/customer/overview", "/face-verification/status"] }); return;
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

  if (req.method === "GET" && pathname === "/face-verification/status") {
    const sandboxSelected = process.env.SMILE_ID_ENVIRONMENT === "sandbox";
    const callbackUrl = process.env.SMILE_ID_CALLBACK_URL?.trim() ?? "";
    const configured = sandboxSelected
      && Boolean(process.env.SMILE_ID_PARTNER_ID?.trim())
      && Boolean(process.env.SMILE_ID_API_KEY?.trim())
      && callbackUrl.startsWith("https://");
    send(res, 200, {
      provider: "smile_id",
      environment: "sandbox",
      configured,
      productionEnabled: false,
      verificationEnabled: false,
      message: configured
        ? "Sandbox credentials detected. Face verification submission remains disabled until the signed SDK flow and verified callback handler are deployed."
        : "Sandbox setup is incomplete. Configure the Smile ID sandbox environment variables on the API service.",
    });
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
      const [accounts, recentActivity, balanceRows] = await Promise.all([
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
          `SELECT a.currency, COUNT(e.id)::int AS posted_entry_count
             FROM public.fp_accounts AS a
             LEFT JOIN public.fp_ledger_entries AS e ON e.account_id = a.id
             LEFT JOIN public.fp_ledger_transactions AS t
               ON t.id = e.transaction_id AND t.status = 'posted'
            WHERE a.user_id = $1 AND a.account_type = 'customer' AND a.status = 'active'
            GROUP BY a.currency
            ORDER BY a.currency`, [userId])
      ]);
      // A zero balance is safe to present only when there are no posted ledger
      // entries at all. Non-zero ledgers remain hidden until their sign convention
      // is explicitly defined and verified.
      const hasPostedEntries = balanceRows.rows.some(row => Number(row.posted_entry_count) > 0);
      const zeroBalances = balanceRows.rows.map(row => ({ currency: row.currency, amountMinor: "0" }));
      send(res, 200, {
        overview: {
          accounts: accounts.rows.map(row => ({ currency: row.currency, status: row.status, count: row.account_count })),
          recentActivity: recentActivity.rows.map(row => ({
            id: row.id, type: row.transaction_type, description: row.description ?? "",
            status: row.status, createdAt: row.created_at, postedAt: row.posted_at
          })),
          balance: hasPostedEntries
            ? { available: false, reason: "LEDGER_SIGN_CONVENTION_NOT_CONFIGURED" }
            : { available: true, balances: zeroBalances },
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
