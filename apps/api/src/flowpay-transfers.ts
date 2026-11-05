import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { createRemoteJWKSet, jwtVerify } from "jose";

type Options = {
  pool: Pool | null;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
  issuer?: string;
  audience?: string;
};
type Identity = { id: string; name: string | null };

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

function isJwtError(error: unknown) {
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

function derivePin(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(pin, salt, 64, (error, derived) => {
      if (error) reject(error);
      else resolve(derived as Buffer);
    });
  });
}

function validAccountNumber(value: unknown): value is string {
  return typeof value === "string" && /^\d{12}$/.test(value);
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function authenticate(
  pool: Pool,
  jwks: ReturnType<typeof createRemoteJWKSet>,
  issuer: string,
  audience: string,
  req: IncomingMessage
): Promise<Identity | null> {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
  if (!bearer) return null;
  const { payload } = await jwtVerify(bearer[1], jwks, {
    algorithms: ["EdDSA"], issuer, audience
  });
  if (typeof payload.sub !== "string" || !payload.sub) return null;
  const result = await pool.query<Identity>(
    `SELECT app_user.id, auth_user.name
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


async function verifyTransactionPin(
  client: PoolClient,
  userId: string,
  suppliedPin: string
): Promise<"verified" | "missing" | "locked" | "invalid"> {
  const result = await client.query<{
    pin_salt: Buffer; pin_hash: Buffer; failed_attempts: number; locked_until: Date | null;
  }>(
    `SELECT pin_salt, pin_hash, failed_attempts, locked_until
       FROM public.fp_transaction_pins
      WHERE user_id = $1
      FOR UPDATE`,
    [userId]
  );
  if (result.rowCount !== 1) return "missing";
  const saved = result.rows[0];
  if (saved.locked_until && new Date(saved.locked_until).getTime() > Date.now()) return "locked";
  const derived = await derivePin(suppliedPin, saved.pin_salt);
  if (derived.length !== saved.pin_hash.length || !timingSafeEqual(derived, saved.pin_hash)) {
    const nextAttempts = Math.min(5, Number(saved.failed_attempts) + 1);
    await client.query(
      `UPDATE public.fp_transaction_pins
          SET failed_attempts = $2,
              locked_until = CASE WHEN $2 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END,
              updated_at = NOW()
        WHERE user_id = $1`,
      [userId, nextAttempts]
    );
    return nextAttempts >= 5 ? "locked" : "invalid";
  }
  await client.query(
    `UPDATE public.fp_transaction_pins
        SET failed_attempts = 0, locked_until = NULL, updated_at = NOW()
      WHERE user_id = $1`,
    [userId]
  );
  return "verified";
}

export function createFlowPayTransfersHandler(options: Options) {
  const { pool, jwks, issuer, audience } = options;
  return async function handleFlowPayTransfers(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
    const supported =
      (req.method === "GET" && path === "/customer/transaction-pin/status") ||
      (req.method === "POST" && [
        "/customer/transaction-pin/setup",
        "/customer/flowpay/recipients/lookup",
        "/customer/transfers/flowpay"
      ].includes(path));
    if (!supported) return false;
    if (!pool || !jwks || !issuer || !audience) {
      send(res, 503, { error: "FLOWPAY_TRANSFER_SERVICE_NOT_CONFIGURED" });
      return true;
    }

    let identity: Identity | null;
    try {
      identity = await authenticate(pool, jwks, issuer, audience, req);
      if (!identity) {
        send(res, req.headers.authorization ? 403 : 401, {
          error: req.headers.authorization ? "ACTIVE_VERIFIED_CUSTOMER_REQUIRED" : "AUTHENTICATION_REQUIRED"
        });
        return true;
      }
    } catch (error) {
      if (isJwtError(error)) send(res, 401, { error: "INVALID_SESSION" });
      else {
        console.error("FlowPay transfer authentication failed:", error instanceof Error ? error.message : "unknown error");
        send(res, 503, { error: "FLOWPAY_TRANSFER_AUTH_UNAVAILABLE" });
      }
      return true;
    }

    if (req.method === "GET" && path === "/customer/transaction-pin/status") {
      try {
        const result = await pool.query(
          "SELECT 1 FROM public.fp_transaction_pins WHERE user_id = $1 LIMIT 1",
          [identity.id]
        );
        send(res, 200, { transactionPinSet: result.rowCount === 1, pinLength: 6 });
      } catch (error) {
        console.error("FlowPay transaction PIN status failed:", error instanceof Error ? error.message : "database error");
        send(res, 503, { error: "TRANSACTION_PIN_STATUS_UNAVAILABLE" });
      }
      return true;
    }

    let input: Record<string, unknown>;
    try { input = await readJson(req); }
    catch (error) {
      const message = error instanceof Error ? error.message : "INVALID_PAYLOAD";
      send(res, message === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: message });
      return true;
    }

    if (path === "/customer/transaction-pin/setup") {
      if (Object.keys(input).some(key => !["pin", "confirmPin"].includes(key))) {
        send(res, 400, { error: "UNSUPPORTED_TRANSACTION_PIN_FIELD" });
        return true;
      }
      if (typeof input.pin !== "string" || !/^\d{6}$/.test(input.pin) ||
          typeof input.confirmPin !== "string" || input.confirmPin !== input.pin) {
        send(res, 400, { error: "TRANSACTION_PIN_MUST_BE_SIX_MATCHING_DIGITS" });
        return true;
      }
      try {
        const salt = randomBytes(16);
        const hash = await derivePin(input.pin, salt);
        const saved = await pool.query(
          `INSERT INTO public.fp_transaction_pins (user_id, pin_salt, pin_hash)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id) DO NOTHING
           RETURNING user_id`,
          [identity.id, salt, hash]
        );
        if (saved.rowCount !== 1) {
          send(res, 409, { error: "TRANSACTION_PIN_ALREADY_SET" });
          return true;
        }
        send(res, 201, { saved: true, transactionPinSet: true });
      } catch (error) {
        console.error("FlowPay transaction PIN setup failed:", error instanceof Error ? error.message : "database error");
        send(res, 503, { error: "TRANSACTION_PIN_SETUP_UNAVAILABLE" });
      }
      return true;
    }

    if (path === "/customer/flowpay/recipients/lookup") {
      if (Object.keys(input).some(key => key !== "accountNumber") || !validAccountNumber(input.accountNumber)) {
        send(res, 400, { error: "INVALID_FLOWPAY_ACCOUNT_NUMBER" });
        return true;
      }
      try {
        const result = await pool.query<{
          id: string; recipient_name: string; account_number: string;
        }>(
          `SELECT customer.id,
                  COALESCE(NULLIF(BTRIM(auth_user.name), ''), 'FlowPay Customer') AS recipient_name,
                  account_number.account_number
             FROM public.fp_customer_account_numbers AS account_number
             JOIN public.fp_users AS customer ON customer.id = account_number.user_id
             JOIN neon_auth."user" AS auth_user ON auth_user.id::text = customer.auth_subject
            WHERE account_number.account_number = $1
              AND customer.status = 'active'
              AND customer.role = 'customer'
              AND auth_user."emailVerified" = true
            LIMIT 1`,
          [input.accountNumber]
        );
        if (result.rowCount !== 1) {
          send(res, 404, { error: "FLOWPAY_RECIPIENT_NOT_FOUND" });
          return true;
        }
        const recipient = result.rows[0];
        send(res, 200, {
          verified: true,
          recipientName: recipient.recipient_name,
          accountNumber: recipient.account_number.trim(),
          currency: "NGN",
          canTransfer: recipient.id !== identity.id,
          message: recipient.id === identity.id
            ? "This is your own FlowPay account. Select another recipient."
            : "Recipient identity matched an active, email-verified FlowPay customer."
        });
      } catch (error) {
        console.error("FlowPay recipient lookup failed:", error instanceof Error ? error.message : "database error");
        send(res, 503, { error: "FLOWPAY_RECIPIENT_LOOKUP_UNAVAILABLE" });
      }
      return true;
    }

    if (path === "/customer/transfers/flowpay") {
      if (Object.keys(input).some(key => ![
        "recipientAccountNumber", "amountMinor", "currency", "idempotencyKey", "transactionPin"
      ].includes(key))) {
        send(res, 400, { error: "UNSUPPORTED_TRANSFER_FIELD" });
        return true;
      }
      if (!validAccountNumber(input.recipientAccountNumber) ||
          typeof input.amountMinor !== "string" || !/^\d{1,15}$/.test(input.amountMinor) ||
          !Number.isSafeInteger(Number(input.amountMinor)) || BigInt(input.amountMinor) <= 0n ||
          input.currency !== "NGN" || !validUuid(input.idempotencyKey) ||
          typeof input.transactionPin !== "string" || !/^\d{6}$/.test(input.transactionPin)) {
        send(res, 400, { error: "INVALID_FLOWPAY_TRANSFER_DETAILS" });
        return true;
      }

      let client: PoolClient;
      try { client = await pool.connect(); }
      catch {
        send(res, 503, { error: "FLOWPAY_TRANSFER_DATABASE_UNAVAILABLE" });
        return true;
      }
      try {
        await client.query("BEGIN");

        const recipientResult = await client.query<{
          id: string; account_number: string; recipient_name: string;
        }>(
          `SELECT customer.id, account_number.account_number,
                  COALESCE(NULLIF(BTRIM(auth_user.name), ''), 'FlowPay Customer') AS recipient_name
             FROM public.fp_customer_account_numbers AS account_number
             JOIN public.fp_users AS customer ON customer.id = account_number.user_id
             JOIN neon_auth."user" AS auth_user ON auth_user.id::text = customer.auth_subject
            WHERE account_number.account_number = $1
              AND customer.status = 'active'
              AND customer.role = 'customer'
              AND auth_user."emailVerified" = true
            LIMIT 1`,
          [input.recipientAccountNumber]
        );
        if (recipientResult.rowCount !== 1) {
          await client.query("ROLLBACK");
          send(res, 404, { error: "FLOWPAY_RECIPIENT_NOT_FOUND" });
          return true;
        }
        const recipient = recipientResult.rows[0];
        if (recipient.id === identity.id) {
          await client.query("ROLLBACK");
          send(res, 400, { error: "CANNOT_TRANSFER_TO_SAME_ACCOUNT" });
          return true;
        }

        // Lock sender and recipient in the same UUID order to prevent opposite-
        // direction transfers from deadlocking each other.
        const eligibleUsers = await client.query<{ id: string }>(
          `SELECT id FROM public.fp_users
            WHERE id = ANY($1::uuid[]) AND role = 'customer' AND status = 'active'
            ORDER BY id FOR UPDATE`,
          [[identity.id, recipient.id]]
        );
        if (eligibleUsers.rowCount !== 2) {
          await client.query("ROLLBACK");
          send(res, 403, { error: "ACTIVE_FLOWPAY_CUSTOMER_REQUIRED" });
          return true;
        }

        const idempotencyKey = `flowpay-internal:${identity.id}:${input.idempotencyKey}`;
        const prior = await client.query<{
          id: string; status: string; sender_user_id: string; recipient_user_id: string;
          recipient_account_number: string; amount_minor: string; currency: string; reference: string;
        }>(
          `SELECT t.id, t.status, d.sender_user_id, d.recipient_user_id,
                  d.recipient_account_number, d.amount_minor::text, d.currency, d.reference
             FROM public.fp_ledger_transactions AS t
             JOIN public.fp_internal_transfer_details AS d ON d.transaction_id = t.id
            WHERE t.idempotency_key = $1
            FOR UPDATE OF t`,
          [idempotencyKey]
        );
        if (prior.rowCount === 1) {
          const saved = prior.rows[0];
          const matches = saved.sender_user_id === identity.id &&
            saved.recipient_user_id === recipient.id &&
            saved.recipient_account_number.trim() === input.recipientAccountNumber &&
            saved.amount_minor === input.amountMinor && saved.currency.trim() === "NGN";
          await client.query("COMMIT");
          if (!matches) {
            send(res, 409, { error: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_TRANSFER" });
          } else {
            send(res, 200, {
              transactionId: saved.id, reference: saved.reference, status: saved.status,
              amountMinor: saved.amount_minor, currency: "NGN",
              recipientName: recipient.recipient_name, duplicate: true
            });
          }
          return true;
        }

        const pinState = await verifyTransactionPin(client, identity.id, input.transactionPin);
        if (pinState !== "verified") {
          await client.query("COMMIT");
          const error = pinState === "missing" ? "TRANSACTION_PIN_SETUP_REQUIRED"
            : pinState === "locked" ? "TRANSACTION_PIN_TEMPORARILY_LOCKED"
              : "INVALID_TRANSACTION_PIN";
          send(res, pinState === "missing" ? 403 : pinState === "locked" ? 429 : 401, { error });
          return true;
        }

        const wallets = await client.query<{
          id: string; user_id: string; status: string;
        }>(
          `SELECT id, user_id, status
             FROM public.fp_accounts
            WHERE user_id = ANY($1::uuid[])
              AND account_type = 'customer'
              AND currency = 'NGN'
            ORDER BY id
            FOR UPDATE`,
          [[identity.id, recipient.id]]
        );
        const senderWallets = wallets.rows.filter(row => row.user_id === identity.id);
        const recipientWallets = wallets.rows.filter(row => row.user_id === recipient.id);
        if (senderWallets.length !== 1 || recipientWallets.length !== 1) {
          await client.query("ROLLBACK");
          send(res, 409, { error: "NGN_WALLET_ACCOUNT_NOT_UNIQUELY_CONFIGURED" });
          return true;
        }
        if (senderWallets[0].status !== "active" || recipientWallets[0].status !== "active") {
          await client.query("ROLLBACK");
          send(res, 403, { error: "NGN_WALLET_NOT_ACTIVE" });
          return true;
        }

        const balance = await client.query<{ balance_minor: string }>(
          `SELECT COALESCE(SUM(entry.amount_minor), 0)::text AS balance_minor
             FROM public.fp_ledger_entries AS entry
             JOIN public.fp_ledger_transactions AS transaction
               ON transaction.id = entry.transaction_id
            WHERE entry.account_id = $1
              AND entry.currency = 'NGN'
              AND transaction.status = 'posted'`,
          [senderWallets[0].id]
        );
        const available = BigInt(balance.rows[0]?.balance_minor ?? "0");
        const amount = BigInt(input.amountMinor);
        if (available < amount) {
          await client.query("ROLLBACK");
          send(res, 409, { error: "INSUFFICIENT_AVAILABLE_BALANCE" });
          return true;
        }

        const reference = `FPW-${randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`;
        const transaction = await client.query<{ id: string }>(
          `INSERT INTO public.fp_ledger_transactions
             (idempotency_key, transaction_type, status, description)
           VALUES ($1, 'flowpay_wallet_transfer', 'pending', 'FlowPay wallet transfer')
           RETURNING id`,
          [idempotencyKey]
        );
        const transactionId = transaction.rows[0].id;
        await client.query(
          `INSERT INTO public.fp_internal_transfer_details
             (transaction_id, sender_user_id, recipient_user_id, recipient_account_number,
              reference, amount_minor, currency)
           VALUES ($1, $2, $3, $4, $5, $6, 'NGN')`,
          [transactionId, identity.id, recipient.id, input.recipientAccountNumber, reference, input.amountMinor]
        );
        await client.query(
          `INSERT INTO public.fp_ledger_entries (transaction_id, account_id, amount_minor, currency)
           VALUES ($1, $2, $3, 'NGN'), ($1, $4, $5, 'NGN')`,
          [transactionId, senderWallets[0].id, (-amount).toString(), recipientWallets[0].id, amount.toString()]
        );
        const posted = await client.query(
          `UPDATE public.fp_ledger_transactions
              SET status = 'posted', posted_at = NOW()
            WHERE id = $1 AND status = 'pending'`,
          [transactionId]
        );
        if (posted.rowCount !== 1) throw new Error("FLOWPAY_TRANSFER_POST_FAILED");

        await client.query("COMMIT");
        send(res, 201, {
          transactionId, reference, status: "posted", amountMinor: input.amountMinor,
          currency: "NGN", recipientName: recipient.recipient_name,
          message: "FlowPay wallet transfer posted to both customer ledgers."
        });
        return true;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (error instanceof Error && error.message === "FLOWPAY_TRANSFER_POST_FAILED") {
          send(res, 503, { error: "FLOWPAY_TRANSFER_POST_FAILED" });
        } else {
          console.error("FlowPay internal transfer failed:", error instanceof Error ? error.message : "database error");
          send(res, 503, { error: "FLOWPAY_TRANSFER_UNAVAILABLE" });
        }
        return true;
      } finally {
        client.release();
      }
    }
    return false;
  };
}
