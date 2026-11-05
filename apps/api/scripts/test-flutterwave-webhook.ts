import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createFlutterwaveWebhookHandler } from "../src/flutterwave-webhook.js";

const originalFetch = globalThis.fetch;
const originalEnv = {
  environment: process.env.FLW_ENVIRONMENT,
  secret: process.env.FLW_SECRET_KEY,
  hash: process.env.FLW_WEBHOOK_SECRET_HASH
};

function setup(options: { eventAmount?: number; verifiedAmount?: number; duplicate?: boolean; verifiedId?: string | number } = {}) {
  process.env.FLW_ENVIRONMENT = "test";
  process.env.FLW_SECRET_KEY = "FLWSECK_TEST-unit-test";
  process.env.FLW_WEBHOOK_SECRET_HASH = "unit-test-webhook-hash";
  let connectCount = 0;
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("SELECT transaction_id, provider_tx_ref")) {
        return { rowCount: 1, rows: [{
          transaction_id: "00000000-0000-4000-8000-000000000001",
          provider_tx_ref: "flowpay-flw-test-ref",
          provider_transaction_id: null,
          amount_minor: "250000",
          currency: "NGN",
          status: "pending"
        }] };
      }
      if (sql.includes("INSERT INTO public.fp_payment_events")) {
        return { rowCount: options.duplicate ? 0 : 1, rows: options.duplicate ? [] : [{ provider_event_id: "987654321" }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release: () => undefined
  };
  const pool = {
    connect: async () => { connectCount++; return client; }
  } as unknown as Pool;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: "success",
    data: {
      id: options.verifiedId ?? "987654321",
      tx_ref: "flowpay-flw-test-ref",
      status: "successful",
      currency: "NGN",
      amount: options.verifiedAmount ?? 2500
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
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
  const request = (hash = "unit-test-webhook-hash") => Object.assign(
    Readable.from([Buffer.from(JSON.stringify(payload))]),
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
  return { pool, queries, request, response, getConnectCount: () => connectCount };
}

test("accepts a numeric-string verification ID and records verification without crediting", async () => {
  const ctx = setup({ verifiedId: "987654321" });
  const res = ctx.response();
  await createFlutterwaveWebhookHandler({ pool: ctx.pool })(ctx.request(), res.res);
  const result = res.result();
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.providerVerified, true);
  assert.equal(result.body.walletCredited, false);
  assert.ok(ctx.queries.some(query => query.includes("INSERT INTO public.fp_payment_events")));
});

test("rejects an invalid webhook hash before provider verification or database access", async () => {
  const ctx = setup();
  const res = ctx.response();
  await createFlutterwaveWebhookHandler({ pool: ctx.pool })(ctx.request("wrong-hash"), res.res);
  assert.equal(res.result().statusCode, 401);
  assert.equal(ctx.getConnectCount(), 0);
});

test("rejects a provider amount mismatch before opening a database transaction", async () => {
  const ctx = setup({ eventAmount: 2500, verifiedAmount: 2499 });
  const res = ctx.response();
  await createFlutterwaveWebhookHandler({ pool: ctx.pool })(ctx.request(), res.res);
  assert.equal(res.result().statusCode, 202);
  assert.equal(res.result().body.reason, "PROVIDER_EVENT_MISMATCH");
  assert.equal(ctx.getConnectCount(), 0);
});

test("acknowledges a duplicate provider transaction event without a second write", async () => {
  const ctx = setup({ duplicate: true });
  const res = ctx.response();
  await createFlutterwaveWebhookHandler({ pool: ctx.pool })(ctx.request(), res.res);
  assert.equal(res.result().statusCode, 200);
  assert.equal(res.result().body.duplicate, true);
  assert.equal(res.result().body.walletCredited, false);
  assert.equal(ctx.queries.some(query => query.includes("UPDATE public.fp_flutterwave_deposits")), false);
});

process.on("exit", () => {
  globalThis.fetch = originalFetch;
  if (originalEnv.environment === undefined) delete process.env.FLW_ENVIRONMENT; else process.env.FLW_ENVIRONMENT = originalEnv.environment;
  if (originalEnv.secret === undefined) delete process.env.FLW_SECRET_KEY; else process.env.FLW_SECRET_KEY = originalEnv.secret;
  if (originalEnv.hash === undefined) delete process.env.FLW_WEBHOOK_SECRET_HASH; else process.env.FLW_WEBHOOK_SECRET_HASH = originalEnv.hash;
});
