import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { jwtVerify, type JWTVerifyGetKey } from "jose";

type Dependencies = {
  pool: Pool | null;
  jwks: JWTVerifyGetKey | null;
  issuer?: string;
  audience?: string;
};
const categories = new Set([
  "Transaction issue", "Account access", "Profile or photo",
  "Card issue", "Airtime, data or bill", "Security concern", "Other"
]);
const maxBodyBytes = 8_192;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += part.length;
    if (total > maxBodyBytes) throw Object.assign(new Error("REQUEST_TOO_LARGE"), { statusCode: 413 });
    chunks.push(part);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("INVALID_JSON"), { statusCode: 400 }); }
  if (!isRecord(parsed)) throw Object.assign(new Error("INVALID_PAYLOAD"), { statusCode: 400 });
  return parsed;
}
function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function createSupportRequestsHandler(deps: Dependencies) {
  return async function handleSupportRequests(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
    if (pathname !== "/customer/support-requests" || (req.method !== "GET" && req.method !== "POST")) return false;
    const { pool, jwks, issuer, audience } = deps;
    if (!pool || !jwks || !issuer || !audience) {
      send(res, 503, { error: "SUPPORT_SERVICE_NOT_CONFIGURED" });
      return true;
    }
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) { send(res, 401, { error: "AUTHENTICATION_REQUIRED" }); return true; }

    let userId: string;
    try {
      const { payload } = await jwtVerify(token, jwks, { algorithms: ["EdDSA"], issuer, audience });
      if (typeof payload.sub !== "string" || !payload.sub) {
        send(res, 401, { error: "INVALID_SESSION" }); return true;
      }
      const identity = await pool.query(
        `SELECT app_user.id
           FROM neon_auth."user" AS auth_user
           JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
          WHERE auth_user.id::text = $1 AND auth_user."emailVerified" = true
            AND app_user.status = 'active' LIMIT 1`,
        [payload.sub]
      );
      if (identity.rowCount !== 1) {
        send(res, 403, { error: "ACTIVE_CUSTOMER_ACCOUNT_REQUIRED" }); return true;
      }
      userId = String(identity.rows[0].id);
    } catch (error) {
      if (error instanceof Error && ["JWTExpired", "JWSSignatureVerificationFailed", "JWTClaimValidationFailed", "JWSInvalid", "JWTInvalid"].includes(error.name)) {
        send(res, 401, { error: "INVALID_SESSION" }); return true;
      }
      console.error("FlowPay support authentication failed:", error instanceof Error ? error.message : "unknown error");
      send(res, 503, { error: "SUPPORT_AUTH_UNAVAILABLE" }); return true;
    }

    try {
      if (req.method === "GET") {
        const result = await pool.query(
          `SELECT ticket_reference, category, reference_text, details, status, created_at, updated_at
             FROM public.fp_support_requests
            WHERE user_id = $1
            ORDER BY created_at DESC LIMIT 50`,
          [userId]
        );
        send(res, 200, { requests: result.rows.map(row => ({
          ticketReference: row.ticket_reference, category: row.category,
          reference: row.reference_text, details: row.details, status: row.status,
          createdAt: row.created_at, updatedAt: row.updated_at
        })) });
        return true;
      }

      let input: Record<string, unknown>;
      try { input = await readJson(req); }
      catch (error) {
        const status = error && typeof error === "object" && "statusCode" in error
          ? Number((error as { statusCode: unknown }).statusCode) : 400;
        send(res, status, { error: error instanceof Error ? error.message : "INVALID_PAYLOAD" });
        return true;
      }
      if (Object.keys(input).some(key => !["clientRequestId", "category", "reference", "details"].includes(key))) {
        send(res, 400, { error: "UNSUPPORTED_SUPPORT_FIELD" }); return true;
      }
      if (!isUuid(input.clientRequestId)) {
        send(res, 400, { error: "VALID_CLIENT_REQUEST_ID_REQUIRED" }); return true;
      }
      if (typeof input.category !== "string" || !categories.has(input.category)) {
        send(res, 400, { error: "INVALID_SUPPORT_CATEGORY" }); return true;
      }
      if (typeof input.details !== "string" || input.details.trim().length < 20 || input.details.trim().length > 2000) {
        send(res, 400, { error: "SUPPORT_DETAILS_MUST_BE_20_TO_2000_CHARACTERS" }); return true;
      }
      const reference = input.reference === undefined || input.reference === null
        ? null : typeof input.reference === "string" ? input.reference.trim() : undefined;
      if (reference === undefined || (reference !== null && reference.length > 100)) {
        send(res, 400, { error: "INVALID_SUPPORT_REFERENCE" }); return true;
      }

      const prior = await pool.query(
        `SELECT ticket_reference, category, reference_text, details, status, created_at, updated_at
           FROM public.fp_support_requests
          WHERE user_id = $1 AND client_request_id = $2 LIMIT 1`,
        [userId, input.clientRequestId]
      );
      if (prior.rowCount === 1) {
        const row = prior.rows[0];
        send(res, 200, { submitted: true, duplicate: true, request: {
          ticketReference: row.ticket_reference, category: row.category,
          reference: row.reference_text, details: row.details, status: row.status,
          createdAt: row.created_at, updatedAt: row.updated_at
        } });
        return true;
      }

      const rate = await pool.query(
        `SELECT COUNT(*)::int AS count FROM public.fp_support_requests
          WHERE user_id = $1 AND created_at > NOW() - INTERVAL '10 minutes'`,
        [userId]
      );
      if (Number(rate.rows[0]?.count ?? 0) >= 5) {
        send(res, 429, { error: "SUPPORT_REQUEST_RATE_LIMIT", retryAfterSeconds: 600 }); return true;
      }

      const ticketReference = "FP-" + randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();
      const inserted = await pool.query(
        `INSERT INTO public.fp_support_requests
           (user_id, client_request_id, ticket_reference, category, reference_text, details)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, client_request_id) DO NOTHING
         RETURNING ticket_reference, category, reference_text, details, status, created_at, updated_at`,
        [userId, input.clientRequestId, ticketReference, input.category, reference, input.details.trim()]
      );
      let row = inserted.rows[0];
      if (!row) {
        const duplicate = await pool.query(
          `SELECT ticket_reference, category, reference_text, details, status, created_at, updated_at
             FROM public.fp_support_requests WHERE user_id = $1 AND client_request_id = $2 LIMIT 1`,
          [userId, input.clientRequestId]
        );
        row = duplicate.rows[0];
      }
      if (!row) { send(res, 503, { error: "SUPPORT_REQUEST_NOT_SAVED" }); return true; }
      send(res, 201, { submitted: true, request: {
        ticketReference: row.ticket_reference, category: row.category,
        reference: row.reference_text, details: row.details, status: row.status,
        createdAt: row.created_at, updatedAt: row.updated_at
      }, message: "Your support request has been saved. Keep the ticket reference for follow-up." });
      return true;
    } catch (error) {
      console.error("FlowPay support request failed:", error instanceof Error ? error.message : "unknown error");
      send(res, 503, { error: "SUPPORT_SERVICE_UNAVAILABLE" });
      return true;
    }
  };
}
