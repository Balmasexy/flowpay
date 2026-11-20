import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createLocalJWKSet, SignJWT, type JWTPayload } from "jose";
import { test } from "node:test";
import {
  createPaystackDedicatedAccountsHandler,
  processPaystackDedicatedAccountWebhook
} from "../src/paystack-dedicated-accounts.js";

const originalFetch = globalThis.fetch;
const originalEnvironment = {
  environment: process.env.PAYSTACK_ENVIRONMENT,
  secret: process.env.PAYSTACK_SECRET_KEY,
  runtime: process.env.FLOWPAY_RUNTIME_ENV,
  enabled: process.env.PAYSTACK_DEDICATED_ACCOUNTS_ENABLED,
  customerNubanEnabled: process.env.FLOWPAY_CUSTOMER_NUBAN_ENABLED,
  nodeEnv: process.env.NODE_ENV
};
const userId = "00000000-0000-4000-8000-000000000001";
const pair = generateKeyPairSync("ed25519");
const jwk = pair.publicKey.export({ format: "jwk" });
const jwks = createLocalJWKSet({
  keys: [{ ...jwk, kid: "paystack-dva-test", alg: "EdDSA", use: "sig" }]
});

async function setup() {
  process.env.PAYSTACK_ENVIRONMENT = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_unit_test_secret";
  process.env.FLOWPAY_RUNTIME_ENV = "development";
  process.env.PAYSTACK_DEDICATED_ACCOUNTS_ENABLED = "true";
  process.env.FLOWPAY_CUSTOMER_NUBAN_ENABLED = "true";
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
        return {
          rowCount: 1,
          rows: [{
            id: userId, role: "customer", name: "Test Customer",
            email: "test@example.invalid", phone: "08012345678"
          }]
        };
      }
      return { rowCount: 1, rows: [] };
    }
  } as unknown as Pool;

  const handler = createPaystackDedicatedAccountsHandler({
    pool,
    jwks: jwks as unknown as ReturnType<typeof import("jose").createRemoteJWKSet>,
    issuer: "https://flowpay.test"
  });
  const request = (method: string, url: string, payload?: Record<string, unknown>) =>
    Object.assign(Readable.from(payload ? [Buffer.from(JSON.stringify(payload))] : []), {
      method, url,
      headers: { authorization: "Bearer " + token }
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
  return { handler, request, response, queries, pool };
}

test("customer NUBAN display and issuance stay disabled even if an old Render flag is true", async () => {
  const context = await setup();
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response("{}", { status: 500 });
  };

  const getResponse = context.response();
  await context.handler(context.request("GET", "/customer/dedicated-bank-account"), getResponse.res);
  assert.equal(getResponse.result().status, 200);
  assert.equal(getResponse.result().body.customerNubanEnabled, false);
  assert.equal(getResponse.result().body.virtualBankAccount.assigned, false);
  assert.equal(getResponse.result().body.virtualBankAccount.accountNumber, null);

  const postResponse = context.response();
  await context.handler(context.request("POST", "/customer/dedicated-bank-account", { consent: true }), postResponse.res);
  assert.equal(postResponse.result().status, 410);
  assert.equal(postResponse.result().body.error, "CUSTOMER_NUBAN_DISABLED");

  const requeryResponse = context.response();
  await context.handler(context.request("POST", "/customer/dedicated-bank-account/requery"), requeryResponse.res);
  assert.equal(requeryResponse.result().status, 410);
  assert.equal(requeryResponse.result().body.error, "CUSTOMER_NUBAN_DISABLED");
  assert.equal(providerCalls, 0, "a customer NUBAN must never be requested or requeried");
  assert.equal(
    context.queries.some(item => item.sql.includes("FROM public.fp_paystack_dedicated_accounts_v2")),
    false,
    "customer NUBAN endpoints must not expose historical account records"
  );
});

test("historical provider assignment webhooks remain reconcilable while customer NUBAN issuance is disabled", async () => {
  const context = await setup();
  process.env.PAYSTACK_DEDICATED_ACCOUNTS_ENABLED = "false";
  const handled = await processPaystackDedicatedAccountWebhook(context.pool, {
    event: "assigndedicatedaccount.success",
    data: {
      customer_code: "CUS_test123",
      email: "test@example.invalid",
      id: 12345,
      assigned: true,
      active: true,
      currency: "NGN",
      account_number: "9930000737",
      account_name: "FlowPay / Test Customer",
      bank: { name: "Test Bank" }
    }
  });
  assert.equal(handled, true);
  const saved = context.queries.find(item =>
    item.sql.includes("account_number = $5") && item.sql.includes("status = 'assigned'")
  );
  assert.ok(saved, "a signed historical provider assignment event must still be recorded for reconciliation");
  assert.equal(saved.values?.[4], "9930000737");
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
  if (originalEnvironment.customerNubanEnabled === undefined) delete process.env.FLOWPAY_CUSTOMER_NUBAN_ENABLED;
  else process.env.FLOWPAY_CUSTOMER_NUBAN_ENABLED = originalEnvironment.customerNubanEnabled;
  if (originalEnvironment.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment.nodeEnv;
});
