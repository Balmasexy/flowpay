import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { createLocalJWKSet, SignJWT } from "jose";
import { createDepositReceiptHandler } from "../src/deposit-receipts.js";

const userId = "00000000-0000-4000-8000-000000000001";
const receiptId = "00000000-0000-4000-8000-000000000002";
const transactionId = "00000000-0000-4000-8000-000000000003";
const reference = "flowpay-ps-0123456789abcdef0123456789abcdef";
const pair = generateKeyPairSync("ed25519");
const jwk = pair.publicKey.export({ format: "jwk" });
const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "flowpay-receipt-test", alg: "EdDSA", use: "sig" }] });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9p8AAAAASUVORK5CYII=", "base64");

async function setup(options: {
  role?: "customer" | "admin" | "super_admin";
  depositExists?: boolean;
  reviewChanged?: boolean;
} = {}) {
  const role = options.role ?? "customer";
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: "flowpay-receipt-test" })
    .setIssuer("https://flowpay.test")
    .setAudience("flowpay-api")
    .setSubject("neon-auth-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey);

  const queries: string[] = [];
  const clientQueries: string[] = [];
  const client = {
    query: async (sql: string) => {
      clientQueries.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT transaction_id, status FROM public.fp_paystack_deposits")) {
        return options.depositExists === false
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ transaction_id: transactionId, status: "pending" }] };
      }
      if (sql.includes("COUNT(*)::int AS receipt_count")) return { rowCount: 1, rows: [{ receipt_count: 0 }] };
      if (sql.includes("INSERT INTO public.fp_deposit_receipts")) return { rowCount: 1, rows: [{ id: receiptId }] };
      if (sql.includes("UPDATE public.fp_deposit_receipts")) {
        return options.reviewChanged === false
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ id: receiptId, user_id: userId }] };
      }
      if (sql.includes("SELECT review_status FROM public.fp_deposit_receipts")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("INSERT INTO public.fp_security_audit_events")) return { rowCount: 1, rows: [] };
      throw new Error("Unexpected client SQL: " + sql);
    },
    release: () => undefined
  } as unknown as PoolClient;

  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push(sql);
      if (sql.includes('FROM neon_auth."user"')) {
        assert.deepEqual(values, ["neon-auth-subject"]);
        if (role === "customer" && sql.includes("app_user.role = 'customer'")) {
          return { rowCount: 1, rows: [{ id: userId, name: "FlowPay customer", email: "customer@example.test" }] };
        }
        if ((role === "admin" || role === "super_admin") && sql.includes("app_user.role IN ('admin', 'super_admin')")) {
          return { rowCount: 1, rows: [{ id: userId, name: "FlowPay admin", email: "admin@example.test" }] };
        }
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("FROM public.fp_deposit_receipts AS r")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("FROM public.fp_deposit_receipts WHERE id")) {
        return { rowCount: 1, rows: [{ file_data: png, mime_type: "image/png", file_name: "receipt.png" }] };
      }
      throw new Error("Unexpected pool SQL: " + sql);
    },
    connect: async () => client
  } as unknown as Pool;

  const handler = createDepositReceiptHandler({
    pool,
    jwks: jwks as unknown as ReturnType<typeof import("jose").createRemoteJWKSet>,
    issuer: "https://flowpay.test",
    audience: "flowpay-api"
  });
  const request = (method: string, url: string, body?: Record<string, unknown>, auth = true) =>
    Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      method,
      url,
      headers: auth ? { authorization: "Bearer " + token } : {}
    }) as unknown as IncomingMessage;
  const response = () => {
    let status = 0;
    let body: unknown = null;
    let headers: Record<string, unknown> = {};
    const res = {
      writeHead: (code: number, value?: Record<string, unknown>) => { status = code; headers = value ?? {}; },
      end: (value?: string | Buffer) => {
        if (typeof value === "string" && value) body = JSON.parse(value);
        else body = value ?? null;
      }
    } as unknown as ServerResponse;
    return { res, result: () => ({ status, body, headers }) };
  };
  return { handler, request, response, queries, clientQueries };
}

test("rejects unauthenticated customer receipt submissions", async () => {
  const context = await setup();
  const response = context.response();
  const handled = await context.handler(context.request("POST", "/customer/paystack/deposits/receipt", {
    reference, fileName: "receipt.png", imageDataUrl: "data:image/png;base64," + png.toString("base64")
  }, false), response.res);
  assert.equal(handled, true);
  assert.equal(response.result().status, 401);
  assert.equal(context.queries.length, 0);
});

test("stores a valid receipt only against the authenticated customer's own Paystack reference", async () => {
  const context = await setup();
  const response = context.response();
  await context.handler(context.request("POST", "/customer/paystack/deposits/receipt", {
    reference, fileName: "transfer receipt.png", imageDataUrl: "data:image/png;base64," + png.toString("base64")
  }), response.res);
  assert.equal(response.result().status, 201);
  assert.equal((response.result().body as Record<string, unknown>).reviewStatus, "pending_review");
  assert.equal((response.result().body as Record<string, unknown>).walletCredited, false);
  assert.ok(context.clientQueries.some(sql => sql.includes("INSERT INTO public.fp_deposit_receipts")));
  assert.ok(context.clientQueries.some(sql => sql.includes("FOR UPDATE")));
  assert.equal(context.clientQueries.some(sql => sql.includes("INSERT INTO public.fp_ledger_transactions")), false);
});

test("does not accept a receipt with a spoofed image MIME type", async () => {
  const context = await setup();
  const response = context.response();
  await context.handler(context.request("POST", "/customer/paystack/deposits/receipt", {
    reference, fileName: "not-a-png.png", imageDataUrl: "data:image/png;base64," + Buffer.from("hello").toString("base64")
  }), response.res);
  assert.equal(response.result().status, 400);
  assert.equal((response.result().body as Record<string, unknown>).error, "RECEIPT_IMAGE_CONTENT_MISMATCH");
  assert.equal(context.clientQueries.length, 0);
});

test("customer cannot upload evidence against another customer's deposit reference", async () => {
  const context = await setup({ depositExists: false });
  const response = context.response();
  await context.handler(context.request("POST", "/customer/paystack/deposits/receipt", {
    reference, fileName: "receipt.png", imageDataUrl: "data:image/png;base64," + png.toString("base64")
  }), response.res);
  assert.equal(response.result().status, 404);
  assert.equal((response.result().body as Record<string, unknown>).error, "OWN_PAYSTACK_DEPOSIT_NOT_FOUND");
  assert.equal(context.clientQueries.some(sql => sql.includes("INSERT INTO public.fp_deposit_receipts")), false);
});

test("receipt review is available only to authenticated admin roles", async () => {
  const customer = await setup({ role: "customer" });
  const customerResponse = customer.response();
  await customer.handler(customer.request("GET", "/admin/deposit-receipts"), customerResponse.res);
  assert.equal(customerResponse.result().status, 403);

  const admin = await setup({ role: "admin" });
  const adminResponse = admin.response();
  await admin.handler(admin.request("GET", "/admin/deposit-receipts"), adminResponse.res);
  assert.equal(adminResponse.result().status, 200);
  assert.equal((adminResponse.result().body as Record<string, unknown>).reviewCanCreditWallet, false);
});

test("accepting receipt evidence creates an audit event but never credits the wallet", async () => {
  const context = await setup({ role: "super_admin" });
  const response = context.response();
  await context.handler(context.request("PATCH", "/admin/deposit-receipts/" + receiptId + "/review", {
    reviewStatus: "evidence_accepted", reviewNote: "Image reviewed"
  }), response.res);
  assert.equal(response.result().status, 200);
  assert.equal((response.result().body as Record<string, unknown>).walletCredited, false);
  assert.ok(context.clientQueries.some(sql => sql.includes("UPDATE public.fp_deposit_receipts")));
  assert.ok(context.clientQueries.some(sql => sql.includes("INSERT INTO public.fp_security_audit_events")));
  assert.equal(context.clientQueries.some(sql => sql.includes("INSERT INTO public.fp_ledger_transactions")), false);
});
