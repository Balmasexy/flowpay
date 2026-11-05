import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { afterEach, test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createDepositReceiptsHandler } from "../src/deposit-receipts.js";

const envKeys = ["R2_ENDPOINT", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_REGION"] as const;
const previous = new Map<string, string | undefined>(envKeys.map(key => [key, process.env[key]]));
afterEach(() => {
  for (const key of envKeys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setup(path: string, method = "GET", authorization?: string) {
  const req = Object.assign(Readable.from([]), {
    method,
    url: path,
    headers: authorization ? { authorization } : {}
  }) as unknown as IncomingMessage;
  let status = 0;
  let body = "";
  const res = {
    writeHead: (next: number) => { status = next; },
    end: (value?: string) => { body = value ?? ""; }
  } as unknown as ServerResponse;
  const pool = { query: async () => { throw new Error("Database must not be reached in this test"); } } as unknown as Pool;
  const handler = createDepositReceiptsHandler({
    pool,
    jwks: {} as never,
    issuer: "https://auth.example.test",
    audience: "flowpay-api"
  });
  return { req, res, handler, result: () => ({ status, body: body ? JSON.parse(body) as Record<string, unknown> : null }) };
}

test("unmatched requests are not consumed by the receipt handler", async () => {
  const context = setup("/health");
  assert.equal(await context.handler(context.req, context.res), false);
  assert.equal(context.result().status, 0);
});

test("receipt endpoints fail closed when private R2 storage is not configured", async () => {
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_BUCKET_NAME;
  const context = setup("/customer/deposit-receipts");
  assert.equal(await context.handler(context.req, context.res), true);
  assert.equal(context.result().status, 503);
  assert.equal(context.result().body?.error, "RECEIPT_STORAGE_NOT_CONFIGURED");
});

test("receipt endpoints require an HTTPS R2 endpoint and complete private credentials", async () => {
  process.env.R2_ENDPOINT = "http://storage.example.test";
  process.env.R2_BUCKET_NAME = "flowpay-private-receipts";
  process.env.R2_ACCESS_KEY_ID = "test-access";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  const context = setup("/customer/deposit-receipts");
  assert.equal(await context.handler(context.req, context.res), true);
  assert.equal(context.result().status, 503);
  assert.equal(context.result().body?.error, "RECEIPT_STORAGE_NOT_CONFIGURED");
});

test("configured receipt endpoints reject anonymous customers before database access", async () => {
  process.env.R2_ENDPOINT = "https://test-account.r2.cloudflarestorage.com";
  process.env.R2_BUCKET_NAME = "flowpay-private-receipts";
  process.env.R2_ACCESS_KEY_ID = "test-access";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  process.env.R2_REGION = "auto";
  const context = setup("/customer/deposit-receipts");
  assert.equal(await context.handler(context.req, context.res), true);
  assert.equal(context.result().status, 401);
  assert.equal(context.result().body?.error, "ACTIVE_CUSTOMER_REQUIRED");
});

test("admin receipt review endpoints reject anonymous requests", async () => {
  process.env.R2_ENDPOINT = "https://test-account.r2.cloudflarestorage.com";
  process.env.R2_BUCKET_NAME = "flowpay-private-receipts";
  process.env.R2_ACCESS_KEY_ID = "test-access";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  const context = setup("/admin/deposit-receipts");
  assert.equal(await context.handler(context.req, context.res), true);
  assert.equal(context.result().status, 401);
  assert.equal(context.result().body?.error, "ACTIVE_SUPER_ADMIN_REQUIRED");
});
