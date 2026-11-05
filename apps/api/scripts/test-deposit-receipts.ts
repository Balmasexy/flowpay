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

async function signedSuperAdminToken(): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: "flowpay-receipt-test" })
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_AUDIENCE)
    .setSubject("flowpay-super-admin-subject")
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


test("valid customer receives a private FlowPay upload path without exposing R2 credentials or URLs", async () => {
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
            content_type: "image/png", size_bytes: 8, status: "pending_upload",
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
    sizeBytes: 8
  }), recorder.res);

  const result = recorder.result();
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body?.status, "pending_upload");
  assert.equal(result.body?.uploadMethod, "PUT");
  assert.equal(result.body?.uploadPath, "/customer/deposit-receipts/" + createdReceiptId + "/file");
  assert.equal(result.body?.uploadUrl, undefined);
  assert.equal(result.body?.maxBytes, 5 * 1024 * 1024);
  assert.ok(queries.some(sql => sql.includes("INSERT INTO public.fp_deposit_receipts")));
});

test("valid customer uploads bytes through FlowPay API and the API forwards the signed request to private R2", async () => {
  configuredStorage();
  const token = await signedCustomerToken();
  const receiptId = "00000000-0000-4000-8000-000000000105";
  const objectKey = "receipts/" + testUserId + "/" + receiptId + ".png";
  const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const queries: string[] = [];
  const clientQueries: string[] = [];
  const client = {
    query: async (sql: string) => {
      clientQueries.push(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes("UPDATE public.fp_deposit_receipts")) return { rowCount: 1, rows: [{ id: receiptId }] };
      if (sql.includes("INSERT INTO public.fp_deposit_receipt_audit_events")) return { rowCount: 1, rows: [] };
      throw new Error("Unexpected client SQL: " + sql);
    },
    release: () => undefined
  };
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM neon_auth."user"')) return { rowCount: 1, rows: [{ id: testUserId, role: "customer" }] };
      if (sql.includes("FROM public.fp_deposit_receipts WHERE id=$1 AND user_id=$2")) {
        return {
          rowCount: 1,
          rows: [{
            id: receiptId, user_id: testUserId, amount_minor: "500000", currency: "NGN",
            reference_text: null, customer_note: null, object_key: objectKey,
            file_name: "bank-receipt.png", content_type: "image/png", size_bytes: 8,
            status: "pending_upload", created_at: new Date(), reviewed_at: null,
            review_note: null, review_bank_reference: null, ledger_transaction_id: null
          }]
        };
      }
      throw new Error("Unexpected pool SQL: " + sql);
    },
    connect: async () => client
  } as unknown as Pool;
  const originalFetch = globalThis.fetch;
  let forwardedUrl = "";
  let forwardedMethod = "";
  let forwardedType = "";
  let forwardedSize = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    forwardedUrl = String(input);
    forwardedMethod = init?.method ?? "GET";
    forwardedType = new Headers(init?.headers).get("Content-Type") ?? "";
    forwardedSize = init?.body instanceof Uint8Array ? init.body.byteLength : 0;
    return new Response(null, { status: 200 });
  };
  try {
    const handler = createDepositReceiptsHandler({
      pool, jwks: localJwks, issuer: TEST_ISSUER, audience: TEST_AUDIENCE
    });
    const req = Object.assign(Readable.from([pngBytes]), {
      method: "PUT",
      url: "/customer/deposit-receipts/" + receiptId + "/file",
      headers: { authorization: "Bearer " + token, "content-type": "image/png" }
    }) as unknown as IncomingMessage;
    const recorder = responseRecorder();
    await handler(req, recorder.res);

    assert.equal(recorder.result().status, 200, JSON.stringify(recorder.result().body));
    assert.equal(recorder.result().body?.status, "pending_review");
    assert.equal(forwardedMethod, "PUT");
    assert.equal(forwardedType, "image/png");
    assert.equal(forwardedSize, pngBytes.length);
    const r2Url = new URL(forwardedUrl);
    assert.equal(r2Url.hostname, "test-account.r2.cloudflarestorage.com");
    assert.equal(r2Url.pathname, "/" + process.env.R2_BUCKET_NAME + "/" + objectKey);
    assert.equal(r2Url.searchParams.get("X-Amz-Expires"), "120");
    assert.match(r2Url.searchParams.get("X-Amz-Signature") ?? "", /^[0-9a-f]{64}$/);
    assert.ok(queries.some(sql => sql.includes("FROM public.fp_deposit_receipts WHERE id=$1 AND user_id=$2")));
    assert.ok(clientQueries.some(sql => sql.includes("UPDATE public.fp_deposit_receipts")));
    assert.ok(clientQueries.some(sql => sql.includes("INSERT INTO public.fp_deposit_receipt_audit_events")));
  } finally {
    globalThis.fetch = originalFetch;
  }
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


test("Super Admin approval posts one balanced and audited ledger credit only after funds attestation", async () => {
  configuredStorage();
  const token = await signedSuperAdminToken();
  const receiptId = "00000000-0000-4000-8000-000000000201";
  const customerId = "00000000-0000-4000-8000-000000000202";
  const transactionId = "00000000-0000-4000-8000-000000000203";
  const walletId = "00000000-0000-4000-8000-000000000204";
  const clearingId = "00000000-0000-4000-8000-000000000205";
  const clientQueries: string[] = [];
  const ledgerEntries: unknown[][] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      clientQueries.push(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes("FROM public.fp_deposit_receipts WHERE id=$1 FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [{
            id: receiptId, user_id: customerId, amount_minor: "125000",
            currency: "NGN", reference_text: "bank-ref-1250", customer_note: null,
            object_key: "receipts/" + customerId + "/" + receiptId + ".png",
            file_name: "bank-receipt.png", content_type: "image/png", size_bytes: 8,
            status: "pending_review", created_at: new Date(), reviewed_at: null,
            review_note: null, review_bank_reference: null, ledger_transaction_id: null
          }]
        };
      }
      if (sql.includes("SELECT id FROM public.fp_accounts") && sql.includes("account_type='customer'")) {
        return { rowCount: 1, rows: [{ id: walletId }] };
      }
      if (sql.includes("SELECT id FROM public.fp_accounts") && sql.includes("manual_receipt_ngn_clearing")) {
        return { rowCount: 1, rows: [{ id: clearingId }] };
      }
      if (sql.includes("INSERT INTO public.fp_ledger_transactions")) {
        return { rowCount: 1, rows: [{ id: transactionId }] };
      }
      if (sql.includes("SELECT COUNT(*)::int AS count FROM public.fp_ledger_entries")) {
        return { rowCount: 1, rows: [{ count: 0 }] };
      }
      if (sql.includes("INSERT INTO public.fp_ledger_entries")) {
        ledgerEntries.push(values ?? []);
        return { rowCount: 2, rows: [] };
      }
      if (sql.includes("UPDATE public.fp_ledger_transactions")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE public.fp_deposit_receipts")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO public.fp_deposit_receipt_audit_events")) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error("Unexpected review SQL: " + sql);
    },
    release: () => undefined
  };
  const authQueries: string[] = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      authQueries.push(sql);
      if (sql.includes('FROM neon_auth."user"')) {
        assert.deepEqual(values, ["flowpay-super-admin-subject"]);
        assert.ok(sql.includes("app_user.role = 'super_admin'"));
        return { rowCount: 1, rows: [{ id: testUserId, role: "super_admin" }] };
      }
      throw new Error("Unexpected pool SQL: " + sql);
    },
    connect: async () => client
  } as unknown as Pool;
  const handler = createDepositReceiptsHandler({
    pool, jwks: localJwks, issuer: TEST_ISSUER, audience: TEST_AUDIENCE
  });
  const recorder = responseRecorder();
  await handler(authenticatedRequest("POST", "/admin/deposit-receipts/" + receiptId + "/review", token, {
    decision: "approve",
    reviewNote: "Matched receiving bank statement and confirmed funds.",
    bankTransactionReference: "BANK-SETTLEMENT-REF-1250",
    fundsVerified: true
  }), recorder.res);

  assert.equal(recorder.result().status, 200, JSON.stringify(recorder.result().body));
  assert.equal(recorder.result().body?.status, "approved");
  assert.equal(recorder.result().body?.walletCredited, true);
  assert.equal(recorder.result().body?.transactionId, transactionId);
  assert.equal(ledgerEntries.length, 1);
  assert.deepEqual(ledgerEntries[0], [transactionId, walletId, "125000", clearingId, "-125000"]);
  assert.ok(clientQueries.some(sql => sql.includes("INSERT INTO public.fp_ledger_transactions")));
  assert.ok(clientQueries.some(sql => sql.includes("INSERT INTO public.fp_ledger_entries")));
  assert.ok(clientQueries.some(sql => sql.includes("INSERT INTO public.fp_deposit_receipt_audit_events")));
});

test("Super Admin rejection audits the decision and never writes ledger entries", async () => {
  configuredStorage();
  const token = await signedSuperAdminToken();
  const receiptId = "00000000-0000-4000-8000-000000000211";
  const customerId = "00000000-0000-4000-8000-000000000212";
  const clientQueries: string[] = [];
  const client = {
    query: async (sql: string) => {
      clientQueries.push(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes("FROM public.fp_deposit_receipts WHERE id=$1 FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [{
            id: receiptId, user_id: customerId, amount_minor: "125000",
            currency: "NGN", reference_text: "bank-ref-1250", customer_note: null,
            object_key: "receipts/" + customerId + "/" + receiptId + ".png",
            file_name: "bank-receipt.png", content_type: "image/png", size_bytes: 8,
            status: "pending_review", created_at: new Date(), reviewed_at: null,
            review_note: null, review_bank_reference: null, ledger_transaction_id: null
          }]
        };
      }
      if (sql.includes("UPDATE public.fp_deposit_receipts")) return { rowCount: 1, rows: [] };
      if (sql.includes("INSERT INTO public.fp_deposit_receipt_audit_events")) return { rowCount: 1, rows: [] };
      throw new Error("Unexpected rejection SQL: " + sql);
    },
    release: () => undefined
  };
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('FROM neon_auth."user"')) return { rowCount: 1, rows: [{ id: testUserId, role: "super_admin" }] };
      throw new Error("Unexpected pool SQL: " + sql);
    },
    connect: async () => client
  } as unknown as Pool;
  const handler = createDepositReceiptsHandler({
    pool, jwks: localJwks, issuer: TEST_ISSUER, audience: TEST_AUDIENCE
  });
  const recorder = responseRecorder();
  await handler(authenticatedRequest("POST", "/admin/deposit-receipts/" + receiptId + "/review", token, {
    decision: "reject",
    reviewNote: "Statement does not show the submitted transfer."
  }), recorder.res);

  assert.equal(recorder.result().status, 200, JSON.stringify(recorder.result().body));
  assert.equal(recorder.result().body?.status, "rejected");
  assert.equal(recorder.result().body?.walletCredited, false);
  assert.equal(clientQueries.some(sql => sql.includes("INSERT INTO public.fp_ledger_transactions")), false);
  assert.equal(clientQueries.some(sql => sql.includes("INSERT INTO public.fp_ledger_entries")), false);
  assert.ok(clientQueries.some(sql => sql.includes("INSERT INTO public.fp_deposit_receipt_audit_events")));
});

test("Super Admin cannot approve without independently confirmed funds and a bank reference", async () => {
  configuredStorage();
  const token = await signedSuperAdminToken();
  let databaseConnections = 0;
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('FROM neon_auth."user"')) return { rowCount: 1, rows: [{ id: testUserId, role: "super_admin" }] };
      throw new Error("Unexpected pool SQL: " + sql);
    },
    connect: async () => {
      databaseConnections += 1;
      throw new Error("Should not connect before approval validation");
    }
  } as unknown as Pool;
  const handler = createDepositReceiptsHandler({
    pool, jwks: localJwks, issuer: TEST_ISSUER, audience: TEST_AUDIENCE
  });
  const recorder = responseRecorder();
  await handler(authenticatedRequest("POST", "/admin/deposit-receipts/00000000-0000-4000-8000-000000000221/review", token, {
    decision: "approve",
    reviewNote: "I looked at the receipt.",
    bankTransactionReference: "BANK-REF-12345",
    fundsVerified: false
  }), recorder.res);
  assert.equal(recorder.result().status, 400);
  assert.equal(recorder.result().body?.error, "INDEPENDENT_FUNDS_VERIFICATION_REQUIRED");
  assert.equal(databaseConnections, 0);
});
