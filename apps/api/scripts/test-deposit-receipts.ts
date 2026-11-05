import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createLocalJWKSet, SignJWT } from "jose";
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


const testUserId = "00000000-0000-4000-8000-000000000101";
const keyPair = generateKeyPairSync("ed25519");
const publicJwk = keyPair.publicKey.export({ format: "jwk" });
const localJwks = createLocalJWKSet({
  keys: [{ ...publicJwk, kid: "flowpay-receipt-test", alg: "EdDSA", use: "sig" }]
});
const TEST_ISSUER = "https://flowpay.test";
const TEST_AUDIENCE = "flowpay-api";

async function signedCustomerToken(): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: "flowpay-receipt-test" })
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_AUDIENCE)
    .setSubject("flowpay-receipt-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keyPair.privateKey);
}

function configuredStorage() {
  process.env.R2_ENDPOINT = "https://test-account.r2.cloudflarestorage.com";
  process.env.R2_BUCKET_NAME = "flowpay-private-receipts";
  process.env.R2_ACCESS_KEY_ID = "test-access-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
  process.env.R2_REGION = "auto";
}

function responseRecorder() {
  let status = 0;
  let body = "";
  const res = {
    writeHead: (value: number) => { status = value; },
    end: (value?: string) => { body = value ?? ""; }
  } as unknown as ServerResponse;
  return {
    res,
    result: () => ({
      status,
      body: body ? JSON.parse(body) as Record<string, unknown> : null
    })
  };
}

function authenticatedRequest(method: string, url: string, token: string, payload?: Record<string, unknown>) {
  const chunks = payload ? [Buffer.from(JSON.stringify(payload))] : [];
  return Object.assign(Readable.from(chunks), {
    method,
    url,
    headers: { authorization: "Bearer " + token }
  }) as unknown as IncomingMessage;
}


test("valid customer receives a short-lived, content-type-bound private R2 upload URL", async () => {
  configuredStorage();
  const token = await signedCustomerToken();
  const queries: string[] = [];
  const createdReceiptId = "00000000-0000-4000-8000-000000000102";
  const objectKey = "receipts/" + testUserId + "/" + createdReceiptId + ".png";
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM neon_auth."user"')) {
        return { rowCount: 1, rows: [{ id: testUserId, role: "customer" }] };
      }
      if (sql.includes("SELECT COUNT(*)::int AS count FROM public.fp_deposit_receipts")) {
        return { rowCount: 1, rows: [{ count: 0 }] };
      }
      if (sql.includes("INSERT INTO public.fp_deposit_receipts")) {
        return {
          rowCount: 1,
          rows: [{
            id: createdReceiptId, user_id: testUserId, amount_minor: "500000",
            currency: "NGN", reference_text: "bank-ref-12345", customer_note: null,
            object_key: objectKey, file_name: "bank-receipt.png",
            content_type: "image/png", size_bytes: 1024, status: "pending_upload",
            created_at: new Date(), reviewed_at: null, review_note: null,
            review_bank_reference: null, ledger_transaction_id: null
          }]
        };
      }
      if (sql.includes("INSERT INTO public.fp_deposit_receipt_audit_events")) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error("Unexpected receipt SQL: " + sql);
    }
  } as unknown as Pool;
  const handler = createDepositReceiptsHandler({
    pool, jwks: localJwks, issuer: TEST_ISSUER, audience: TEST_AUDIENCE
  });
  const recorder = responseRecorder();
  await handler(authenticatedRequest("POST", "/customer/deposit-receipts", token, {
    clientRequestId: "00000000-0000-4000-8000-000000000103",
    amountMinor: "500000",
    reference: "bank-ref-12345",
    note: "Test transfer evidence",
    fileName: "bank-receipt.png",
    contentType: "image/png",
    sizeBytes: 1024
  }), recorder.res);

  const result = recorder.result();
  assert.equal(result.status, 201);
  assert.equal(result.body?.status, "pending_upload");
  assert.equal(result.body?.uploadMethod, "PUT");
  const uploadUrl = new URL(String(result.body?.uploadUrl));
  assert.equal(uploadUrl.protocol, "https:");
  assert.equal(uploadUrl.hostname, "test-account.r2.cloudflarestorage.com");
  assert.equal(uploadUrl.pathname, "/" + process.env.R2_BUCKET_NAME + "/" + objectKey);
  assert.equal(uploadUrl.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(uploadUrl.searchParams.get("X-Amz-Expires"), "300");
  assert.equal(uploadUrl.searchParams.get("X-Amz-SignedHeaders"), "content-type;host");
  assert.match(uploadUrl.searchParams.get("X-Amz-Signature") ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(result.body?.uploadHeaders, { "Content-Type": "image/png" });
  assert.ok(queries.some(sql => sql.includes("INSERT INTO public.fp_deposit_receipts")));
});

test("customer submission rejects unsafe file types and oversized objects before creating a receipt", async () => {
  configuredStorage();
  const token = await signedCustomerToken();
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM neon_auth."user"')) return { rowCount: 1, rows: [{ id: testUserId, role: "customer" }] };
      throw new Error("Unexpected SQL: " + sql);
    }
  } as unknown as Pool;
  const handler = createDepositReceiptsHandler({
    pool, jwks: localJwks, issuer: TEST_ISSUER, audience: TEST_AUDIENCE
  });
  const recorder = responseRecorder();
  await handler(authenticatedRequest("POST", "/customer/deposit-receipts", token, {
    clientRequestId: "00000000-0000-4000-8000-000000000104",
    amountMinor: "500000",
    fileName: "receipt.exe",
    contentType: "application/x-msdownload",
    sizeBytes: 20
  }), recorder.res);
  assert.equal(recorder.result().status, 400);
  assert.equal(recorder.result().body?.error, "INVALID_RECEIPT_FILE");
  assert.equal(queries.some(sql => sql.includes("INSERT INTO public.fp_deposit_receipts")), false);
});

test("valid customer token cannot access the Super Admin receipt queue", async () => {
  configuredStorage();
  const token = await signedCustomerToken();
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rowCount: 0, rows: [] };
    }
  } as unknown as Pool;
  const handler = createDepositReceiptsHandler({
    pool, jwks: localJwks, issuer: TEST_ISSUER, audience: TEST_AUDIENCE
  });
  const recorder = responseRecorder();
  await handler(authenticatedRequest("GET", "/admin/deposit-receipts", token), recorder.res);
  assert.equal(recorder.result().status, 403);
  assert.equal(recorder.result().body?.error, "ACTIVE_SUPER_ADMIN_REQUIRED");
  assert.equal(queries.length, 1);
});
