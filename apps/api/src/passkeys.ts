import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { SignJWT, type JWTVerifyGetKey } from "jose";
import { FLOWPAY_PASSKEY_JWT_AUDIENCE, FLOWPAY_PASSKEY_JWT_ISSUER, verifyFlowPayToken } from "./auth-tokens.js";

type Options = {
  pool: Pool | null;
  jwks: JWTVerifyGetKey | null;
  issuer?: string;
  audience?: string;
};

type Identity = {
  user_id: string;
  auth_subject: string;
  email: string;
  name: string;
};

type SavedPasskey = {
  credential_id: string;
  public_key: Buffer;
  counter: string;
  transports: string[];
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(raw, "utf8") > 32_768) throw new Error("PAYLOAD_TOO_LARGE");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw || "{}"); } catch { throw new Error("INVALID_JSON"); }
  const body = asRecord(parsed);
  if (!body) throw new Error("INVALID_PAYLOAD");
  return body;
}

function authSettings() {
  const origin = (process.env.FLOWPAY_WEBAUTHN_ORIGIN || "https://flowpay-web-jx7i.onrender.com").replace(/\/+$/, "");
  const rpID = process.env.FLOWPAY_WEBAUTHN_RP_ID?.trim() || new URL(origin).hostname;
  const secret = process.env.FLOWPAY_PASSKEY_JWT_SECRET?.trim() || "";
  return { origin, rpID, secret };
}

function isJwtError(error: unknown): boolean {
  return error instanceof Error && [
    "JWTExpired", "JWSSignatureVerificationFailed", "JWTClaimValidationFailed",
    "JWSInvalid", "JWTInvalid"
  ].includes(error.name);
}

async function findIdentity(pool: Pool, email: string): Promise<Identity | null> {
  const result = await pool.query<Identity>(
    `SELECT app_user.id::text AS user_id,
            auth_user.id::text AS auth_subject,
            auth_user.email,
            COALESCE(NULLIF(BTRIM(auth_user.name), ''), auth_user.email) AS name
       FROM neon_auth."user" AS auth_user
       JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
      WHERE lower(auth_user.email) = lower($1)
        AND auth_user."emailVerified" = true
        AND app_user.status = 'active'
        AND app_user.role = 'customer'
      LIMIT 1`,
    [email]
  );
  return result.rowCount === 1 ? result.rows[0] : null;
}

async function findAuthenticatedIdentity(
  pool: Pool,
  req: IncomingMessage,
  jwks: JWTVerifyGetKey | null,
  issuer?: string,
  audience?: string
): Promise<Identity | null> {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
  if (!bearer) return null;
  const { payload } = await verifyFlowPayToken(bearer[1], jwks, issuer, audience);
  if (typeof payload.sub !== "string" || !payload.sub) return null;
  const result = await pool.query<Identity>(
    `SELECT app_user.id::text AS user_id,
            auth_user.id::text AS auth_subject,
            auth_user.email,
            COALESCE(NULLIF(BTRIM(auth_user.name), ''), auth_user.email) AS name
       FROM neon_auth."user" AS auth_user
       JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
      WHERE auth_user.id::text = $1
        AND auth_user."emailVerified" = true
        AND app_user.status = 'active'
        AND app_user.role = 'customer'
      LIMIT 1`,
    [payload.sub]
  );
  return result.rowCount === 1 ? result.rows[0] : null;
}

async function storeChallenge(
  pool: Pool,
  id: string,
  userId: string,
  purpose: "registration" | "authentication",
  challenge: string
) {
  await pool.query(
    `INSERT INTO public.fp_passkey_challenges (id, user_id, purpose, challenge, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '5 minutes')`,
    [id, userId, purpose, challenge]
  );
}

async function consumeChallenge(
  pool: Pool,
  id: string,
  userId: string,
  purpose: "registration" | "authentication"
): Promise<string | null> {
  const result = await pool.query<{ challenge: string }>(
    `UPDATE public.fp_passkey_challenges
        SET consumed_at = NOW()
      WHERE id = $1 AND user_id = $2 AND purpose = $3
        AND consumed_at IS NULL AND expires_at > NOW()
      RETURNING challenge`,
    [id, userId, purpose]
  );
  return result.rowCount === 1 ? result.rows[0].challenge : null;
}

export function createPasskeysHandler(options: Options) {
  const { pool, jwks, issuer, audience } = options;

  return async function handlePasskeys(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
    const routes = [
      "/customer/passkeys/registration/options",
      "/customer/passkeys/registration/verify",
      "/auth/passkeys/authentication/options",
      "/auth/passkeys/authentication/verify"
    ];
    if (req.method !== "POST" || !routes.includes(path)) return false;

    if (!pool) {
      send(res, 503, { error: "PASSKEY_DATABASE_NOT_CONFIGURED" });
      return true;
    }
    const { origin, rpID, secret } = authSettings();
    if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
      send(res, 503, { error: "PASSKEY_AUTH_NOT_CONFIGURED", message: "FlowPay passkey authentication is not configured yet." });
      return true;
    }

    let input: Record<string, unknown>;
    try {
      input = await readJson(req);
    } catch (error) {
      const message = error instanceof Error ? error.message : "INVALID_PAYLOAD";
      send(res, message === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: message });
      return true;
    }

    if (path.startsWith("/customer/passkeys/")) {
      let identity: Identity | null;
      try {
        identity = await findAuthenticatedIdentity(pool, req, jwks, issuer, audience);
      } catch (error) {
        if (isJwtError(error)) send(res, 401, { error: "INVALID_SESSION" });
        else {
          console.error("FlowPay passkey registration authentication failed:", error instanceof Error ? error.message : "unknown error");
          send(res, 503, { error: "PASSKEY_AUTHENTICATION_UNAVAILABLE" });
        }
        return true;
      }
      if (!identity) {
        send(res, 403, { error: "ACTIVE_VERIFIED_CUSTOMER_REQUIRED" });
        return true;
      }

      if (path.endsWith("/registration/options")) {
        try {
          const registered = await pool.query<{ credential_id: string; transports: string[] }>(
            `SELECT credential_id, transports
               FROM public.fp_passkeys
              WHERE user_id = $1 AND revoked_at IS NULL
              ORDER BY created_at DESC LIMIT 50`,
            [identity.user_id]
          );
          const generated = await generateRegistrationOptions({
            rpName: "FlowPay",
            rpID,
            userID: new Uint8Array(Buffer.from(identity.user_id.replace(/-/g, ""), "hex")),
            userName: identity.email,
            userDisplayName: identity.name,
            attestationType: "none",
            excludeCredentials: registered.rows.map(row => ({
              id: row.credential_id,
              transports: row.transports as AuthenticatorTransportFuture[]
            })),
            authenticatorSelection: {
              residentKey: "required",
              userVerification: "required",
              authenticatorAttachment: "platform"
            }
          });
          const challengeId = randomUUID();
          await storeChallenge(pool, challengeId, identity.user_id, "registration", generated.challenge);
          send(res, 200, { challengeId, options: generated });
        } catch (error) {
          console.error("FlowPay passkey registration options failed:", error instanceof Error ? error.message : "unknown error");
          send(res, 503, { error: "PASSKEY_REGISTRATION_UNAVAILABLE" });
        }
        return true;
      }

      if (path.endsWith("/registration/verify")) {
        const challengeId = typeof input.challengeId === "string" ? input.challengeId : "";
        const response = asRecord(input.response);
        const name = typeof input.name === "string" ? input.name.trim().slice(0, 80) : "This device";
        if (!/^[0-9a-f-]{36}$/i.test(challengeId) || !response || !name) {
          send(res, 400, { error: "INVALID_PASSKEY_REGISTRATION_PAYLOAD" });
          return true;
        }
        try {
          const challengeRow = await pool.query<{ challenge: string }>(
            `SELECT challenge FROM public.fp_passkey_challenges
              WHERE id = $1 AND user_id = $2 AND purpose = 'registration'
                AND consumed_at IS NULL AND expires_at > NOW()
              LIMIT 1`,
            [challengeId, identity.user_id]
          );
          if (challengeRow.rowCount !== 1) {
            send(res, 400, { error: "PASSKEY_CHALLENGE_EXPIRED" });
            return true;
          }
          const verified = await verifyRegistrationResponse({
            response: response as never,
            expectedChallenge: challengeRow.rows[0].challenge,
            expectedOrigin: origin,
            expectedRPID: rpID,
            requireUserVerification: true
          });
          if (!verified.verified || !verified.registrationInfo) {
            send(res, 400, { error: "PASSKEY_REGISTRATION_NOT_VERIFIED" });
            return true;
          }
          const consumed = await consumeChallenge(pool, challengeId, identity.user_id, "registration");
          if (!consumed || consumed !== challengeRow.rows[0].challenge) {
            send(res, 409, { error: "PASSKEY_CHALLENGE_ALREADY_USED" });
            return true;
          }
          const info = verified.registrationInfo;
          const credential = info.credential;
          const saved = await pool.query(
            `INSERT INTO public.fp_passkeys
               (user_id, credential_id, public_key, counter, transports, device_type, backed_up, name)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (credential_id) DO NOTHING
             RETURNING id`,
            [
              identity.user_id,
              credential.id,
              Buffer.from(credential.publicKey),
              credential.counter,
              credential.transports ?? [],
              info.credentialDeviceType,
              info.credentialBackedUp,
              name
            ]
          );
          if (saved.rowCount !== 1) {
            send(res, 409, { error: "PASSKEY_ALREADY_REGISTERED" });
            return true;
          }
          await pool.query(
            `INSERT INTO public.fp_security_audit_events (user_id, event_type, outcome, details)
             VALUES ($1, 'passkey_registration', 'succeeded', jsonb_build_object('device_type', $2::text))`,
            [identity.user_id, info.credentialDeviceType]
          );
          send(res, 201, { verified: true, registered: true, name });
        } catch (error) {
          console.error("FlowPay passkey registration verification failed:", error instanceof Error ? error.message : "unknown error");
          send(res, 400, { error: "PASSKEY_REGISTRATION_VERIFICATION_FAILED" });
        }
        return true;
      }
    }

    if (path.endsWith("/authentication/options")) {
      const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
      if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        send(res, 400, { error: "VALID_EMAIL_REQUIRED" });
        return true;
      }
      try {
        const identity = await findIdentity(pool, email);
        if (!identity) {
          send(res, 404, { error: "PASSKEY_NOT_AVAILABLE_FOR_ACCOUNT", message: "No passkey is registered for this FlowPay account." });
          return true;
        }
        const credentials = await pool.query<{ credential_id: string; transports: string[] }>(
          `SELECT credential_id, transports
             FROM public.fp_passkeys
            WHERE user_id = $1 AND revoked_at IS NULL
            ORDER BY created_at DESC LIMIT 50`,
          [identity.user_id]
        );
        if (credentials.rowCount === 0) {
          send(res, 404, { error: "PASSKEY_NOT_AVAILABLE_FOR_ACCOUNT", message: "No passkey is registered for this FlowPay account. Sign in with Google or your password and register this device in Security." });
          return true;
        }
        const generated = await generateAuthenticationOptions({
          rpID,
          allowCredentials: credentials.rows.map(row => ({
            id: row.credential_id,
            transports: row.transports as AuthenticatorTransportFuture[]
          })),
          userVerification: "required"
        });
        const challengeId = randomUUID();
        await storeChallenge(pool, challengeId, identity.user_id, "authentication", generated.challenge);
        send(res, 200, { challengeId, options: generated });
      } catch (error) {
        console.error("FlowPay passkey authentication options failed:", error instanceof Error ? error.message : "unknown error");
        send(res, 503, { error: "PASSKEY_AUTHENTICATION_UNAVAILABLE" });
      }
      return true;
    }

    if (path.endsWith("/authentication/verify")) {
      const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
      const challengeId = typeof input.challengeId === "string" ? input.challengeId : "";
      const response = asRecord(input.response);
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
          !/^[0-9a-f-]{36}$/i.test(challengeId) || !response ||
          typeof response.id !== "string") {
        send(res, 400, { error: "INVALID_PASSKEY_AUTHENTICATION_PAYLOAD" });
        return true;
      }
      try {
        const identity = await findIdentity(pool, email);
        if (!identity) {
          send(res, 401, { error: "PASSKEY_AUTHENTICATION_FAILED" });
          return true;
        }
        const challengeRow = await pool.query<{ challenge: string }>(
          `SELECT challenge FROM public.fp_passkey_challenges
            WHERE id = $1 AND user_id = $2 AND purpose = 'authentication'
              AND consumed_at IS NULL AND expires_at > NOW()
            LIMIT 1`,
          [challengeId, identity.user_id]
        );
        if (challengeRow.rowCount !== 1) {
          send(res, 400, { error: "PASSKEY_CHALLENGE_EXPIRED" });
          return true;
        }
        const saved = await pool.query<SavedPasskey>(
          `SELECT credential_id, public_key, counter::text AS counter, transports
             FROM public.fp_passkeys
            WHERE user_id = $1 AND credential_id = $2 AND revoked_at IS NULL
            LIMIT 1`,
          [identity.user_id, response.id]
        );
        if (saved.rowCount !== 1) {
          send(res, 401, { error: "PASSKEY_AUTHENTICATION_FAILED" });
          return true;
        }
        const credential = saved.rows[0];
        const verified = await verifyAuthenticationResponse({
          response: response as never,
          expectedChallenge: challengeRow.rows[0].challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: {
            id: credential.credential_id,
            publicKey: new Uint8Array(credential.public_key),
            counter: Number(credential.counter),
            transports: credential.transports as AuthenticatorTransportFuture[]
          },
          requireUserVerification: true
        });
        if (!verified.verified) {
          send(res, 401, { error: "PASSKEY_AUTHENTICATION_FAILED" });
          return true;
        }
        const consumed = await consumeChallenge(pool, challengeId, identity.user_id, "authentication");
        if (!consumed || consumed !== challengeRow.rows[0].challenge) {
          send(res, 409, { error: "PASSKEY_CHALLENGE_ALREADY_USED" });
          return true;
        }
        await pool.query(
          `UPDATE public.fp_passkeys
              SET counter = $3, last_used_at = NOW()
            WHERE user_id = $1 AND credential_id = $2 AND revoked_at IS NULL`,
          [identity.user_id, credential.credential_id, verified.authenticationInfo.newCounter]
        );
        await pool.query(
          `INSERT INTO public.fp_security_audit_events (user_id, event_type, outcome)
           VALUES ($1, 'passkey_authentication', 'succeeded')`,
          [identity.user_id]
        );

        const accessToken = await new SignJWT({
          email: identity.email,
          amr: ["webauthn"]
        })
          .setProtectedHeader({ alg: "HS256", typ: "JWT" })
          .setIssuer(FLOWPAY_PASSKEY_JWT_ISSUER)
          .setAudience(FLOWPAY_PASSKEY_JWT_AUDIENCE)
          .setSubject(identity.auth_subject)
          .setIssuedAt()
          .setExpirationTime("15m")
          .sign(new TextEncoder().encode(secret));

        send(res, 200, {
          verified: true,
          accessToken,
          expiresAt: Date.now() + 15 * 60 * 1000,
          user: {
            id: identity.auth_subject,
            email: identity.email,
            name: identity.name
          }
        });
      } catch (error) {
        console.error("FlowPay passkey authentication verification failed:", error instanceof Error ? error.message : "unknown error");
        send(res, 401, { error: "PASSKEY_AUTHENTICATION_FAILED" });
      }
      return true;
    }

    return true;
  };
}
