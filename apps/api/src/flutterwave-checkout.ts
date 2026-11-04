import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { createRemoteJWKSet, jwtVerify } from "jose";

type Options = {
  pool: Pool | null;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
  issuer?: string;
  audience?: string;
};

type DepositIdentity = {
  id: string;
  email: string;
  name: string | null;
};

type DepositRow = {
  id: string;
  checkout_url: string | null;
  status: "pending" | "posted" | "failed";
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let raw = "";
  for await (const chunk of req) {
    raw += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(raw, "utf8") > 8_192) {
      throw Object.assign(new Error("PAYLOAD_TOO_LARGE"), { statusCode: 413 });
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    throw Object.assign(new Error("INVALID_JSON"), { statusCode: 400 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("INVALID_PAYLOAD"), { statusCode: 400 });
  }
  return parsed as Record<string, unknown>;
}

function validAmountMinor(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const raw = String(value);
  if (!/^\d{1,15}$/.test(raw)) return null;
  const amount = Number(raw);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function validIdempotencyKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)
    ? key.toLowerCase()
    : null;
}

function validHttpsUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

async function markProviderFailure(pool: Pool, transactionId: string) {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE public.fp_flutterwave_deposits
          SET status = 'failed'
        WHERE transaction_id = $1 AND status = 'pending'`,
      [transactionId]
    );
    await client.query(
      `UPDATE public.fp_ledger_transactions
          SET status = 'failed'
        WHERE id = $1 AND status = 'pending'`,
      [transactionId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function createFlutterwaveCheckoutHandler(options: Options) {
  const { pool, jwks, issuer, audience } = options;

  return async function handleFlutterwaveCheckout(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
    if (req.method !== "POST" || pathname !== "/customer/flutterwave/deposits") return false;

    if (!pool || !jwks || !issuer || !audience) {
      send(res, 503, { error: "FLUTTERWAVE_CHECKOUT_SERVICE_NOT_CONFIGURED" });
      return true;
    }

    const authorization = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if (!authorization) {
      send(res, 401, { error: "AUTHENTICATION_REQUIRED" });
      return true;
    }

    let userId: string;
    let email: string;
    let fullName: string;
    try {
      const { payload } = await jwtVerify(authorization[1], jwks, {
        algorithms: ["EdDSA"],
        issuer,
        audience
      });
      if (typeof payload.sub !== "string" || !payload.sub) {
        send(res, 401, { error: "INVALID_SESSION" });
        return true;
      }
      const identity = await pool.query<DepositIdentity>(
        `SELECT app_user.id, auth_user.email, auth_user.name
           FROM neon_auth."user" AS auth_user
           JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
          WHERE auth_user.id::text = $1
            AND auth_user."emailVerified" = true
            AND app_user.status = 'active'
          LIMIT 1`,
        [payload.sub]
      );
      if (identity.rowCount !== 1 || !identity.rows[0].email) {
        send(res, 403, { error: "ACTIVE_VERIFIED_CUSTOMER_REQUIRED" });
        return true;
      }
      userId = identity.rows[0].id;
      email = identity.rows[0].email;
      fullName = identity.rows[0].name?.trim() || email;
    } catch (error) {
      if (error instanceof Error && [
        "JWTExpired", "JWSSignatureVerificationFailed", "JWTClaimValidationFailed", "JWSInvalid", "JWTInvalid"
      ].includes(error.name)) {
        send(res, 401, { error: "INVALID_SESSION" });
        return true;
      }
      console.error("FlowPay Flutterwave customer authentication failed:", error instanceof Error ? error.message : "unknown error");
      send(res, 503, { error: "FLUTTERWAVE_CHECKOUT_AUTH_UNAVAILABLE" });
      return true;
    }

    let input: Record<string, unknown>;
    try {
      input = (await readJson(req)) ?? {};
    } catch (error) {
      const status = error && typeof error === "object" && "statusCode" in error
        ? Number((error as { statusCode: unknown }).statusCode) : 400;
      send(res, status, { error: error instanceof Error ? error.message : "INVALID_PAYLOAD" });
      return true;
    }

    if (Object.keys(input).some(key => !["amountMinor", "idempotencyKey"].includes(key))) {
      send(res, 400, { error: "UNSUPPORTED_DEPOSIT_FIELD" });
      return true;
    }
    const amountMinor = validAmountMinor(input.amountMinor);
    const idempotencyKey = validIdempotencyKey(input.idempotencyKey);
    if (amountMinor === null) {
      send(res, 400, { error: "INVALID_AMOUNT_MINOR" });
      return true;
    }
    if (!idempotencyKey) {
      send(res, 400, { error: "VALID_IDEMPOTENCY_KEY_REQUIRED" });
      return true;
    }

    const secretKey = process.env.FLW_SECRET_KEY?.trim() ?? "";
    const redirectUrl = validHttpsUrl(process.env.FLW_REDIRECT_URL?.trim());
    const minMinor = Number(process.env.FLW_DEPOSIT_MIN_MINOR);
    const maxMinor = Number(process.env.FLW_DEPOSIT_MAX_MINOR);
    if (
      process.env.FLW_ENVIRONMENT !== "test" ||
      !secretKey.startsWith("FLWSECK_TEST-") ||
      !redirectUrl ||
      !Number.isSafeInteger(minMinor) || minMinor <= 0 ||
      !Number.isSafeInteger(maxMinor) || maxMinor < minMinor
    ) {
      send(res, 503, { error: "FLUTTERWAVE_SANDBOX_CONFIGURATION_REQUIRED" });
      return true;
    }
    if (amountMinor < minMinor || amountMinor > maxMinor) {
      send(res, 400, { error: "DEPOSIT_AMOUNT_OUT_OF_RANGE", minimumMinor: minMinor, maximumMinor: maxMinor });
      return true;
    }

    const databaseIdempotencyKey = `flutterwave-deposit:${userId}:${idempotencyKey}`;
    const providerReference = `flowpay-flw-${randomUUID()}`;
    let transactionId: string;
    let existingCheckoutUrl: string | null = null;
    let wasCreated = false;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const accounts = await client.query<{ id: string }>(
        `SELECT id
           FROM public.fp_accounts
          WHERE user_id = $1 AND account_type = 'customer'
            AND currency = 'NGN' AND status = 'active'
          ORDER BY created_at
          FOR SHARE`,
        [userId]
      );
      if (accounts.rowCount !== 1) {
        await client.query("ROLLBACK");
        send(res, accounts.rowCount === 0 ? 409 : 409, {
          error: accounts.rowCount === 0 ? "ACTIVE_NGN_WALLET_REQUIRED" : "MULTIPLE_ACTIVE_NGN_WALLETS_REQUIRE_REVIEW"
        });
        return true;
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO public.fp_ledger_transactions
           (idempotency_key, transaction_type, status, description)
         VALUES ($1, 'flutterwave_deposit', 'pending', 'Flutterwave NGN sandbox deposit')
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [databaseIdempotencyKey]
      );

      if (inserted.rowCount === 1) {
        transactionId = inserted.rows[0].id;
        await client.query(
          `INSERT INTO public.fp_flutterwave_deposits
             (transaction_id, user_id, account_id, provider_tx_ref, amount_minor, currency, status)
           VALUES ($1, $2, $3, $4, $5, 'NGN', 'pending')`,
          [transactionId, userId, accounts.rows[0].id, providerReference, String(amountMinor)]
        );
        wasCreated = true;
      } else {
        const existing = await client.query<DepositRow>(
          `SELECT t.id, d.checkout_url, d.status
             FROM public.fp_ledger_transactions AS t
             LEFT JOIN public.fp_flutterwave_deposits AS d ON d.transaction_id = t.id
            WHERE t.idempotency_key = $1
            FOR UPDATE OF t`,
          [databaseIdempotencyKey]
        );
        if (existing.rowCount !== 1 || !existing.rows[0]) {
          throw new Error("IDEMPOTENCY_RECORD_UNAVAILABLE");
        }
        transactionId = existing.rows[0].id;
        existingCheckoutUrl = existing.rows[0].checkout_url;
        if (existing.rows[0].status !== "pending" || !existingCheckoutUrl) {
          await client.query("ROLLBACK");
          send(res, 409, { error: "DEPOSIT_REQUEST_ALREADY_PROCESSING_OR_FINAL" });
          return true;
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("FlowPay Flutterwave deposit setup failed:", error instanceof Error ? error.message : "unknown database error");
      send(res, 503, { error: "DEPOSIT_SETUP_UNAVAILABLE" });
      return true;
    } finally {
      client.release();
    }

    if (existingCheckoutUrl) {
      send(res, 200, { transactionId, status: "pending", environment: "test", checkoutUrl: existingCheckoutUrl });
      return true;
    }
    if (!wasCreated) {
      send(res, 409, { error: "DEPOSIT_REQUEST_ALREADY_PROCESSING" });
      return true;
    }

    const amountAsNaira = `${BigInt(amountMinor) / 100n}.${(BigInt(amountMinor) % 100n).toString().padStart(2, "0")}`;
    let providerResponse: Response;
    let providerBody: unknown;
    try {
      providerResponse = await fetch("https://api.flutterwave.com/v3/payments", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          tx_ref: providerReference,
          amount: amountAsNaira,
          currency: "NGN",
          redirect_url: redirectUrl,
          customer: { email, name: fullName },
          customizations: { title: "FlowPay Wallet Funding", description: "NGN wallet deposit" },
          meta: { flowpay_transaction_id: transactionId }
        }),
        signal: AbortSignal.timeout(12_000)
      });
      providerBody = await providerResponse.json().catch(() => null);
    } catch (error) {
      // A timeout can happen after Flutterwave has created the hosted checkout.
      // Keep the pending record for manual/reference-based reconciliation; do not
      // mark it failed or create another provider session on an idempotent retry.
      console.error("FlowPay Flutterwave checkout request outcome is uncertain:", error instanceof Error ? error.message : "provider network error");
      send(res, 502, { error: "FLUTTERWAVE_CHECKOUT_OUTCOME_UNCONFIRMED", transactionId, status: "pending" });
      return true;
    }

    const body = providerBody && typeof providerBody === "object" && !Array.isArray(providerBody)
      ? providerBody as Record<string, unknown> : {};
    const data = body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? body.data as Record<string, unknown> : {};
    const checkoutUrl = typeof data.link === "string" ? data.link : "";
    let safeCheckoutUrl = false;
    try {
      const url = new URL(checkoutUrl);
      safeCheckoutUrl = url.protocol === "https:" && url.hostname === "checkout.flutterwave.com"
        && url.pathname.startsWith("/v3/hosted/pay/");
    } catch {
      safeCheckoutUrl = false;
    }

    if (providerResponse.status >= 500) {
      // A provider-side server error can still follow session creation. Keep
      // the pending row for reconciliation instead of labelling it failed.
      console.error("FlowPay Flutterwave checkout outcome is uncertain:", providerResponse.status);
      send(res, 502, { error: "FLUTTERWAVE_CHECKOUT_OUTCOME_UNCONFIRMED", transactionId, status: "pending" });
      return true;
    }

    if (!providerResponse.ok || body.status !== "success" || !safeCheckoutUrl) {
      try {
        await markProviderFailure(pool, transactionId);
      } catch (error) {
        console.error("FlowPay could not record Flutterwave checkout failure:", error instanceof Error ? error.message : "database update failed");
      }
      console.error("FlowPay Flutterwave checkout was rejected:", providerResponse.status);
      send(res, 502, { error: "FLUTTERWAVE_CHECKOUT_CREATION_FAILED" });
      return true;
    }

    try {
      const saved = await pool.query(
        `UPDATE public.fp_flutterwave_deposits
            SET checkout_url = $2
          WHERE transaction_id = $1 AND status = 'pending'`,
        [transactionId, checkoutUrl]
      );
      if (saved.rowCount !== 1) throw new Error("DEPOSIT_CHECKOUT_LINK_NOT_SAVED");
    } catch (error) {
      console.error("FlowPay could not persist Flutterwave checkout link:", error instanceof Error ? error.message : "database update failed");
      send(res, 503, { error: "CHECKOUT_LINK_PERSISTENCE_FAILED", transactionId, status: "pending" });
      return true;
    }

    send(res, 201, {
      transactionId,
      providerReference,
      status: "pending",
      environment: "test",
      checkoutUrl
    });
    return true;
  };
}
