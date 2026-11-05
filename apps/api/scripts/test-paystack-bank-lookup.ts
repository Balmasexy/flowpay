import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createLocalJWKSet, SignJWT, type JWTPayload } from "jose";
import { createBankAccountLookupHandler } from "../src/bank-account-lookup.js";

const originalFetch = globalThis.fetch;
const originalEnvironment = {
  environment: process.env.PAYSTACK_ENVIRONMENT,
  secret: process.env.PAYSTACK_SECRET_KEY
};
const userId = "00000000-0000-4000-8000-000000000001";
const accountNumber = "0123456789";
const bankCode = "058";
const pair = generateKeyPairSync("ed25519");
const jwk = pair.publicKey.export({ format: "jwk" });
const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "paystack-bank-test", alg: "EdDSA", use: "sig" }] });

async function setup() {
  process.env.PAYSTACK_ENVIRONMENT = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_unit_test_secret";
  const token = await new SignJWT({} satisfies JWTPayload)
    .setProtectedHeader({ alg: "EdDSA", kid: "paystack-bank-test" })
    .setIssuer("https://flowpay.test")
    .setAudience("flowpay-api")
    .setSubject("neon-auth-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey);
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      assert.ok(sql.includes('FROM neon_auth."user"'));
      return { rowCount: 1, rows: [{ id: userId }] };
    }
  } as unknown as Pool;
  const handler = createBankAccountLookupHandler({
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
    let body = "";
    const res = {
      writeHead: (code: number) => { status = code; },
      end: (value?: string) => { body = value ?? ""; }
    } as unknown as ServerResponse;
    return { res, result: () => ({ status, body: body ? JSON.parse(body) : null }) };
  };
  return { handler, request, response, queries };
}

test("lists only supported Nigerian NGN banks from Paystack test mode", async () => {
  const context = await setup();
  let requestUrl = "";
  globalThis.fetch = async (input: string | URL | Request) => {
    requestUrl = String(input);
    return new Response(JSON.stringify({
      status: true,
      data: [
        { code: "058", name: "GTBank", active: true, country: "Nigeria", currency: "NGN", type: "nuban" },
        { code: "044", name: "Access Bank", active: true, country: "Nigeria", currency: "NGN", type: "nuban" },
        { code: "999", name: "Inactive Bank", active: false, country: "Nigeria", currency: "NGN", type: "nuban" },
        { code: "111", name: "Foreign Bank", active: true, country: "Ghana", currency: "GHS", type: "ghipss" }
      ],
      meta: { next: null }
    }), { status: 200 });
  };
  const response = context.response();
  await context.handler(context.request("GET", "/customer/banks"), response.res);
  assert.equal(response.result().status, 200);
  assert.equal(response.result().body.provider, "Paystack");
  assert.equal(response.result().body.environment, "test");
  assert.deepEqual(response.result().body.banks.map((bank: { code: string }) => bank.code), ["044", "058"]);
  assert.ok(requestUrl.includes("api.paystack.co/bank"));
  assert.ok(requestUrl.includes("country=nigeria"));
  assert.ok(requestUrl.includes("currency=NGN"));
});

test("resolves a Nigerian account and returns the provider-verified name", async () => {
  const context = await setup();
  const calls: string[] = [];
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/bank?")) {
      return new Response(JSON.stringify({
        status: true,
        data: [{ code: bankCode, name: "GTBank", active: true, country: "Nigeria", currency: "NGN", type: "nuban" }],
        meta: { next: null }
      }), { status: 200 });
    }
    assert.ok(url.startsWith("https://api.paystack.co/bank/resolve?"));
    assert.ok(url.includes("account_number=" + accountNumber));
    assert.ok(url.includes("bank_code=" + bankCode));
    return new Response(JSON.stringify({
      status: true,
      data: { account_number: accountNumber, account_name: "Test Recipient" }
    }), { status: 200 });
  };
  const response = context.response();
  await context.handler(context.request("POST", "/customer/bank-account-lookup", { accountNumber, bankCode }), response.res);
  assert.equal(response.result().status, 200);
  assert.equal(response.result().body.verified, true);
  assert.equal(response.result().body.accountName, "Test Recipient");
  assert.equal(response.result().body.bankName, "GTBank");
  assert.equal(response.result().body.provider, "Paystack");
  assert.ok(calls.some(url => url.startsWith("https://api.paystack.co/bank/resolve?")));
});

test("rejects an account number that does not match Paystack's verification response", async () => {
  const context = await setup();
  globalThis.fetch = async (input: string | URL | Request) => String(input).includes("/bank?")
    ? new Response(JSON.stringify({
        status: true,
        data: [{ code: bankCode, name: "GTBank", country: "Nigeria", currency: "NGN", type: "nuban" }],
        meta: { next: null }
      }), { status: 200 })
    : new Response(JSON.stringify({
        status: true,
        data: { account_number: "9999999999", account_name: "Wrong Recipient" }
      }), { status: 200 });
  const response = context.response();
  await context.handler(context.request("POST", "/customer/bank-account-lookup", { accountNumber, bankCode }), response.res);
  assert.equal(response.result().status, 422);
  assert.equal(response.result().body.verified, false);
});

test("rejects invalid input without calling Paystack", async () => {
  const context = await setup();
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response("{}", { status: 500 });
  };
  const response = context.response();
  await context.handler(context.request("POST", "/customer/bank-account-lookup", { accountNumber: "123", bankCode }), response.res);
  assert.equal(response.result().status, 400);
  assert.equal(providerCalls, 0);
});

test("requires an authenticated customer session", async () => {
  const context = await setup();
  const response = context.response();
  await context.handler(context.request("GET", "/customer/banks", undefined, false), response.res);
  assert.equal(response.result().status, 401);
});

process.on("exit", () => {
  globalThis.fetch = originalFetch;
  if (originalEnvironment.environment === undefined) delete process.env.PAYSTACK_ENVIRONMENT;
  else process.env.PAYSTACK_ENVIRONMENT = originalEnvironment.environment;
  if (originalEnvironment.secret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
  else process.env.PAYSTACK_SECRET_KEY = originalEnvironment.secret;
});
