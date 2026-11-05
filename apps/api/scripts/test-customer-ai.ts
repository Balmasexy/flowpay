import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createLocalJWKSet, SignJWT, type JWTPayload } from "jose";
import { createCustomerAiHandler } from "../src/customer-ai.js";

const originalFetch = globalThis.fetch;
const originalEnvironment = {
  key: process.env.FLOWPAY_BALMZ_AI_API_KEY,
  model: process.env.FLOWPAY_BALMZ_AI_MODEL
};
const userId = "00000000-0000-4000-8000-000000000001";
const pair = generateKeyPairSync("ed25519");
const jwk = pair.publicKey.export({ format: "jwk" });
const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "flowpay-ai-test", alg: "EdDSA", use: "sig" }] });

async function setup(options: { customerExists?: boolean; apiKey?: string } = {}) {
  delete process.env.FLOWPAY_BALMZ_AI_API_KEY;
  delete process.env.FLOWPAY_BALMZ_AI_MODEL;
  if (options.apiKey !== undefined) process.env.FLOWPAY_BALMZ_AI_API_KEY = options.apiKey;
  else process.env.FLOWPAY_BALMZ_AI_API_KEY = "flowpay-test-openai-key";
  const token = await new SignJWT({} satisfies JWTPayload)
    .setProtectedHeader({ alg: "EdDSA", kid: "flowpay-ai-test" })
    .setIssuer("https://flowpay.test")
    .setAudience("flowpay-api")
    .setSubject("neon-auth-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey);
  const queries: string[] = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push(sql);
      assert.ok(sql.includes('FROM neon_auth."user"'));
      assert.deepEqual(values, ["neon-auth-subject", "active", "customer"]);
      return options.customerExists === false
        ? { rowCount: 0, rows: [] }
        : { rowCount: 1, rows: [{ id: userId, name: "FlowPay Test Customer" }] };
    }
  } as unknown as Pool;
  const handler = createCustomerAiHandler({
    pool,
    jwks: jwks as unknown as ReturnType<typeof import("jose").createRemoteJWKSet>,
    issuer: "https://flowpay.test",
    audience: "flowpay-api"
  });
  const request = (body?: Record<string, unknown>, auth = true) =>
    Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      method: "POST",
      url: "/customer-ai/chat",
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

test("authenticated customer receives a BALMZ AI response through the server-side Responses API", async () => {
  const context = await setup();
  let providerUrl = "";
  let providerHeaders: Record<string, string> = {};
  let providerBody: Record<string, unknown> = {};
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    providerUrl = String(input);
    providerHeaders = init?.headers as Record<string, string>;
    providerBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ output_text: "Open the Transfer History page to review outgoing transfers." }), { status: 200 });
  };
  const response = context.response();
  await context.handler(context.request({ message: "Where can I find my transfer history?" }), response.res);
  assert.equal(response.result().status, 200);
  assert.equal(response.result().body.assistant, "BALMZ AI");
  assert.equal(response.result().body.reply, "Open the Transfer History page to review outgoing transfers.");
  assert.equal(providerUrl, "https://api.openai.com/v1/responses");
  assert.equal(providerHeaders.Authorization, "Bearer flowpay-test-openai-key");
  assert.equal(providerBody.model, "gpt-6-luna");
  assert.equal(providerBody.store, false);
  assert.equal(providerBody.input, "Where can I find my transfer history?");
  assert.ok(String(providerBody.instructions).includes("cannot access customer balances"));
  assert.ok(String(providerBody.instructions).includes("FlowPay Test Customer"));
  assert.equal(context.queries.length, 1);
});

test("rejects unauthenticated chat requests before calling the AI provider", async () => {
  const context = await setup();
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("{}", { status: 200 }); };
  const response = context.response();
  await context.handler(context.request({ message: "Help" }, false), response.res);
  assert.equal(response.result().status, 401);
  assert.equal(calls, 0);
});

test("rejects a signed-in user who is not an active verified FlowPay customer", async () => {
  const context = await setup({ customerExists: false });
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("{}", { status: 200 }); };
  const response = context.response();
  await context.handler(context.request({ message: "Help" }), response.res);
  assert.equal(response.result().status, 403);
  assert.equal(calls, 0);
});

test("does not call OpenAI when the FlowPay-specific server key is missing", async () => {
  const context = await setup({ apiKey: "" });
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("{}", { status: 200 }); };
  const response = context.response();
  await context.handler(context.request({ message: "Explain wallet transfers" }), response.res);
  assert.equal(response.result().status, 503);
  assert.equal(response.result().body.error, "FLOWPAY_BALMZ_AI_NOT_CONFIGURED");
  assert.equal(calls, 0);
});

test("validates message length and rejects unsupported payload fields", async () => {
  const context = await setup();
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("{}", { status: 200 }); };
  const tooLong = context.response();
  await context.handler(context.request({ message: "x".repeat(2001) }), tooLong.res);
  assert.equal(tooLong.result().status, 413);
  const unsupported = context.response();
  await context.handler(context.request({ message: "Help", accountNumber: "1234567890" }), unsupported.res);
  assert.equal(unsupported.result().status, 400);
  assert.equal(calls, 0);
});

process.on("exit", () => {
  globalThis.fetch = originalFetch;
  if (originalEnvironment.key === undefined) delete process.env.FLOWPAY_BALMZ_AI_API_KEY;
  else process.env.FLOWPAY_BALMZ_AI_API_KEY = originalEnvironment.key;
  if (originalEnvironment.model === undefined) delete process.env.FLOWPAY_BALMZ_AI_MODEL;
  else process.env.FLOWPAY_BALMZ_AI_MODEL = originalEnvironment.model;
});
