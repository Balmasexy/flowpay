import { randomInt } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import { verifyFlowPayToken } from "./auth-tokens.js";

type Options = {
  pool: Pool | null;
  jwks: JWTVerifyGetKey | null;
  issuer?: string;
  audience?: string;
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function isJwtError(error: unknown): boolean {
  return error instanceof Error && [
    "JWTExpired", "JWSSignatureVerificationFailed", "JWTClaimValidationFailed",
    "JWSInvalid", "JWTInvalid"
  ].includes(error.name);
}

type ProvisionedCustomer = {
  id: string;
  email: string;
  flowpayAccountNumber: string;
  walletId: string;
  cardStatus: string;
};

async function ensureCustomer(client: PoolClient, email: string, authSubject: string): Promise<ProvisionedCustomer> {
  let user = await client.query<{id:string; email:string; status:string; role:string}>(
    `SELECT id, email, status, role
       FROM public.fp_users
      WHERE auth_subject = $1
      FOR UPDATE`,
    [authSubject]
  );

  if (user.rowCount !== 1) {
    const attached = await client.query<{id:string; email:string; status:string; role:string}>(
      `UPDATE public.fp_users
          SET auth_subject = $1
        WHERE lower(email) = lower($2)
          AND auth_subject IS NULL
        RETURNING id, email, status, role`,
      [authSubject, email]
    );
    if (attached.rowCount === 1) {
      user = attached;
    } else {
      const created = await client.query<{id:string; email:string; status:string; role:string}>(
        `INSERT INTO public.fp_users (email, auth_subject)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING id, email, status, role`,
        [email, authSubject]
      );
      if (created.rowCount === 1) {
        user = created;
      } else {
        user = await client.query<{id:string; email:string; status:string; role:string}>(
          `SELECT id, email, status, role
             FROM public.fp_users
            WHERE auth_subject = $1
            FOR UPDATE`,
          [authSubject]
        );
      }
    }
  }

  if (user.rowCount !== 1) throw new Error("CUSTOMER_IDENTITY_CONFLICT");
  const customer = user.rows[0];
  if (customer.status !== "active") throw new Error("CUSTOMER_ACCOUNT_NOT_ACTIVE");
  if (customer.role !== "customer") throw new Error("CUSTOMER_ROLE_REQUIRED");

  await client.query(
    `INSERT INTO public.fp_accounts (user_id, account_type, currency, status)
     VALUES ($1, 'customer', 'NGN', 'active')
     ON CONFLICT (user_id, currency)
       WHERE account_type = 'customer' AND user_id IS NOT NULL
     DO NOTHING`,
    [customer.id]
  );

  let accountNumber = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const existing = await client.query<{account_number:string}>(
      "SELECT account_number FROM public.fp_customer_account_numbers WHERE user_id = $1 LIMIT 1",
      [customer.id]
    );
    if (existing.rowCount === 1) {
      accountNumber = String(existing.rows[0].account_number);
      break;
    }
    const candidate = String(randomInt(1_000_000_000, 10_000_000_000));
    await client.query(
      `INSERT INTO public.fp_customer_account_numbers (user_id, account_number)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [customer.id, candidate]
    );
  }
  if (!/^[1-9][0-9]{9}$/.test(accountNumber)) {
    const existing = await client.query<{account_number:string}>(
      "SELECT account_number FROM public.fp_customer_account_numbers WHERE user_id = $1 LIMIT 1",
      [customer.id]
    );
    accountNumber = existing.rowCount === 1 ? String(existing.rows[0].account_number) : "";
  }
  if (!/^[1-9][0-9]{9}$/.test(accountNumber)) throw new Error("FLOWPAY_ACCOUNT_NUMBER_ASSIGNMENT_FAILED");

  const wallet = await client.query<{id:string}>(
    `SELECT id FROM public.fp_accounts
      WHERE user_id = $1 AND account_type = 'customer' AND currency = 'NGN'
      LIMIT 1`,
    [customer.id]
  );
  if (wallet.rowCount !== 1) throw new Error("FLOWPAY_NGN_WALLET_PROVISIONING_FAILED");

  // Show the virtual-card shell immediately, but never invent a PAN, CVV,
  // expiry, provider reference, or active card status.
  await client.query(
    `INSERT INTO public.fp_cards (user_id, provider, card_type, status)
     SELECT $1, 'issuer_pending', 'virtual', 'pending'
      WHERE NOT EXISTS (SELECT 1 FROM public.fp_cards WHERE user_id = $1)
     ON CONFLICT (user_id)
       WHERE provider = 'issuer_pending' AND card_type = 'virtual' AND status = 'pending'
     DO NOTHING`,
    [customer.id]
  );
  const card = await client.query<{status:string}>(
    `SELECT status FROM public.fp_cards
      WHERE user_id = $1 AND provider = 'issuer_pending' AND card_type = 'virtual'
      ORDER BY created_at DESC LIMIT 1`,
    [customer.id]
  );

  return {
    id: customer.id,
    email: customer.email,
    flowpayAccountNumber: accountNumber,
    walletId: String(wallet.rows[0].id),
    cardStatus: card.rowCount === 1 ? String(card.rows[0].status) : "issuer_not_linked"
  };
}

export function createCustomerBootstrapHandler(options: Options) {
  const { pool, jwks, issuer, audience } = options;
  return async function handleCustomerBootstrap(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method !== "POST" || path !== "/customer/bootstrap") return false;

    if (!pool || !jwks || !issuer) {
      send(res, 503, { error: "CUSTOMER_BOOTSTRAP_NOT_CONFIGURED" });
      return true;
    }
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) {
      send(res, 401, { error: "AUTHENTICATION_REQUIRED" });
      return true;
    }

    let authUser: { id: string; email: string; emailVerified: boolean };
    try {
      const { payload } = await verifyFlowPayToken(token, jwks, {
        algorithms: ["EdDSA"], issuer, ...(audience ? { audience } : {})
      });
      if (typeof payload.sub !== "string" || !payload.sub) {
        send(res, 401, { error: "INVALID_SESSION" });
        return true;
      }
      const found = await pool.query<{id:string; email:string; emailVerified:boolean}>(
        `SELECT id::text AS id, email, "emailVerified"
           FROM neon_auth."user"
          WHERE id::text = $1
          LIMIT 1`,
        [payload.sub]
      );
      if (found.rowCount !== 1 || found.rows[0].emailVerified !== true ||
          typeof found.rows[0].email !== "string" || !found.rows[0].email.trim()) {
        send(res, 403, { error: "VERIFIED_EMAIL_REQUIRED" });
        return true;
      }
      authUser = found.rows[0];
    } catch (error) {
      if (isJwtError(error)) {
        send(res, 401, { error: "INVALID_SESSION" });
        return true;
      }
      console.error("FlowPay bootstrap identity lookup failed:", error instanceof Error ? error.message : "unknown error");
      send(res, 503, { error: "CUSTOMER_BOOTSTRAP_AUTH_UNAVAILABLE" });
      return true;
    }

    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch {
      send(res, 503, { error: "CUSTOMER_BOOTSTRAP_DATABASE_UNAVAILABLE" });
      return true;
    }
    try {
      await client.query("BEGIN");
      const customer = await ensureCustomer(client, authUser.email.trim(), authUser.id);
      await client.query("COMMIT");
      send(res, 200, {
        provisioned: true,
        customerId: customer.id,
        email: customer.email,
        flowpayAccountNumber: customer.flowpayAccountNumber,
        wallet: { currency: "NGN", status: "active" },
        virtualCard: {
          status: customer.cardStatus,
          issued: false,
          provider: "pending_issuer_approval",
          cardNumber: null,
          cvv: null,
          expiry: null,
          message: "Your virtual card is displayed as pending. A usable card will appear only after an approved issuer confirms issuance."
        }
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const message = error instanceof Error ? error.message : "unknown bootstrap error";
      if (message === "CUSTOMER_ACCOUNT_NOT_ACTIVE") {
        send(res, 403, { error: "CUSTOMER_ACCOUNT_NOT_ACTIVE" });
      } else if (message === "CUSTOMER_ROLE_REQUIRED") {
        send(res, 403, { error: "CUSTOMER_ROLE_REQUIRED" });
      } else if (message === "CUSTOMER_IDENTITY_CONFLICT") {
        send(res, 409, { error: "CUSTOMER_IDENTITY_CONFLICT" });
      } else {
        console.error("FlowPay customer bootstrap failed:", message);
        send(res, 503, { error: "CUSTOMER_BOOTSTRAP_FAILED" });
      }
    } finally {
      client.release();
    }
    return true;
  };
}
