import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";

type SandboxType = "deposit" | "withdrawal" | "payment" | "transfer";
type AccountRow = { id: string; currency: string; status: string; user_id: string | null };

function reply(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString("utf8");
    if (raw.length > 8192) throw new Error("REQUEST_TOO_LARGE");
  }
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : null;
}

async function ensureAccount(client: PoolClient, userId: string): Promise<AccountRow> {
  const result = await client.query<AccountRow>(
    `INSERT INTO fp_sandbox_accounts(user_id, account_type, currency)
     VALUES ($1, 'customer', 'NGN')
     ON CONFLICT (user_id, currency) WHERE account_type = 'customer'
     DO UPDATE SET status = fp_sandbox_accounts.status
     RETURNING id, currency, status, user_id`,
    [userId]
  );
  const account = result.rows[0];
  if (!account || account.status !== "active") throw new Error("SANDBOX_ACCOUNT_UNAVAILABLE");
  await client.query(
    `INSERT INTO fp_sandbox_accounts(account_type, currency)
     VALUES ('clearing', 'NGN')
     ON CONFLICT (currency) WHERE account_type = 'clearing'
     DO NOTHING`
  );
  return account;
}

async function balance(client: PoolClient, accountId: string): Promise<bigint> {
  const result = await client.query<{ balance_minor: string }>(
    `SELECT COALESCE(SUM(e.amount_minor), 0)::text AS balance_minor
     FROM fp_sandbox_entries e
     JOIN fp_sandbox_transactions t ON t.id = e.transaction_id
     WHERE e.account_id = $1 AND t.status = 'posted'`,
    [accountId]
  );
  return BigInt(result.rows[0]?.balance_minor ?? "0");
}

export async function handleSandboxRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pool: Pool,
  subject: string,
  pathname: string
): Promise<boolean> {
  if (!pathname.startsWith("/v1/sandbox/")) return false;
  if (process.env.FLOWPAY_SANDBOX_ENABLED !== "true") {
    reply(res, 404, { error: "SANDBOX_DISABLED", mode: "sandbox_unavailable", live_payments: "disabled" });
    return true;
  }
  if (!["GET", "POST"].includes(req.method ?? "")) {
    reply(res, 405, { error: "METHOD_NOT_ALLOWED" });
    return true;
  }

  const customerResult = await pool.query<{ id: string; status: string }>(
    "SELECT id, status FROM fp_users WHERE auth_subject = $1 LIMIT 1", [subject]
  );
  const customer = customerResult.rows[0];
  if (!customer || customer.status !== "active") {
    reply(res, customer ? 403 : 404, { error: customer ? "CUSTOMER_PROFILE_INACTIVE" : "CUSTOMER_PROFILE_NOT_FOUND" });
    return true;
  }

  if (req.method === "GET" && pathname === "/v1/sandbox/account") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const account = await ensureAccount(client, customer.id);
      const currentBalance = await balance(client, account.id);
      await client.query("COMMIT");
      reply(res, 200, {
        mode: "sandbox", simulated: true, live_payments: "disabled",
        account: { id: account.id, currency: "NGN", status: account.status, balance_minor: currentBalance.toString() }
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      reply(res, 503, { error: error instanceof Error ? error.message : "SANDBOX_ACCOUNT_UNAVAILABLE" });
    } finally { client.release(); }
    return true;
  }

  if (req.method === "GET" && pathname === "/v1/sandbox/transactions") {
    const result = await pool.query(
      `SELECT id, transaction_type, status, amount_minor::text, currency,
              description, counterparty_account_id, created_at
       FROM fp_sandbox_transactions
       WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`,
      [customer.id]
    );
    reply(res, 200, { mode: "sandbox", simulated: true, transactions: result.rows });
    return true;
  }

  const match = /^\/v1\/sandbox\/(deposits|withdrawals|payments|transfers)$/.exec(pathname);
  if (req.method !== "POST" || !match) {
    reply(res, 404, { error: "NOT_FOUND" });
    return true;
  }

  const typeByPath: Record<string, SandboxType> = {
    deposits: "deposit", withdrawals: "withdrawal", payments: "payment", transfers: "transfer"
  };
  const type = typeByPath[match[1]];
  const idempotencyKey = req.headers["idempotency-key"];
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    reply(res, 400, { error: "INVALID_IDEMPOTENCY_KEY" });
    return true;
  }

  let body: Record<string, unknown> | null;
  try { body = await readBody(req); }
  catch (error) {
    reply(res, error instanceof Error && error.message === "REQUEST_TOO_LARGE" ? 413 : 400,
      { error: error instanceof Error && error.message === "REQUEST_TOO_LARGE" ? "REQUEST_TOO_LARGE" : "INVALID_JSON" });
    return true;
  }
  if (!body || typeof body.amountMinor !== "string" || !/^[1-9][0-9]{0,11}$/.test(body.amountMinor)) {
    reply(res, 400, { error: "INVALID_AMOUNT", details: "amountMinor must be a positive integer string in kobo." });
    return true;
  }
  const amount = BigInt(body.amountMinor);
  if (amount > 100_000_000_000n) {
    reply(res, 400, { error: "AMOUNT_EXCEEDS_SANDBOX_LIMIT" });
    return true;
  }
  const counterpartyId = type === "transfer" ? body.destinationSandboxAccountId : null;
  if (type === "transfer" && (typeof counterpartyId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(counterpartyId))) {
    reply(res, 400, { error: "INVALID_SANDBOX_DESTINATION" });
    return true;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const source = await ensureAccount(client, customer.id);
    const clearingResult = await client.query<AccountRow>(
      "SELECT id, currency, status, user_id FROM fp_sandbox_accounts WHERE account_type = 'clearing' AND currency = 'NGN' FOR UPDATE"
    );
    const clearing = clearingResult.rows[0];
    if (!clearing) throw new Error("SANDBOX_CLEARING_ACCOUNT_UNAVAILABLE");

    let destination: AccountRow | null = null;
    if (type === "transfer") {
      const destinationResult = await client.query<AccountRow>(
        "SELECT id, currency, status, user_id FROM fp_sandbox_accounts WHERE id = $1 AND account_type = 'customer' FOR UPDATE",
        [counterpartyId]
      );
      destination = destinationResult.rows[0] ?? null;
      if (!destination || destination.status !== "active" || destination.currency.trim() !== "NGN") {
        await client.query("ROLLBACK");
        reply(res, 404, { error: "SANDBOX_DESTINATION_NOT_FOUND" });
        return true;
      }
      if (destination.id === source.id) {
        await client.query("ROLLBACK");
        reply(res, 400, { error: "CANNOT_TRANSFER_TO_SAME_ACCOUNT" });
        return true;
      }
    }

    const replay = await client.query<{
      id: string; transaction_type: string; amount_minor: string; counterparty_account_id: string | null;
    }>(
      "SELECT id, transaction_type, amount_minor::text, counterparty_account_id FROM fp_sandbox_transactions WHERE idempotency_key = $1 AND user_id = $2",
      [idempotencyKey, customer.id]
    );
    if (replay.rows.length) {
      const previous = replay.rows[0];
      if (previous.transaction_type !== type || previous.amount_minor !== amount.toString() ||
          previous.counterparty_account_id !== (destination?.id ?? null)) {
        await client.query("ROLLBACK");
        reply(res, 409, { error: "IDEMPOTENCY_KEY_CONFLICT" });
        return true;
      }
      await client.query("COMMIT");
      reply(res, 200, { mode: "sandbox", simulated: true, replayed: true, transactionId: previous.id, status: "posted", live_payments: "disabled" });
      return true;
    }

    if (type !== "deposit") {
      const available = await balance(client, source.id);
      if (available < amount) {
        await client.query("ROLLBACK");
        reply(res, 409, { error: "INSUFFICIENT_SANDBOX_FUNDS", availableMinor: available.toString() });
        return true;
      }
    }

    const description = type === "deposit" ? "Simulated sandbox deposit"
      : type === "withdrawal" ? "Simulated sandbox withdrawal"
      : type === "payment" ? "Simulated sandbox payment" : "Simulated internal sandbox transfer";
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO fp_sandbox_transactions
       (idempotency_key, user_id, transaction_type, amount_minor, currency, description, counterparty_account_id)
       VALUES ($1, $2, $3, $4, 'NGN', $5, $6) RETURNING id`,
      [idempotencyKey, customer.id, type, amount.toString(), description, destination?.id ?? null]
    );
    const transactionId = inserted.rows[0].id;
    const debitAccount = type === "deposit" ? clearing.id : source.id;
    const creditAccount = type === "deposit" ? source.id : type === "transfer" ? destination!.id : clearing.id;
    if (type === "transfer") {
      await client.query(
        "INSERT INTO fp_sandbox_entries(transaction_id, account_id, amount_minor, currency) VALUES ($1, $2, $3, 'NGN'), ($1, $4, $5, 'NGN')",
        [transactionId, source.id, (-amount).toString(), destination!.id, amount.toString()]
      );
    } else {
      const debit = type === "deposit" ? -amount : -amount;
      const credit = type === "deposit" ? amount : amount;
      await client.query(
        "INSERT INTO fp_sandbox_entries(transaction_id, account_id, amount_minor, currency) VALUES ($1, $2, $3, 'NGN'), ($1, $4, $5, 'NGN')",
        [transactionId, debitAccount, debit.toString(), creditAccount, credit.toString()]
      );
    }
    const newBalance = await balance(client, source.id);
    await client.query("COMMIT");
    reply(res, 201, {
      mode: "sandbox", simulated: true, replayed: false, transactionId,
      transactionType: type, status: "posted", amountMinor: amount.toString(),
      currency: "NGN", balanceMinor: newBalance.toString(), live_payments: "disabled"
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      reply(res, 409, { error: "IDEMPOTENCY_KEY_CONFLICT" });
    } else {
      console.error("FlowPay sandbox operation failed:", error instanceof Error ? error.message : "unknown error");
      reply(res, 503, { error: error instanceof Error ? error.message : "SANDBOX_OPERATION_UNAVAILABLE" });
    }
  } finally { client.release(); }
  return true;
}
