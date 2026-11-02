import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";

type InputRow = {
  beneficiaryName?: unknown;
  accountNumber?: unknown;
  bankCode?: unknown;
  amount?: unknown;
  currency?: unknown;
  reference?: unknown;
};

function send(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString("utf8");
    if (Buffer.byteLength(raw, "utf8") > 2 * 1024 * 1024) throw new Error("TOO_LARGE");
  }
  const value: unknown = JSON.parse(raw);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function amountMinor(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{1,9}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const minor = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  return minor > 0n && minor <= 100_000_000_000n ? minor.toString() : null;
}

export async function handleBulkSandboxRoute(
  req: IncomingMessage, res: ServerResponse, pool: Pool, userId: string, pathname: string
): Promise<boolean> {
  if (!pathname.startsWith("/v1/sandbox/batches")) return false;
  if (process.env.FLOWPAY_SANDBOX_ENABLED !== "true") {
    send(res, 404, { error: "SANDBOX_DISABLED", live_payments: "disabled" });
    return true;
  }

  if (req.method === "GET" && pathname === "/v1/sandbox/batches") {
    const result = await pool.query(
      `SELECT id, batch_type, status, row_count, valid_count, invalid_count, created_at
       FROM fp_sandbox_batches WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [userId]
    );
    send(res, 200, { mode: "sandbox", simulated: true, batches: result.rows, live_payments: "disabled" });
    return true;
  }

  const detail = /^\\/v1\\/sandbox\\/batches\\/([0-9a-f-]{36})$/i.exec(pathname);
  if (req.method === "GET" && detail) {
    const batch = await pool.query(
      `SELECT id, batch_type, status, row_count, valid_count, invalid_count, created_at
       FROM fp_sandbox_batches WHERE id = $1 AND user_id = $2`, [detail[1], userId]
    );
    if (!batch.rows[0]) { send(res, 404, { error: "BATCH_NOT_FOUND" }); return true; }
    const rows = await pool.query(
      `SELECT row_number, beneficiary_name, account_number_masked, bank_code,
              amount_minor::text, currency, status, result_code, result_message
       FROM fp_sandbox_batch_rows WHERE batch_id = $1 ORDER BY row_number`, [detail[1]]
    );
    send(res, 200, { mode: "sandbox", simulated: true, batch: batch.rows[0], rows: rows.rows, live_payments: "disabled" });
    return true;
  }

  if (req.method !== "POST" || pathname !== "/v1/sandbox/batches") {
    send(res, 405, { error: "METHOD_NOT_ALLOWED" });
    return true;
  }
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || key.length < 8 || key.length > 200) {
    send(res, 400, { error: "INVALID_IDEMPOTENCY_KEY" }); return true;
  }

  let body: Record<string, unknown> | null;
  try { body = await readJson(req); }
  catch (error) {
    send(res, error instanceof Error && error.message === "TOO_LARGE" ? 413 : 400,
      { error: error instanceof Error && error.message === "TOO_LARGE" ? "REQUEST_TOO_LARGE" : "INVALID_JSON" });
    return true;
  }
  const type = body?.type;
  const input = body?.rows;
  if (!body || (type !== "payment" && type !== "verification") || !Array.isArray(input) ||
      input.length < 1 || input.length > 5000) {
    send(res, 400, { error: "INVALID_BATCH", details: "type must be payment or verification and rows must contain 1–5,000 items." });
    return true;
  }

  const seen = new Set<string>();
  const normalized = input.map((raw, index) => {
    const row = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as InputRow : {};
    const name = typeof row.beneficiaryName === "string" ? row.beneficiaryName.trim().slice(0, 120) : "";
    const account = typeof row.accountNumber === "string" ? row.accountNumber.trim() : "";
    const bank = typeof row.bankCode === "string" ? row.bankCode.trim() : "";
    const issues: string[] = [];
    if (!name) issues.push("MISSING_BENEFICIARY_NAME");
    if (!/^\d{10}$/.test(account)) issues.push("INVALID_ACCOUNT_NUMBER");
    if (!/^\d{3,10}$/.test(bank)) issues.push("INVALID_BANK_CODE");
    const duplicateKey = bank + ":" + account;
    if (/^\d{10}$/.test(account) && /^\d{3,10}$/.test(bank)) {
      if (seen.has(duplicateKey)) issues.push("DUPLICATE_BENEFICIARY");
      seen.add(duplicateKey);
    }
    let minor: string | null = null;
    if (type === "payment") {
      minor = amountMinor(row.amount);
      if (!minor) issues.push("INVALID_AMOUNT");
      if (row.currency !== undefined && row.currency !== "NGN") issues.push("UNSUPPORTED_CURRENCY");
    }
    return {
      rowNumber: index + 1, name: name || "Unknown beneficiary", account,
      bankCode: bank, issues, amountMinor: minor
    };
  });

  const invalid = normalized.filter((row) => row.issues.length > 0).length;
  const valid = normalized.length - invalid;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const prior = await client.query(
      "SELECT id, batch_type, row_count FROM fp_sandbox_batches WHERE user_id = $1 AND idempotency_key = $2",
      [userId, key]
    );
    if (prior.rows[0]) {
      if (prior.rows[0].batch_type !== type || Number(prior.rows[0].row_count) !== normalized.length) {
        await client.query("ROLLBACK"); send(res, 409, { error: "IDEMPOTENCY_KEY_CONFLICT" }); return true;
      }
      await client.query("COMMIT");
      send(res, 200, { mode: "sandbox", replayed: true, batchId: prior.rows[0].id, live_payments: "disabled" });
      return true;
    }
    const inserted = await client.query(
      `INSERT INTO fp_sandbox_batches(user_id, batch_type, status, row_count, valid_count, invalid_count, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [userId, type, type === "payment" ? "prepared" : (invalid ? "completed_with_errors" : "completed"),
       normalized.length, valid, invalid, key]
    );
    const batchId = inserted.rows[0].id;
    for (const row of normalized) {
      let status: string = row.issues.length ? "invalid" : "prepared";
      let code: string | null = row.issues.length ? row.issues.join(",") : null;
      let message: string | null = row.issues.length ? "Row failed server-side format validation." : null;
      if (type === "verification" && row.issues.length === 0) {
        // Fixed, public demo fixtures only. No bank or payment-provider request is made.
        status = row.account === "0000000001" ? "simulated_match" : "simulated_no_match";
        code = status === "simulated_match" ? "DEMO_FIXTURE_MATCH" : "DEMO_FIXTURE_NO_MATCH";
        message = status === "simulated_match"
          ? "Simulated demo fixture match. Not a bank-confirmed account name."
          : "No matching demo fixture. This is not a real bank verification result.";
      }
      await client.query(
        `INSERT INTO fp_sandbox_batch_rows
         (batch_id, row_number, beneficiary_name, account_number_masked, bank_code, amount_minor, currency, status, result_code, result_message)
         VALUES ($1,$2,$3,$4,$5,$6,'NGN',$7,$8,$9)`,
        [batchId, row.rowNumber, row.name, row.account.replace(/\d(?=\d{4})/g, "•"),
         row.bankCode, row.amountMinor, status, code, message]
      );
    }
    await client.query("COMMIT");
    send(res, 201, {
      mode: "sandbox", simulated: true, batchId, type, status: type === "payment" ? "prepared" : (invalid ? "completed_with_errors" : "completed"),
      rowCount: normalized.length, validCount: valid, invalidCount: invalid,
      verificationNotice: type === "verification" ? "DEMO FIXTURES ONLY — NO BANK WAS CONTACTED" : undefined,
      paymentNotice: type === "payment" ? "PREPARED ONLY — NO FUNDS MOVED AND NO PAYMENT WAS EXECUTED" : undefined,
      live_payments: "disabled"
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    send(res, 503, { error: error instanceof Error ? error.message : "BATCH_UNAVAILABLE" });
  } finally { client.release(); }
  return true;
}
