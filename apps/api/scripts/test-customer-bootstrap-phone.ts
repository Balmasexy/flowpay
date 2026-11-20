import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { createLocalJWKSet, SignJWT, type JWTPayload } from "jose";
import { test } from "node:test";
import { createCustomerBootstrapHandler } from "../src/customer-bootstrap.js";

const userId = "00000000-0000-4000-8000-000000000011";
const walletId = "00000000-0000-4000-8000-000000000012";
const authSubject = "neon-auth-customer-subject";
const keyPair = generateKeyPairSync("ed25519");
const jwk = keyPair.publicKey.export({ format: "jwk" });
const jwks = createLocalJWKSet({
  keys: [{ ...jwk, kid: "flowpay-bootstrap-test", alg: "EdDSA", use: "sig" }]
});
const oldPhoneFlag = process.env.FLOWPAY_PHONE_REGISTRATION_ENABLED;

async function makeToken() {
  return new SignJWT({} satisfies JWTPayload)
    .setProtectedHeader({ alg: "EdDSA", kid: "flowpay-bootstrap-test" })
    .setIssuer("https://flowpay.test")
    .setAudience("flowpay-api")
    .setSubject(authSubject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keyPair.privateKey);
}

function makeResponse() {
  let status = 0;
  let body: Record<string, unknown> | null = null;
  const response = {
    writeHead: (code: number) => { status = code; },
    end: (value?: string) => { body = value ? JSON.parse(value) as Record<string, unknown> : null; }
  } as unknown as ServerResponse;
  return { response, result: () => ({ status, body }) };
}

function makeRequest(token: string) {
  return Object.assign(Readable.from([]), {
    method: "POST",
    url: "/customer/bootstrap",
    headers: { authorization: "Bearer " + token }
  }) as unknown as IncomingMessage;
}

function makePool(options: { phoneNumber: string | null; phoneVerified: string | null }) {
  const statements: { sql: string; values?: unknown[] }[] = [];
  let assignedAccountNumber = "";
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes("FROM public.fp_users") && sql.includes("WHERE auth_subject = $1")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("UPDATE public.fp_users") && sql.includes("auth_subject = $1")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("INSERT INTO public.fp_users")) {
        return { rowCount: 1, rows: [{
          id: userId, email: "customer@example.com", status: "active", role: "customer"
        }] };
      }
      if (sql.includes("to_regclass('public.fp_customer_phone_aliases')")) {
        return { rowCount: 1, rows: [{ available: true }] };
      }
      if (sql.includes("SELECT account_number FROM public.fp_customer_account_numbers")) {
        return assignedAccountNumber
          ? { rowCount: 1, rows: [{ account_number: assignedAccountNumber }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes("INSERT INTO public.fp_customer_account_numbers")) {
        assignedAccountNumber = String(values?.[1] ?? "");
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("SELECT id FROM public.fp_accounts")) {
        return { rowCount: 1, rows: [{ id: walletId }] };
      }
      if (sql.includes("SELECT status FROM public.fp_cards")) {
        return { rowCount: 1, rows: [{ status: "pending" }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release: () => undefined
  };
  const pool = {
    query: async (sql: string) => {
      assert.ok(sql.includes('FROM neon_auth."user"'));
      return {
        rowCount: 1,
        rows: [{
          id: authSubject,
          email: "customer@example.com",
          emailVerified: true,
          phone_number: options.phoneNumber,
          phone_verified: options.phoneVerified,
          existing_customer: false
        }]
      };
    },
    connect: async () => client
  } as unknown as Pool;
  return { pool, statements };
}

test("requires a Neon-verified phone before a new FlowPay customer is provisioned when enabled", async () => {
  process.env.FLOWPAY_PHONE_REGISTRATION_ENABLED = "true";
  const { pool, statements } = makePool({ phoneNumber: null, phoneVerified: null });
  let connectCalls = 0;
  const restrictedPool = {
    query: pool.query.bind(pool),
    connect: async () => { connectCalls += 1; throw new Error("should not connect"); }
  } as unknown as Pool;
  const handler = createCustomerBootstrapHandler({
    pool: restrictedPool,
    jwks: jwks as unknown as ReturnType<typeof import("jose").createRemoteJWKSet>,
    issuer: "https://flowpay.test",
    audience: "flowpay-api"
  });
  const context = makeResponse();
  assert.equal(await handler(makeRequest(await makeToken()), context.response), true);
  assert.equal(context.result().status, 403);
  assert.equal(context.result().body?.error, "PHONE_NUMBER_VERIFICATION_REQUIRED");
  assert.equal(connectCalls, 0);
  assert.equal(statements.length, 0);
});

test("atomically provisions a permanent 10-digit FlowPay ID and verified phone alias", async () => {
  process.env.FLOWPAY_PHONE_REGISTRATION_ENABLED = "true";
  const { pool, statements } = makePool({
    phoneNumber: "+2348012345678",
    phoneVerified: "true"
  });
  const handler = createCustomerBootstrapHandler({
    pool,
    jwks: jwks as unknown as ReturnType<typeof import("jose").createRemoteJWKSet>,
    issuer: "https://flowpay.test",
    audience: "flowpay-api"
  });
  const context = makeResponse();
  assert.equal(await handler(makeRequest(await makeToken()), context.response), true);
  const result = context.result();
  assert.equal(result.status, 200);
  assert.equal(result.body?.provisioned, true);
  assert.equal(result.body?.customerId, userId);
  assert.equal(result.body?.phoneAliasVerified, true);
  assert.match(String(result.body?.flowpayAccountNumber), /^[1-9][0-9]{9}$/);
  assert.equal(statements.some(item =>
    item.sql.includes("INSERT INTO public.fp_customer_phone_aliases") &&
    item.values?.[1] === "+2348012345678"
  ), true);
  assert.equal(statements.some(item =>
    item.sql.includes("INSERT INTO public.fp_customer_profiles") &&
    item.values?.[1] === "+2348012345678"
  ), true);
  assert.ok(statements.some(item => item.sql === "COMMIT"));
  assert.equal(statements.some(item => item.sql === "ROLLBACK"), false);
});

process.on("exit", () => {
  if (oldPhoneFlag === undefined) delete process.env.FLOWPAY_PHONE_REGISTRATION_ENABLED;
  else process.env.FLOWPAY_PHONE_REGISTRATION_ENABLED = oldPhoneFlag;
});
