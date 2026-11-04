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
    send(res, 200, { service: "flowpay-api", status: "ok", endpoints: ["/health", "/ready", "/admin/session", "/customer/profile", "/face-verification/status"] }); return;
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


  if ((req.method === "GET" || req.method === "PATCH") && pathname === "/customer/profile") {
    if (!pool || !jwks || !issuer || !audience) { send(res, 503, { error: "PROFILE_SERVICE_NOT_CONFIGURED" }); return; }
    const match = req.headers.authorization?.match(/^Bearer\\s+(.+)$/i);
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
          `SELECT phone_number, residential_address, updated_at FROM public.fp_customer_profiles WHERE user_id = $1 LIMIT 1`, [userId]);
        const profile = result.rows[0] ?? {};
        send(res, 200, { profile: { fullName: identity.rows[0].name ?? "", email: identity.rows[0].email ?? "",
          phoneNumber: profile.phone_number ?? "", residentialAddress: profile.residential_address ?? "", updatedAt: profile.updated_at ?? null } });
        return;
      }
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (raw.length > 12_000) { send(res, 413, { error: "PROFILE_PAYLOAD_TOO_LARGE" }); return; } }
      let body: unknown;
      try { body = JSON.parse(raw || "{}"); } catch { send(res, 400, { error: "INVALID_JSON" }); return; }
      if (!body || typeof body !== "object" || Array.isArray(body)) { send(res, 400, { error: "INVALID_PROFILE_PAYLOAD" }); return; }
      const input = body as Record<string, unknown>;
      if (Object.keys(input).some(key => !["phoneNumber", "residentialAddress"].includes(key))) { send(res, 400, { error: "UNSUPPORTED_PROFILE_FIELD" }); return; }
      const phone = typeof input.phoneNumber === "string" ? input.phoneNumber.trim() : "";
      const address = typeof input.residentialAddress === "string" ? input.residentialAddress.trim() : "";
      if (phone.length > 24 || (phone && !/^\\+?[0-9][0-9 ()-]{6,22}$/.test(phone))) { send(res, 400, { error: "INVALID_PHONE_NUMBER" }); return; }
      if (address.length > 500) { send(res, 400, { error: "ADDRESS_TOO_LONG" }); return; }
      const saved = await pool.query(
        `INSERT INTO public.fp_customer_profiles (user_id, phone_number, residential_address, updated_at)
         VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), NOW())
         ON CONFLICT (user_id) DO UPDATE SET phone_number = EXCLUDED.phone_number,
           residential_address = EXCLUDED.residential_address, updated_at = NOW()
         RETURNING phone_number, residential_address, updated_at`, [userId, phone, address]);
      send(res, 200, { saved: true, profile: { fullName: identity.rows[0].name ?? "", email: identity.rows[0].email ?? "",
        phoneNumber: saved.rows[0].phone_number ?? "", residentialAddress: saved.rows[0].residential_address ?? "", updatedAt: saved.rows[0].updated_at } });
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
