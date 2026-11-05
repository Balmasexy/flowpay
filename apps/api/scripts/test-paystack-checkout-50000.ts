import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { createLocalJWKSet, SignJWT, type JWTPayload } from "jose";
import { test } from "node:test";
import { createPaystackCheckoutHandler } from "../src/paystack-checkout.js";

const originalFetch = globalThis.fetch;
const originalEnvironment = {
  environment: process.env.PAYSTACK_ENVIRONMENT,
  secret: process.env.PAYSTACK_SECRET_KEY,
  callback: process.env.PAYSTACK_CALLBACK_URL,
  minimum: process.env.PAYSTACK_DEPOSIT_MIN_MINOR,
  maximum: process.env.PAYSTACK_DEPOSIT_MAX_MINOR
};
const userId = "00000000-0000-4000-8000-000000000001";
const walletId = "00000000-0000-4000-8000-000000000002";
const transactionId = "00000000-0000-4000-8000-000000000003";
const amountMinor = "5000000";
const pair = generateKeyPairSync("ed25519");
const jwk = pair.publicKey.export({ format: "jwk" });
const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "paystack-checkout-test", alg: "EdDSA", use: "sig" }] });

async function setup() {
  process.env.PAYSTACK_ENVIRONMENT = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_unit_test_secret";
  process.env.PAYSTACK_CALLBACK_URL = "https://flowpay.test/payment-return/paystack";
  process.env.PAYSTACK_DEPOSIT_MIN_MINOR = "10000";
  process.env.PAYSTACK_DEPOSIT_MAX_MINOR = "100000000";

  const token = await new SignJWT({} satisfies JWTPayload)
    .setProtectedHeader({ alg: "EdDSA", kid: "paystack-checkout-test" })
    .setIssuer("https://flowpay.test")
    .setAudience("flowpay-api")
    .setSubject("neon-auth-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey);

  const statements: { sql: string; values?: unknown[] }[] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT id FROM public.fp_accounts")) {
        return { rowCount: 1, rows: [{ id: walletId }] };
      }
      if (sql.includes("INSERT INTO public.fp_ledger_transactions")) {
        return { rowCount: 1, rows: [{ id: transactionId }] };
      }
      if (sql.includes("INSERT INTO public.fp_paystack_deposits")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE public.fp_paystack_deposits SET checkout_url")) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error("Unexpected checkout database query: " + sql);
    },
    release: () => undefined
  } as unknown as PoolClient;
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (sql.includes('FROM neon_auth."user"')) {
        return { rowCount: 1, rows: [{ id: userId, email: "test@example.invalid", name: "Test Customer" }] };
      }
      if (sql.includes("UPDATE public.fp_paystack_deposits SET checkout_url")) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error("Unexpected pooled checkout query: " + sql);
    },
    connect: async () => client
  } as unknown as Pool;
  const handler = createPaystackCheckoutHandler({
    pool,
    jwks: jwks as unknown as ReturnType<typeof import("jose").createRemoteJWKSet>,
    issuer: "https://flowpay.test",
    audience: "flowpay-api"
  });
  const request = (body: Record<string, unknown>) => Object.assign(
    Readable.from([Buffer.from(JSON.stringify(body))]),
    { method: "POST", url: "/customer/paystack/deposits", headers: { authorization: "Bearer " + token } }
  ) as unknown as IncomingMessage;
  const response = () => {
    let status = 0;
    let body = "";
    const res = {
      writeHead: (value: number) => { status = value; },
      end: (value?: string) => { body = value ?? ""; }
    } as unknown as ServerResponse;
    return { res, result: () => ({ status, body: body ? JSON.parse(body) : null }) };
  };
  return { handler, request, response, statements };
}

test("initializes a Paystack sandbox checkout for exactly NGN 50,000", async () => {
  const context = await setup();
  let providerPayload: Record<string, unknown> = {};
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://api.paystack.co/transaction/initialize");
    providerPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      status: true,
      message: "Authorization URL created",
      data: {
        authorization_url: "https://checkout.paystack.com/test-flowpay-50000",
        access_code: "test_access_code",
        reference: providerPayload["reference"]
      }
    }), { status: 200 });
  };

  const response = context.response();
  await context.handler(context.request({
    amountMinor,
    idempotencyKey: "00000000-0000-4000-8000-000000000004"
  }), response.res);
  const result = response.result();
  assert.equal(result.status, 201);
  assert.equal(result.body.status, "pending");
  assert.equal(result.body.environment, "test");
  assert.equal(result.body.checkoutUrl, "https://checkout.paystack.com/test-flowpay-50000");
  assert.equal(providerPayload["amount"], amountMinor);
  assert.equal(providerPayload["currency"], "NGN");
  assert.equal((providerPayload["metadata"] as Record<string, unknown>).flowpay_environment, "test");
  assert.ok(context.statements.some(item => item.sql.includes("INSERT INTO public.fp_ledger_transactions")));
  assert.ok(context.statements.some(item => item.sql.includes("INSERT INTO public.fp_paystack_deposits")));
  assert.ok(context.statements.some(item => item.sql.includes("UPDATE public.fp_paystack_deposits SET checkout_url")));
});

process.on("exit", () => {
  globalThis.fetch = originalFetch;
  if (originalEnvironment.environment === undefined) delete process.env.PAYSTACK_ENVIRONMENT;
  else process.env.PAYSTACK_ENVIRONMENT = originalEnvironment.environment;
  if (originalEnvironment.secret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
  else process.env.PAYSTACK_SECRET_KEY = originalEnvironment.secret;
  if (originalEnvironment.callback === undefined) delete process.env.PAYSTACK_CALLBACK_URL;
  else process.env.PAYSTACK_CALLBACK_URL = originalEnvironment.callback;
  if (originalEnvironment.minimum === undefined) delete process.env.PAYSTACK_DEPOSIT_MIN_MINOR;
  else process.env.PAYSTACK_DEPOSIT_MIN_MINOR = originalEnvironment.minimum;
  if (originalEnvironment.maximum === undefined) delete process.env.PAYSTACK_DEPOSIT_MAX_MINOR;
  else process.env.PAYSTACK_DEPOSIT_MAX_MINOR = originalEnvironment.maximum;
});
