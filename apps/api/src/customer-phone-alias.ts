import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import type { JWTVerifyGetKey } from "jose";
import { verifyFlowPayToken } from "./auth-tokens.js";

type Options = {
  pool: Pool | null;
  jwks: JWTVerifyGetKey | null;
  issuer?: string;
  audience?: string;
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

/** Canonicalize Nigerian mobile numbers before they are persisted as aliases. */
export function normalizeNigerianPhone(value: unknown): { e164: string; local: string } | null {
  if (typeof value !== "string") return null;
  const compact = value.trim().replace(/[\\s().-]/g, "");
  const digits = compact.startsWith("+") ? compact.slice(1) : compact;
  let national = "";
  if (/^0[789][0-9]{9}$/.test(digits)) national = digits.slice(1);
  else if (/^234[789][0-9]{9}$/.test(digits)) national = digits.slice(3);
  else if (/^[789][0-9]{9}$/.test(digits)) national = digits;
  if (!national) return null;
  return { e164: "+234" + national, local: "0" + national };
}

function isJwtError(error: unknown): boolean {
  return error instanceof Error && [
    "JWTExpired", "JWSSignatureVerificationFailed", "JWTClaimValidationFailed",
    "JWSInvalid", "JWTInvalid"
  ].includes(error.name);
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

export function createCustomerPhoneAliasHandler(options: Options) {
  const { pool, jwks, issuer, audience } = options;
  return async function handleCustomerPhoneAlias(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\\/+$/, "") || "/";
    if (req.method !== "POST" || path !== "/customer/phone-alias/confirm") return false;

    if (!pool || !jwks || !issuer) {
      send(res, 503, { error: "PHONE_ALIAS_SERVICE_NOT_CONFIGURED" });
      return true;
    }

    const token = req.headers.authorization?.match(/^Bearer\\s+(.+)$/i)?.[1];
    if (!token) {
      send(res, 401, { error: "AUTHENTICATION_REQUIRED" });
      return true;
    }

    let payload: { sub?: unknown };
    try {
      const verified = await verifyFlowPayToken(token, jwks, {
        algorithms: ["EdDSA"], issuer, ...(audience ? { audience } : {})
      });
      payload = verified.payload;
    } catch (error) {
      if (isJwtError(error)) send(res, 401, { error: "INVALID_SESSION" });
      else send(res, 503, { error: "PHONE_ALIAS_AUTH_UNAVAILABLE" });
      return true;
    }
    if (typeof payload.sub !== "string" || !payload.sub) {
      send(res, 401, { error: "INVALID_SESSION" });
      return true;
    }

    let input: Record<string, unknown>;
    try { input = await readJson(req); }
    catch (error) {
      const message = error instanceof Error ? error.message : "INVALID_PAYLOAD";
      send(res, message === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: message });
      return true;
    }
    if (Object.keys(input).some(key => key !== "phoneNumber")) {
      send(res, 400, { error: "UNSUPPORTED_PHONE_ALIAS_FIELD" });
      return true;
    }
    const normalized = normalizeNigerianPhone(input.phoneNumber);
    if (!normalized) {
      send(res, 400, { error: "INVALID_NIGERIAN_PHONE_NUMBER" });
      return true;
    }

    let identity: { user_id: string; phone_number: string | null; phone_verified: string | null };
    try {
      const result = await pool.query<{
        user_id: string; phone_number: string | null; phone_verified: string | null;
      }>(
        `SELECT app_user.id AS user_id,
                COALESCE(to_jsonb(auth_user)->>'phoneNumber',
                         to_jsonb(auth_user)->>'phone_number') AS phone_number,
                COALESCE(to_jsonb(auth_user)->>'phoneNumberVerified',
                         to_jsonb(auth_user)->>'phone_number_verified') AS phone_verified
           FROM neon_auth."user" AS auth_user
           JOIN public.fp_users AS app_user
             ON app_user.auth_subject = auth_user.id::text
          WHERE auth_user.id::text = $1
            AND auth_user."emailVerified" = true
            AND app_user.status = 'active'
            AND app_user.role = 'customer'
          LIMIT 1`,
        [payload.sub]
      );
      if (result.rowCount !== 1) {
        send(res, 403, { error: "ACTIVE_VERIFIED_CUSTOMER_REQUIRED" });
        return true;
      }
      identity = result.rows[0];
    } catch (error) {
      console.error("FlowPay phone alias identity check failed:", error instanceof Error ? error.message : "database error");
      send(res, 503, { error: "PHONE_ALIAS_IDENTITY_UNAVAILABLE" });
      return true;
    }

    const savedPhone = normalizeNigerianPhone(identity.phone_number);
    if (!savedPhone || savedPhone.e164 !== normalized.e164 || identity.phone_verified !== "true") {
      send(res, 403, { error: "NEON_PHONE_VERIFICATION_REQUIRED", message: "Neon Auth must successfully verify and link this phone number before it can be used as a FlowPay recipient alias." });
      return true;
    }

    let client: PoolClient;
    try { client = await pool.connect(); }
    catch {
      send(res, 503, { error: "PHONE_ALIAS_DATABASE_UNAVAILABLE" });
      return true;
    }

    try {
      await client.query("BEGIN");
      const conflict = await client.query(
        `SELECT 1 FROM public.fp_customer_phone_aliases
          WHERE phone_e164 = $1 AND user_id <> $2
          LIMIT 1 FOR UPDATE`,
        [normalized.e164, identity.user_id]
      );
      if (conflict.rowCount) {
        await client.query("ROLLBACK");
        send(res, 409, { error: "PHONE_NUMBER_ALREADY_LINKED" });
        return true;
      }
      await client.query(
        `INSERT INTO public.fp_customer_phone_aliases
           (user_id, phone_e164, verified_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id) DO UPDATE
           SET phone_e164 = EXCLUDED.phone_e164,
               verified_at = EXCLUDED.verified_at`,
        [identity.user_id, normalized.e164]
      );
      await client.query("COMMIT");
      send(res, 200, {
        verified: true,
        phoneAliasVerified: true,
        phoneNumber: normalized.e164,
        message: "Your verified phone number now finds the same FlowPay wallet as your permanent 10-digit FlowPay ID."
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
      if (code === "23505") {
        send(res, 409, { error: "PHONE_NUMBER_ALREADY_LINKED" });
      } else {
        console.error("FlowPay phone alias save failed:", error instanceof Error ? error.message : "database error");
        send(res, 503, { error: "PHONE_ALIAS_SAVE_FAILED" });
      }
    } finally {
      client.release();
    }
    return true;
  };
}
