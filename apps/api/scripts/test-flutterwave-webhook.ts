import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { test, after } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createFlutterwaveWebhookHandler } from "../src/flutterwave-webhook.js";

const originalFetch = globalThis.fetch;
const originalEnv = {
  environment: process.env.FLW_ENVIRONMENT,
  secret: process.env.FLW_SECRET_KEY,
  hash: process.env.FLW_WEBHOOK_SECRET_HASH,
  runtime: process.env.FLOWPAY_RUNTIME_ENV,
  nodeEnv: process.env.NODE_ENV
};

function setup(options: {
  eventAmount?: number;
  verifiedAmount?: number;
  duplicate?: boolean;
  transactionStatus?: "pending" | "posted";
  providerStatus?: string;
  accountActive?: boolean;
  existingEntries?: number;
} = {}) {
  process.env.FLW_ENVIRONMENT = "test";
  process.env.FLW_SECRET_KEY = "FLWSECK_TEST-unit-test";
  process.env.FLW_WEBHOOK_SECRET_HASH = "unit-test-webhook-hash";
  process.env.FLOWPAY_RUNTIME_ENV = "development";
  process.env.NODE_ENV = "test";

  const transactionId = "00000000-0000-4000-8000-000000000001";
  const userId = "00000000-0000-4000-8000-000000000002";
  const customerAccountId = "00000000-0000-4000-8000-000000000003";
  const clearingAccountId = "00000000-0000-4000-8000-000000000004";
  const queries: string[] = [];
  let connections = 0;
  const payload = {
    event: "charge.completed",
    data: {
      id: 987654321,
      tx_ref: "flowpay-flw-test-ref",
      status: "successful",
      currency: "NGN",
      amount: options.eventAmount ?? 2500
    }
  };
  const rawPayload = Buffer.from(JSON.stringify(payload));
  const eventHash = createHash("sha256").update(rawPayload).digest("hex");
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("SELECT transaction_id,user_id,account_id,provider_tx_ref")) {
        return { rowCount: 1, rows: [{
          transaction_id: transactionId,
          user_id: userId,
          account_id: customerAccountId,
          provider_tx_ref: "flowpay-flw-test-ref",
          provider_transaction_id: options.transactionStatus === "posted" ? "987654321" : null,
          amount_minor: "250000",
          currency: "NGN",
          status: options.transactionStatus ?? "pending"
        }] };
      }
      if (sql.includes("INSERT INTO public.fp_payment_events")) {
        return options.duplicate
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ provider_event_id: "987654321" }] };
      }
      if (sql.includes("SELECT transaction_id::text,payload_sha256")) {
        return { rowCount: 1, rows: [{ transaction_id: transactionId, payload_sha256: eventHash }] };
      }
      if (sql.includes("SELECT status FROM public.fp_ledger_transactions")) {
        return { rowCount: 1, rows: [{ status: options.transactionStatus ?? "pending" }] };
      }
      if (sql.includes("system_account_role='flutterwave_ngn_clearing'")) {
        return { rowCount: 1, rows: [{ id: clearingAccountId }] };
      }
      if (sql.includes("WHERE id=$1 AND user_id=$2") && sql.includes("account_type='customer'")) {
        return { rowCount: options.accountActive === false ? 0 : 1, rows: [{ id: customerAccountId }] };
      }
      if (sql.includes("SELECT COUNT(*)::int AS count")) {
        return { rowCount: 1, rows: [{ count: options.existingEntries ?? (options.transactionStatus === "posted" ? 2 : 0) }] };
      }
      if (sql.includes("SELECT account_id::text AS account_id")) {
        return { rowCount: 2, rows: [
          { account_id: customerAccountId, amount_minor: "250000", entry_count: 1 },
          { account_id: clearingAccountId, amount_minor: "-250000", entry_count: 1 }
        ] };
      }
      if (sql.includes("SELECT id FROM public.fp_accounts") && sql.includes("account_type='customer'")) {
        return { rowCount: options.accountActive === false ? 0 : 1, rows: [{ id: customerAccountId }] };
      }
      if (sql.includes("SELECT COUNT(*)::int AS count")) {
        return { rowCount: 1, rows: [{ count: options.existingEntries ?? 0 }] };
      }
      if (sql.includes("SELECT id FROM public.fp_accounts")) {
        return { rowCount: 1, rows: [{ id: clearingAccountId }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release: () => undefined
  };
  const pool = { connect: async () => { connections++; return client; } } as unknown as Pool;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: "success",
    data: {
      id: "987654321",
      tx_ref: "flowpay-flw-test-ref",
      status: options.providerStatus ?? "successful",
      currency: "NGN",
      amount: options.verifiedAmount ?? 2500
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
  const request = (hash = "unit-test-webhook-hash") => Object.assign(
    Readable.from([rawPayload]),
    { method: "POST", url: "/webhooks/flutterwave", headers: { "verif-hash": hash } }
  ) as unknown as IncomingMessage;
  const response = () => {
    let statusCode = 0;
    let body = "";
    const res = {
      writeHead: (status: number) => { statusCode = status; },
      end: (value?: string) => { body = value ?? ""; }
    } as unknown as ServerResponse;
    return { res, result: () => ({ statusCode, body: body ? JSON.parse(body) : null }) };
  };
  return { pool, queries, request, response, getConnections: () => connections, ids:{transactionId,customerAccountId,clearingAccountId} };
}

test("verified Flutterwave NGN deposit posts one balanced customer/clearing ledger transaction", async () => {
  const ctx = setup();
  const res = ctx.response();
  await createFlutterwaveWebhookHandler({ pool: ctx.pool })(ctx.request(), res.res);
  const result = res.result();
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.providerVerified, true);
  assert.equal(result.body.status, "posted");
  assert.equal(result.body.walletCredited, true);
  assert.ok(ctx.queries.some(query => query.includes("INSERT INTO public.fp_ledger_entries")));
  assert.ok(ctx.queries.some(query => query.includes("UPDATE public.fp_ledger_transactions")));
  assert.ok(ctx.queries.some(query => query.includes("UPDATE public.fp_flutterwave_deposits")));
  assert.ok(ctx.queries.some(query => query.includes("UPDATE public.fp_payment_events")));
});

test("rejects an invalid webhook hash before provider verification or database access", async () => {
  const ctx = setup();
  const res = ctx.response();
  await createFlutterwaveWebhookHandler({ pool: ctx.pool })(ctx.request("wrong-hash"), res.res);
  assert.equal(res.result().statusCode, 401);
  assert.equal(ctx.getConnections(), 0);
});

test("rejects a provider amount mismatch before database access", async () => {
  const ctx = setup({ eventAmount:2500, verifiedAmount:2499 });
  const res = ctx.response();
  await createFlutterwaveWebhookHandler({ pool: ctx.pool })(ctx.request(), res.res);
  assert.equal(res.result().statusCode, 202);
  assert.equal(res.result().body.reason, "PROVIDER_EVENT_MISMATCH");
  assert.equal(ctx.getConnections(), 0);
});

test("acknowledges a duplicate webhook after confirming the ledger is already balanced", async () => {
  const ctx = setup({ duplicate:true, transactionStatus:"posted" });
  const res = ctx.response();
  await createFlutterwaveWebhookHandler({ pool: ctx.pool })(ctx.request(), res.res);
  assert.equal(res.result().statusCode, 200);
  assert.equal(res.result().body.duplicate, true);
  assert.equal(res.result().body.walletCredited, true);
  assert.equal(ctx.queries.some(query => query.includes("INSERT INTO public.fp_ledger_entries")), false);
});

test("rejects an inactive customer wallet without posting ledger entries", async () => {
  const ctx = setup({ accountActive:false });
  const res = ctx.response();
  await createFlutterwaveWebhookHandler({ pool: ctx.pool })(ctx.request(), res.res);
  assert.equal(res.result().statusCode, 503);
  assert.ok(ctx.queries.some(query => query.includes("SELECT id FROM public.fp_accounts") && query.includes("account_type='customer'")));
  assert.equal(ctx.queries.some(query => query.includes("INSERT INTO public.fp_ledger_entries")), false);
});

test("does not post when pending transaction already has ledger entries", async () => {
  const ctx = setup({ existingEntries:1 });
  const res = ctx.response();
  await createFlutterwaveWebhookHandler({ pool: ctx.pool })(ctx.request(), res.res);
  assert.equal(res.result().statusCode, 503);
  assert.equal(ctx.queries.some(query => query.includes("INSERT INTO public.fp_ledger_entries")), false);
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv.environment === undefined) delete process.env.FLW_ENVIRONMENT; else process.env.FLW_ENVIRONMENT = originalEnv.environment;
  if (originalEnv.secret === undefined) delete process.env.FLW_SECRET_KEY; else process.env.FLW_SECRET_KEY = originalEnv.secret;
  if (originalEnv.hash === undefined) delete process.env.FLW_WEBHOOK_SECRET_HASH; else process.env.FLW_WEBHOOK_SECRET_HASH = originalEnv.hash;
  if (originalEnv.runtime === undefined) delete process.env.FLOWPAY_RUNTIME_ENV; else process.env.FLOWPAY_RUNTIME_ENV = originalEnv.runtime;
  if (originalEnv.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalEnv.nodeEnv;
});
