import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createLocalJWKSet, SignJWT, type JWTPayload } from "jose";
import { test } from "node:test";
import { createPaystackDedicatedAccountsHandler } from "../src/paystack-dedicated-accounts.js";

const originalFetch = globalThis.fetch;
const originalEnvironment = {
  environment: process.env.PAYSTACK_ENVIRONMENT,
  secret: process.env.PAYSTACK_SECRET_KEY,
  runtime: process.env.FLOWPAY_RUNTIME_ENV,
  enabled: process.env.PAYSTACK_DEDICATED_ACCOUNTS_ENABLED,
  nodeEnv: process.env.NODE_ENV
};
const userId = "00000000-0000-4000-8000-000000000001";
const pair = generateKeyPairSync("ed25519");
const jwk = pair.publicKey.export({ format: "jwk" });
const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "paystack-dva-test", alg: "EdDSA", use: "sig" }] });

async function setup() {
  process.env.PAYSTACK_ENVIRONMENT = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_unit_test_secret";
  process.env.FLOWPAY_RUNTIME_ENV = "development";
  process.env.PAYSTACK_DEDICATED_ACCOUNTS_ENABLED = "true";
  process.env.NODE_ENV = "test";
  const token = await new SignJWT({} satisfies JWTPayload)
    .setProtectedHeader({ alg: "EdDSA", kid: "paystack-dva-test" })
    .setIssuer("https://flowpay.test")
    .setSubject("neon-auth-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey);
  const queries: { sql: string; values?: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes('FROM neon_auth."user"')) {
        return { rowCount: 1, rows: [{
          id: userId, role: "customer", name: "Test Customer",
          email: "test@example.invalid", phone: "08012345678"
        }] };
      }
      if (sql.includes("FROM public.fp_paystack_dedicated_accounts")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("RETURNING user_id, paystack_customer_code")) {
        return { rowCount: 1, rows: [{
          user_id: userId, paystack_customer_code: "CUS_test123",
          dedicated_account_id: "12345", account_number: "9930000737",
          bank_name: "Test Bank", account_name: "FlowPay / Test Customer", status: "assigned"
        }] };
      }
      return { rowCount: 1, rows: [] };
    }
  } as unknown as Pool;
  const handler = createPaystackDedicatedAccountsHandler({
    pool,
    jwks: jwks as unknown as ReturnType<typeof import("jose").createRemoteJWKSet>,
    issuer: "https://flowpay.test",
  });
  const request = (method: string, url: string, payload?: Record<string, unknown>, auth = true) =>
    Object.assign(Readable.from(payload ? [Buffer.from(JSON.stringify(payload))] : []), {
      method, url,
      headers: auth ? { authorization: "Bearer " + token } : {}
    }) as unknown as IncomingMessage;
  const response = () => {
    let status = 0;
    let body = "";
    const res = {
      writeHead: (code: number) => { status = code; },
      end: (value?: string) => { body = value ?? ""; }
    } as unknown as ServerResponse;
    return { res, result: () => ({ status, body: body ? JSON.parse(body) : null }) };
  };
  return { handler, request, response, queries };
}

test("requires express consent before any provider request", async () => {
  const context = await setup();
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("{}", { status: 500 }); };
  const response = context.response();
  await context.handler(context.request("POST", "/customer/dedicated-bank-account", { consent: false }), response.res);
  assert.equal(response.result().status, 400);
  assert.equal(response.result().body.error, "EXPRESS_CONSENT_REQUIRED");
  assert.equal(calls, 0);
});

test("blocks the sandbox route when isolated development switches are absent", async () => {
  const context = await setup();
  delete process.env.PAYSTACK_DEDICATED_ACCOUNTS_ENABLED;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("{}", { status: 500 }); };
  const response = context.response();
  await context.handler(context.request("POST", "/customer/dedicated-bank-account", { consent: true }), response.res);
  assert.equal(response.result().status, 503);
  assert.equal(response.result().body.error, "PAYSTACK_DEDICATED_ACCOUNTS_NOT_ENABLED");
  assert.equal(calls, 0);
});

test("accepts issuer-verified Neon JWTs without an audience claim and stores only provider-confirmed accounts", async () => {
  const context = await setup();
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const payload = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, body: payload });
    if (url === "https://api.paystack.co/customer") {
      assert.equal(payload.email, "test@example.invalid");
      assert.equal(payload.first_name, "Test");
      assert.equal(payload.last_name, "Customer");
      assert.equal(payload.phone, "+2348012345678");
      return new Response(JSON.stringify({
        status: true, data: { customer_code: "CUS_test123", domain: "test" }
      }), { status: 200 });
    }
    if (url === "https://api.paystack.co/dedicated_account") {
      assert.equal(payload.customer, "CUS_test123");
      assert.equal(payload.preferred_bank, "test-bank");
      return new Response(JSON.stringify({
        status: true,
        data: {
          id: 12345, assigned: true, active: true, currency: "NGN",
          account_number: "9930000737", account_name: "FlowPay / Test Customer",
          bank: { name: "Test Bank", slug: "test-bank" }
        }
      }), { status: 200 });
    }
    throw new Error("Unexpected provider request: " + url);
  };
  const response = context.response();
  await context.handler(context.request("POST", "/customer/dedicated-bank-account", { consent: true }), response.res);
  const result = response.result();
  assert.equal(result.status, 201);
  assert.equal(result.body.virtualBankAccount.assigned, true);
  assert.equal(result.body.virtualBankAccount.accountNumber, "9930000737");
  assert.equal(result.body.virtualBankAccount.bankName, "Test Bank");
  assert.equal(result.body.livePaymentsEnabled, false);
  assert.equal(calls.length, 2);
  assert.ok(context.queries.some(item => item.sql.includes("consent_at")));
  assert.ok(context.queries.some(item => item.sql.includes("account_number = $3")));
});

process.on("exit", () => {
  globalThis.fetch = originalFetch;
  if (originalEnvironment.environment === undefined) delete process.env.PAYSTACK_ENVIRONMENT;
  else process.env.PAYSTACK_ENVIRONMENT = originalEnvironment.environment;
  if (originalEnvironment.secret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
  else process.env.PAYSTACK_SECRET_KEY = originalEnvironment.secret;
  if (originalEnvironment.runtime === undefined) delete process.env.FLOWPAY_RUNTIME_ENV;
  else process.env.FLOWPAY_RUNTIME_ENV = originalEnvironment.runtime;
  if (originalEnvironment.enabled === undefined) delete process.env.PAYSTACK_DEDICATED_ACCOUNTS_ENABLED;
  else process.env.PAYSTACK_DEDICATED_ACCOUNTS_ENABLED = originalEnvironment.enabled;
  if (originalEnvironment.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment.nodeEnv;
});
