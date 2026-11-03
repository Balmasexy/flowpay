import { timingSafeEqual, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";

type Customer = { id: string; email: string | null };
type ProviderTransaction = {
  id?: number | string;
  tx_ref?: string;
  status?: string;
  currency?: string;
  amount?: number | string;
};
type DepositRow = {
  id: string;
  user_id: string;
  account_id: string;
  provider_reference: string;
  amount_minor: string;
  status: string;
  checkout_url: string | null;
};

function reply(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function sandboxEnabled() {
  return process.env.FLOWPAY_FLUTTERWAVE_SANDBOX_ENABLED === "true";
}

function secretKey(): string | null {
  const value = (process.env.FLUTTERWAVE_SECRET_KEY || process.env.FLW_SECRET_KEY || "").trim();
  // Flutterwave v3 test-mode secret keys use the FLWSECK_TEST- prefix.
  return value.startsWith("FLWSECK_TEST-") ? value : null;
}

function webhookHash(): string | null {
  return process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH?.trim() || null;
}

function callbackUrl(): string | null {
  const value = process.env.FLOWPAY_FLUTTERWAVE_CALLBACK_URL?.trim() || "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch { return null; }
}

function safeEqual(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(req: IncomingMessage, maxBytes = 8192): Promise<Record<string, unknown> | null> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString("utf8");
    if (Buffer.byteLength(raw, "utf8") > maxBytes) throw new Error("REQUEST_TOO_LARGE");
  }
  const value: unknown = JSON.parse(raw);
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function amountAsNaira(amountMinor: string): string {
  const value = BigInt(amountMinor);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

async function flutterwaveRequest(path: string, init: RequestInit = {}) {
  const key = secretKey();
  if (!key) throw new Error("FLUTTERWAVE_TEST_SECRET_NOT_CONFIGURED");
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${key}`);
  const response = await fetch(`https://api.flutterwave.com/v3${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(15_000)
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload !== "object" || payload === null ||
      !("status" in payload) || payload.status !== "success") {
    throw new Error("FLUTTERWAVE_PROVIDER_REQUEST_FAILED");
  }
  return payload as { status: string; data?: Record<string, unknown> };
}

async function getDepositByReference(pool: Pool, reference: string) {
  const result = await pool.query<DepositRow>(
    `SELECT id, user_id, account_id, provider_reference,
            amount_minor::text, status, checkout_url
       FROM public.fp_flutterwave_deposits
      WHERE provider_reference = $1 LIMIT 1`,
    [reference]
  );
  return result.rows[0] ?? null;
}

export async function handleFlutterwaveDeposit(
  req: IncomingMessage,
  res: ServerResponse,
  pool: Pool,
  customer: Customer
): Promise<void> {
  if (!sandboxEnabled()) {
    reply(res, 404, { error: "FLUTTERWAVE_SANDBOX_DISABLED", live_payments: "disabled" });
    return;
  }
  if (!secretKey() || !webhookHash() || !callbackUrl()) {
    reply(res, 503, {
      error: "FLUTTERWAVE_SANDBOX_NOT_CONFIGURED",
      required_environment: [
        "FLW_SECRET_KEY (Flutterwave TEST key)",
        "FLUTTERWAVE_WEBHOOK_SECRET_HASH",
        "FLOWPAY_FLUTTERWAVE_CALLBACK_URL"
      ],
      live_payments: "disabled"
    });
    return;
  }
  if (!customer.email) {
    reply(res, 400, { error: "CUSTOMER_EMAIL_REQUIRED_FOR_CHECKOUT" });
    return;
  }

  const idempotencyKey = req.headers["idempotency-key"];
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    reply(res, 400, { error: "INVALID_IDEMPOTENCY_KEY" });
    return;
  }

  let body: Record<string, unknown> | null;
  try { body = await readJson(req); }
  catch (error) {
    reply(res, error instanceof Error && error.message === "REQUEST_TOO_LARGE" ? 413 : 400,
      { error: error instanceof Error && error.message === "REQUEST_TOO_LARGE" ? "REQUEST_TOO_LARGE" : "INVALID_JSON" });
    return;
  }
  const accountId = body?.accountId;
  const amountMinor = body?.amountMinor;
  if (typeof accountId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(accountId) ||
      typeof amountMinor !== "string" || !/^[1-9][0-9]{0,11}$/.test(amountMinor) ||
      BigInt(amountMinor) < 100n || BigInt(amountMinor) > 100_000_000_000n) {
    reply(res, 400, { error: "INVALID_DEPOSIT_FIELDS", details: "Provide an owned NGN accountId and a positive amountMinor in kobo." });
    return;
  }

  const client = await pool.connect().catch(() => null);
  if (!client) { reply(res, 503, { error: "DATABASE_UNAVAILABLE" }); return; }
  let deposit: DepositRow | null = null;
  try {
    await client.query("BEGIN");
    const account = await client.query(
      "SELECT id FROM public.fp_accounts WHERE id = $1 AND user_id = $2 AND account_type = 'customer' AND currency = 'NGN' AND status = 'active' FOR UPDATE",
      [accountId, customer.id]
    );
    if (!account.rows[0]) {
      await client.query("ROLLBACK");
      reply(res, 403, { error: "NGN_ACCOUNT_NOT_OWNED_OR_ACTIVE" });
      return;
    }
    const previous = await client.query<DepositRow>(
      `SELECT id, user_id, account_id, provider_reference,
              amount_minor::text, status, checkout_url
         FROM public.fp_flutterwave_deposits
        WHERE idempotency_key = $1 FOR UPDATE`,
      [idempotencyKey]
    );
    if (previous.rows[0]) {
      deposit = previous.rows[0];
      if (deposit.user_id !== customer.id || deposit.account_id !== accountId || deposit.amount_minor !== amountMinor) {
        await client.query("ROLLBACK");
        reply(res, 409, { error: "IDEMPOTENCY_KEY_CONFLICT" });
        return;
      }
      await client.query("COMMIT");
      if (deposit.checkout_url) {
        reply(res, 200, {
          mode: "flutterwave_sandbox", simulated: false, status: deposit.status,
          reference: deposit.provider_reference, checkoutUrl: deposit.checkout_url,
          live_payments: "disabled", replayed: true
        });
        return;
      }
    } else {
      const reference = `flowpay_${randomUUID().replace(/-/g, "")}`;
      const inserted = await client.query<DepositRow>(
        `INSERT INTO public.fp_flutterwave_deposits
          (user_id, account_id, idempotency_key, provider_reference, amount_minor, currency, status)
         VALUES ($1, $2, $3, $4, $5, 'NGN', 'pending')
         RETURNING id, user_id, account_id, provider_reference, amount_minor::text, status, checkout_url`,
        [customer.id, accountId, idempotencyKey, reference, amountMinor]
      );
      deposit = inserted.rows[0];
      await client.query("COMMIT");
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("FlowPay Flutterwave deposit reservation failed:", error instanceof Error ? error.message : "unknown error");
    reply(res, 503, { error: "DEPOSIT_RESERVATION_FAILED" });
    return;
  } finally {
    client.release();
  }

  if (!deposit) { reply(res, 503, { error: "DEPOSIT_RESERVATION_FAILED" }); return; }
  if (deposit.checkout_url) {
    reply(res, 200, {
      mode: "flutterwave_sandbox", simulated: false, status: deposit.status,
      reference: deposit.provider_reference, checkoutUrl: deposit.checkout_url,
      live_payments: "disabled", replayed: true
    });
    return;
  }

  try {
    const response = await flutterwaveRequest("/payments", {
      method: "POST",
      body: JSON.stringify({
        tx_ref: deposit.provider_reference,
        amount: amountAsNaira(amountMinor),
        currency: "NGN",
        redirect_url: callbackUrl(),
        payment_options: "card,banktransfer,ussd",
        customer: { email: customer.email, name: "FlowPay Customer" },
        customizations: { title: "FlowPay Deposit", description: "FlowPay NGN wallet deposit" },
        meta: { flowpay_deposit_id: deposit.id, environment: "sandbox" }
      })
    });
    const checkoutUrl = String(response.data?.link ?? "");
    const parsed = new URL(checkoutUrl);
    if (parsed.protocol !== "https:" || parsed.hostname !== "checkout.flutterwave.com") {
      throw new Error("INVALID_FLUTTERWAVE_CHECKOUT_URL");
    }
    await pool.query(
      "UPDATE public.fp_flutterwave_deposits SET checkout_url = $1, updated_at = NOW() WHERE id = $2 AND status = 'pending'",
      [checkoutUrl, deposit.id]
    );
    reply(res, 201, {
      mode: "flutterwave_sandbox", simulated: false, status: "pending",
      reference: deposit.provider_reference, checkoutUrl,
      amountMinor, currency: "NGN", live_payments: "disabled"
    });
  } catch (error) {
    console.error("FlowPay Flutterwave checkout initiation failed:", error instanceof Error ? error.message : "unknown error");
    reply(res, 503, { error: "FLUTTERWAVE_CHECKOUT_UNAVAILABLE", reference: deposit.provider_reference, status: "pending", live_payments: "disabled" });
  }
}

function providerAmountToMinor(value: number | string | undefined): bigint | null {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(String(value))) return null;
  const [whole, fraction = ""] = String(value).split(".");
  try { return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0")); }
  catch { return null; }
}

async function postVerifiedDeposit(pool: Pool, tx: ProviderTransaction, eventType: string) {
  const reference = String(tx.tx_ref ?? "");
  const providerId = String(tx.id ?? "");
  const deposit = await getDepositByReference(pool, reference);
  if (!deposit) return "unmatched";
  if (deposit.status === "posted") return "duplicate";

  const actualMinor = providerAmountToMinor(tx.amount);
  if (tx.status !== "successful" || String(tx.currency ?? "").toUpperCase() !== "NGN" ||
      actualMinor === null || actualMinor !== BigInt(deposit.amount_minor)) {
    return "not_verified";
  }

  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<DepositRow>(
      `SELECT id, user_id, account_id, provider_reference,
              amount_minor::text, status, checkout_url
         FROM public.fp_flutterwave_deposits
        WHERE id = $1 FOR UPDATE`,
      [deposit.id]
    );
    const current = locked.rows[0];
    if (!current || current.status === "posted") {
      await client.query("ROLLBACK");
      return "duplicate";
    }
    if (current.status !== "pending") {
      await client.query("ROLLBACK");
      return "not_pending";
    }
    const accountResult = await client.query(
      "SELECT id FROM public.fp_accounts WHERE id = $1 AND user_id = $2 AND account_type = 'customer' AND currency = 'NGN' AND status = 'active' FOR UPDATE",
      [current.account_id, current.user_id]
    );
    if (!accountResult.rows[0]) throw new Error("DEPOSIT_ACCOUNT_UNAVAILABLE");

    // Ensure one NGN system clearing account exists without changing any customer balance.
    await client.query("SELECT pg_advisory_xact_lock(71020261103)");
    const clearingResult = await client.query<{ account_id: string }>(
      "SELECT account_id FROM public.fp_provider_accounts WHERE provider = 'flutterwave' AND currency = 'NGN' FOR UPDATE"
    );
    let clearingId = clearingResult.rows[0]?.account_id;
    if (!clearingId) {
      const createdAccount = await client.query<{ id: string }>(
        "INSERT INTO public.fp_accounts (user_id, account_type, currency, status) VALUES (NULL, 'system', 'NGN', 'active') RETURNING id"
      );
      clearingId = createdAccount.rows[0].id;
      await client.query(
        "INSERT INTO public.fp_provider_accounts (provider, currency, account_id) VALUES ('flutterwave', 'NGN', $1)",
        [clearingId]
      );
    }
    const transactionKey = `flutterwave:${reference}`;
    const existingTransaction = await client.query(
      "SELECT id FROM public.fp_ledger_transactions WHERE idempotency_key = $1",
      [transactionKey]
    );
    if (existingTransaction.rows[0]) throw new Error("DEPOSIT_LEDGER_REFERENCE_ALREADY_EXISTS");

    const inserted = await client.query<{ id: string }>(
      "INSERT INTO public.fp_ledger_transactions (idempotency_key, transaction_type, status, description) VALUES ($1, 'flutterwave_sandbox_deposit', 'pending', $2) RETURNING id",
      [transactionKey, "Flutterwave sandbox deposit " + reference]
    );
    const transactionId = inserted.rows[0].id;
    await client.query(
      "INSERT INTO public.fp_ledger_entries (transaction_id, account_id, amount_minor, currency) VALUES ($1, $2, $3, 'NGN'), ($1, $4, $5, 'NGN')",
      [transactionId, current.account_id, current.amount_minor, clearingId, (-BigInt(current.amount_minor)).toString()]
    );
    await client.query(
      "UPDATE public.fp_ledger_transactions SET status = 'posted', posted_at = NOW() WHERE id = $1 AND status = 'pending'",
      [transactionId]
    );
    await client.query(
      "UPDATE public.fp_flutterwave_deposits SET status = 'posted', provider_transaction_id = $1, posted_at = NOW(), updated_at = NOW() WHERE id = $2",
      [providerId, current.id]
    );
    await client.query(
      `INSERT INTO public.fp_payment_events(provider, provider_event_id, event_type, processing_status)
       VALUES ('flutterwave', $1, $2, 'processed')
       ON CONFLICT (provider, provider_event_id) DO NOTHING`,
      [`${providerId}:${String(tx.status)}`, eventType]
    );
    await client.query("COMMIT");
    return "posted";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function handleFlutterwaveWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  pool: Pool | null
): Promise<void> {
  if (!sandboxEnabled()) { reply(res, 404, { error: "FLUTTERWAVE_SANDBOX_DISABLED" }); return; }
  const hash = webhookHash();
  if (!hash || !safeEqual(req.headers["verif-hash"] as string | undefined, hash)) {
    reply(res, 401, { error: "INVALID_FLUTTERWAVE_WEBHOOK_SIGNATURE" });
    return;
  }
  if (!pool) { reply(res, 503, { error: "DATABASE_NOT_CONFIGURED" }); return; }
  let body: Record<string, unknown> | null;
  try { body = await readJson(req, 64 * 1024); }
  catch {
    reply(res, 400, { error: "INVALID_WEBHOOK_BODY" });
    return;
  }
  const data = body?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    reply(res, 200, { received: true, ignored: true });
    return;
  }
  const eventType = typeof body?.event === "string" ? body.event : "unknown";
  const tx = data as ProviderTransaction;
  if (eventType !== "charge.completed" || !tx.id || !tx.tx_ref) {
    reply(res, 200, { received: true, ignored: true });
    return;
  }
  try {
    // Never credit from webhook payload alone: independently verify with Flutterwave.
    const verification = await flutterwaveRequest(`/transactions/${encodeURIComponent(String(tx.id))}/verify`);
    const verified = verification.data as ProviderTransaction | undefined;
    if (!verified || String(verified.id) !== String(tx.id) || verified.tx_ref !== tx.tx_ref) {
      reply(res, 200, { received: true, verified: false });
      return;
    }
    const outcome = await postVerifiedDeposit(pool, verified, eventType);
    reply(res, 200, { received: true, outcome });
  } catch (error) {
    console.error("FlowPay Flutterwave webhook processing failed:", error instanceof Error ? error.message : "unknown error");
    reply(res, 503, { error: "FLUTTERWAVE_WEBHOOK_PROCESSING_FAILED" });
  }
}
