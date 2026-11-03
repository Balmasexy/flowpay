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
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && pathname === "/") {
    send(res, 200, { service: "flowpay-api", status: "ok", endpoints: ["/health", "/ready", "/admin/session"] }); return;
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
