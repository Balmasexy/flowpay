import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getPaystackRuntime } from "./paystack-mode.js";

type Options = {
  pool: Pool | null;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
  issuer?: string;
  audience?: string;
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

export function createPaystackDepositStatusHandler(options: Options) {
  const { pool, jwks, issuer, audience } = options;

  return async function handlePaystackDepositStatus(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" || url.pathname.replace(/\/+$/, "") !== "/customer/paystack/deposits/status") return false;

    if (!pool || !jwks || !issuer || !audience) {
      send(res, 503, { error: "PAYSTACK_STATUS_SERVICE_NOT_CONFIGURED" });
      return true;
    }
    const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if (!bearer) {
      send(res, 401, { error: "AUTHENTICATION_REQUIRED" });
      return true;
    }

    const paystackRuntime = getPaystackRuntime();
    if (!paystackRuntime) {
      send(res, 503, { error: "PAYSTACK_CONFIGURATION_REQUIRED" });
      return true;
    }
    const reference = url.searchParams.get("reference")?.trim() ?? "";
    if (!/^flowpay-ps-[0-9a-f]{32}$/i.test(reference)) {
      send(res, 400, { error: "INVALID_PAYSTACK_REFERENCE" });
      return true;
    }

    try {
      const { payload } = await jwtVerify(bearer[1], jwks, { algorithms: ["EdDSA"], issuer, audience });
      if (typeof payload.sub !== "string" || !payload.sub) {
        send(res, 401, { error: "INVALID_SESSION" });
        return true;
      }
      const identity = await pool.query<{ id: string }>(
        `SELECT app_user.id
           FROM neon_auth."user" AS auth_user
           JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
          WHERE auth_user.id::text = $1
            AND auth_user."emailVerified" = true
            AND app_user.status = 'active'
          LIMIT 1`,
        [payload.sub]
      );
      if (identity.rowCount !== 1) {
        send(res, 403, { error: "ACTIVE_CUSTOMER_ACCOUNT_REQUIRED" });
        return true;
      }

      const result = await pool.query<{
        transaction_id: string;
        reference: string;
        amount_minor: string;
        currency: string;
        status: "pending" | "posted" | "failed";
        created_at: Date;
        verified_at: Date | null;
      }>(
        `SELECT transaction_id, reference, amount_minor::text AS amount_minor,
                currency, status, created_at, verified_at
           FROM public.fp_paystack_deposits
          WHERE user_id = $1 AND reference = $2
          LIMIT 1`,
        [identity.rows[0].id, reference]
      );
      if (result.rowCount !== 1 || !result.rows[0]) {
        send(res, 404, { error: "PAYSTACK_DEPOSIT_NOT_FOUND" });
        return true;
      }
      const deposit = result.rows[0];
      send(res, 200, {
        deposit: {
          transactionId: deposit.transaction_id,
          reference: deposit.reference,
          amountMinor: deposit.amount_minor,
          currency: String(deposit.currency).trim(),
          status: deposit.status,
          createdAt: deposit.created_at,
          verifiedAt: deposit.verified_at
        },
        environment: paystackRuntime.environment,
        walletCredited: deposit.status === "posted",
        livePaymentsEnabled: paystackRuntime.environment === "live"
      });
      return true;
    } catch (error) {
      if (error instanceof Error && [
        "JWTExpired", "JWSSignatureVerificationFailed", "JWTClaimValidationFailed", "JWSInvalid", "JWTInvalid"
      ].includes(error.name)) {
        send(res, 401, { error: "INVALID_SESSION" });
        return true;
      }
      console.error("FlowPay Paystack deposit status request failed:", error instanceof Error ? error.message : "unknown error");
      send(res, 503, { error: "PAYSTACK_STATUS_UNAVAILABLE" });
      return true;
    }
  };
}
