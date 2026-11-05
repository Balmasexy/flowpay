import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createPaystackWebhookHandler } from "../src/paystack-webhook.js";

const originalFetch = globalThis.fetch;
const originalEnvironment = {
  environment: process.env.PAYSTACK_ENVIRONMENT,
  secret: process.env.PAYSTACK_SECRET_KEY
};

function setup(options: {
  duplicate?: boolean;
  amount?: number;
  verifiedAmount?: number;
  domain?: string;
  transactionStatus?: "pending" | "posted";
} = {}) {
  process.env.PAYSTACK_ENVIRONMENT = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_unit_test_secret";
  const queries: string[] = [];
  let connections = 0;
  let rawPayload = Buffer.from(JSON.stringify({
    event: "charge.success",
    data: {
      id: 123456789,
      reference: "flowpay-ps-00000000000000000000000000000001",
      status: "success",
      amount: options.amount ?? 250000,
      currency: "NGN"
    }
  }));
  const digest = createHash("sha256").update(rawPayload).digest("hex");
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("SELECT transaction_id, user_id, account_id, reference")) {
        return { rowCount: 1, rows: [{
          transaction_id: "00000000-0000-4000-8000-000000000001",
          user_id: "00000000-0000-4000-8000-000000000002",
          account_id: "00000000-0000-4000-8000-000000000003",
          reference: "flowpay-ps-00000000000000000000000000000001",
          provider_transaction_id: null,
          amount_minor: "250000",
          currency: "NGN",
          status: "pending"
        }] };
      }
      if (sql.includes("INSERT INTO public.fp_payment_events")) {
        return options.duplicate
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ provider_event_id: "reference" }] };
      }
      if (sql.includes("SELECT transaction_id::text, payload_sha256")) {
        return { rowCount: 1, rows: [{
          transaction_id: "00000000-0000-4000-8000-000000000001",
          payload_sha256: digest
        }] };
      }
      if (sql.includes("SELECT status FROM public.fp_ledger_transactions")) {
        return { rowCount: 1, rows: [{ status: options.transactionStatus ?? "pending" }] };
      }
      if (sql.includes("SELECT id FROM public.fp_accounts")) {
        return { rowCount: 1, rows: [{ id: "00000000-0000-4000-8000-000000000004" }] };
      }
      if (sql.includes("SELECT account_id::text AS account_id, SUM(amount_minor)")) {
        return { rowCount: options.transactionStatus === "posted" ? 2 : 0, rows: [
          { account_id: "00000000-0000-4000-8000-000000000003", amount_minor: "250000", entry_count: 1 },
          { account_id: "00000000-0000-4000-8000-000000000004", amount_minor: "-250000", entry_count: 1 }
        ] };
      }
      if (sql.includes("SELECT COUNT(*)::int AS entry_count")) {
        return { rowCount: 1, rows: [{ entry_count: 0 }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release: () => undefined
  };
  const pool = { connect: async () => { connections += 1; return client; } } as unknown as Pool;

  globalThis.fetch = async () => new Response(JSON.stringify({
    status: true,
    data: {
      id: 123456789,
      domain: options.domain ?? "test",
      status: "success",
      reference: "flowpay-ps-00000000000000000000000000000001",
      amount: options.verifiedAmount ?? 250000,
      currency: "NGN"
    }
  }), { status: 200 });

  const request = (signature?: string) => Object.assign(Readable.from([rawPayload]), {
    method: "POST",
    url: "/webhooks/paystack",
    headers: {
      "x-paystack-signature": signature ?? createHmac("sha512", process.env.PAYSTACK_SECRET_KEY!)
        .update(rawPayload).digest("hex")
    }
  }) as unknown as IncomingMessage;

  const response = () => {
    let status = 0;
    let body = "";
    const res = {
      writeHead: (value: number) => { status = value; },
      end: (value?: string) => { body = value ?? ""; }
    } as unknown as ServerResponse;
    return { res, result: () => ({ status, body: body ? JSON.parse(body) : null }) };
  };
  return { pool, queries, request, response, connections: () => connections };
}

test("valid Paystack test charge posts one balanced customer/clearing ledger transaction", async () => {
  const context = setup();
  const response = context.response();
  await createPaystackWebhookHandler({ pool: context.pool })(context.request(), response.res);
  assert.equal(response.result().status, 200);
  assert.equal(response.result().body.providerVerified, true);
  assert.equal(response.result().body.status, "posted");
  assert.equal(response.result().body.walletCredited, true);
  assert.ok(context.queries.some(query => query.includes("INSERT INTO public.fp_ledger_entries")));
  assert.ok(context.queries.some(query => query.includes("UPDATE public.fp_ledger_transactions")));
  assert.ok(context.queries.some(query => query.includes("UPDATE public.fp_paystack_deposits")));
});

test("invalid signature is rejected before provider verification or database access", async () => {
  const context = setup();
  const response = context.response();
  await createPaystackWebhookHandler({ pool: context.pool })(context.request("bad"), response.res);
  assert.equal(response.result().status, 401);
  assert.equal(context.connections(), 0);
});

test("amount mismatch is rejected before database access", async () => {
  const context = setup({ amount: 250000, verifiedAmount: 249999 });
  const response = context.response();
  await createPaystackWebhookHandler({ pool: context.pool })(context.request(), response.res);
  assert.equal(response.result().status, 202);
  assert.equal(response.result().body.reason, "PROVIDER_EVENT_MISMATCH");
  assert.equal(context.connections(), 0);
});

test("non-test provider transactions are rejected before database access", async () => {
  const context = setup({ domain: "live" });
  const response = context.response();
  await createPaystackWebhookHandler({ pool: context.pool })(context.request(), response.res);
  assert.equal(response.result().status, 202);
  assert.equal(context.connections(), 0);
});

test("a duplicate receipt can resume a verified deposit that was not yet posted", async () => {
  const context = setup({ duplicate: true, transactionStatus: "pending" });
  const response = context.response();
  await createPaystackWebhookHandler({ pool: context.pool })(context.request(), response.res);
  assert.equal(response.result().status, 200);
  assert.equal(response.result().body.walletCredited, true);
  assert.ok(context.queries.some(query => query.includes("INSERT INTO public.fp_ledger_entries")));
});

test("a previously posted duplicate is acknowledged without a second ledger posting", async () => {
  const context = setup({ duplicate: true, transactionStatus: "posted" });
  const response = context.response();
  await createPaystackWebhookHandler({ pool: context.pool })(context.request(), response.res);
  assert.equal(response.result().status, 200);
  assert.equal(response.result().body.duplicate, true);
  assert.equal(response.result().body.walletCredited, true);
  assert.equal(context.queries.some(query => query.includes("INSERT INTO public.fp_ledger_entries")), false);
});

process.on("exit", () => {
  globalThis.fetch = originalFetch;
  if (originalEnvironment.environment === undefined) delete process.env.PAYSTACK_ENVIRONMENT;
  else process.env.PAYSTACK_ENVIRONMENT = originalEnvironment.environment;
  if (originalEnvironment.secret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
  else process.env.PAYSTACK_SECRET_KEY = originalEnvironment.secret;
});
