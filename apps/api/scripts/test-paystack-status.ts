import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { createLocalJWKSet, SignJWT, type JWTPayload } from "jose";
import { test } from "node:test";
import { createPaystackDepositStatusHandler } from "../src/paystack-status.js";

const originalFetch = globalThis.fetch;
const originalEnvironment = {
  environment: process.env.PAYSTACK_ENVIRONMENT,
  secret: process.env.PAYSTACK_SECRET_KEY,
  livePayments: process.env.PAYSTACK_LIVE_PAYMENTS_ENABLED,
  nodeEnv: process.env.NODE_ENV
};
const userId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const transactionId = "00000000-0000-4000-8000-000000000003";
const clearingId = "00000000-0000-4000-8000-000000000004";
const reference = "flowpay-ps-00000000000000000000000000000001";
const amountMinor = "250000";
const keyPair = generateKeyPairSync("ed25519");
const publicJwk = keyPair.publicKey.export({ format: "jwk" });
const jwks = createLocalJWKSet({ keys: [{ ...publicJwk, kid: "paystack-status-test", alg: "EdDSA", use: "sig" }] });

async function setup(providerStatus: "success" | "failed" | "pending" = "success") {
  process.env.PAYSTACK_ENVIRONMENT = "live";
  process.env.PAYSTACK_SECRET_KEY = "sk_live_unit_test_secret";
  process.env.PAYSTACK_LIVE_PAYMENTS_ENABLED = "false";
  process.env.NODE_ENV = "production";
  const token = await new SignJWT({} satisfies JWTPayload)
    .setProtectedHeader({ alg: "EdDSA", kid: "paystack-status-test" })
    .setIssuer("https://flowpay.test")
    .setAudience("flowpay-api")
    .setSubject("neon-auth-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keyPair.privateKey);

  let depositStatus: "pending" | "posted" | "failed" = "pending";
  let ledgerStatus = "pending";
  let providerTransactionId: string | null = null;
  const statements: string[] = [];
  const ledgerEntries: unknown[][] = [];
  let providerCalls = 0;

  const deposit = () => ({
    transaction_id: transactionId,
    user_id: userId,
    account_id: accountId,
    reference,
    amount_minor: amountMinor,
    currency: "NGN",
    status: depositStatus,
    provider_transaction_id: providerTransactionId,
    created_at: new Date("2026-11-13T10:00:00.000Z"),
    verified_at: depositStatus === "posted" ? new Date("2026-11-13T10:01:00.000Z") : null
  });

  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes("FROM public.fp_paystack_deposits") && sql.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [deposit()] };
      }
      if (sql.includes("SELECT transaction_id, status FROM public.fp_paystack_deposits")) {
        return { rowCount: 1, rows: [{ transaction_id: transactionId, status: depositStatus }] };
      }
      if (sql.includes("SELECT status FROM public.fp_ledger_transactions")) {
        return { rowCount: 1, rows: [{ status: ledgerStatus }] };
      }
      if (sql.includes("WHERE id = $1 AND user_id = $2")) {
        return { rowCount: 1, rows: [{ id: accountId }] };
      }
      if (sql.includes("system_account_role = 'paystack_ngn_clearing'")) {
        return { rowCount: 1, rows: [{ id: clearingId }] };
      }
      if (sql.includes("SELECT COUNT(*)::int AS entry_count")) {
        return { rowCount: 1, rows: [{ entry_count: 0 }] };
      }
      if (sql.includes("INSERT INTO public.fp_ledger_entries")) {
        ledgerEntries.push(values ?? []);
        return { rowCount: 2, rows: [] };
      }
      if (sql.includes("UPDATE public.fp_ledger_transactions") && sql.includes("status = 'posted'")) {
        ledgerStatus = "posted";
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE public.fp_ledger_transactions") && sql.includes("status = 'failed'")) {
        ledgerStatus = "failed";
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE public.fp_paystack_deposits") && sql.includes("status = 'posted'")) {
        depositStatus = "posted";
        providerTransactionId = "987654321";
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE public.fp_paystack_deposits") && sql.includes("status = 'failed'")) {
        depositStatus = "failed";
        return { rowCount: 1, rows: [] };
      }
      throw new Error("Unexpected client query: " + sql);
    },
    release: () => undefined
  };

  const pool = {
    query: async (sql: string) => {
      if (sql.includes('FROM neon_auth."user"')) {
        return { rowCount: 1, rows: [{ id: userId }] };
      }
      if (sql.includes("FROM public.fp_paystack_deposits")) {
        return { rowCount: 1, rows: [deposit()] };
      }
      throw new Error("Unexpected pool query: " + sql);
    },
    connect: async () => client
  } as unknown as Pool;

  globalThis.fetch = async (input: string | URL | Request) => {
    providerCalls += 1;
    assert.equal(String(input), "https://api.paystack.co/transaction/verify/" + reference);
    return new Response(JSON.stringify({
      status: true,
      data: {
        id: 987654321,
        domain: "live",
        status: providerStatus,
        reference,
        amount: Number(amountMinor),
        currency: "NGN"
      }
    }), { status: 200 });
  };

  const handler = createPaystackDepositStatusHandler({
    pool,
    jwks: jwks as unknown as ReturnType<typeof import("jose").createRemoteJWKSet>,
    issuer: "https://flowpay.test",
    audience: "flowpay-api"
  });
  const request = Object.assign(Readable.from([]), {
    method: "GET",
    url: "/customer/paystack/deposits/status?reference=" + reference,
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
  return { handler, request, response, statements, ledgerEntries, providerCalls: () => providerCalls };
}

test("recovers an accepted live deposit after new live checkout is disabled", async () => {
  const context = await setup("success");
  const response = context.response();
  await context.handler(context.request, response.res);
  assert.equal(response.result().status, 200);
  assert.equal(response.result().body.deposit.status, "posted");
  assert.equal(response.result().body.walletCredited, true);
  assert.equal(response.result().body.verification, "provider_verified");
  assert.equal(context.providerCalls(), 1);
  assert.equal(context.ledgerEntries.length, 1);
  assert.deepEqual(context.ledgerEntries[0], [transactionId, accountId, amountMinor, clearingId, "-250000"]);
});

test("marks only a provider-confirmed failed pending deposit as failed without credit", async () => {
  const context = await setup("failed");
  const response = context.response();
  await context.handler(context.request, response.res);
  assert.equal(response.result().status, 200);
  assert.equal(response.result().body.deposit.status, "failed");
  assert.equal(response.result().body.walletCredited, false);
  assert.equal(response.result().body.verification, "provider_confirmed_failure");
  assert.equal(context.ledgerEntries.length, 0);
});

test("leaves an ongoing provider transaction pending without posting ledger entries", async () => {
  const context = await setup("pending");
  const response = context.response();
  await context.handler(context.request, response.res);
  assert.equal(response.result().status, 200);
  assert.equal(response.result().body.deposit.status, "pending");
  assert.equal(response.result().body.walletCredited, false);
  assert.equal(response.result().body.verification, "pending");
  assert.equal(context.ledgerEntries.length, 0);
});

process.on("exit", () => {
  globalThis.fetch = originalFetch;
  if (originalEnvironment.environment === undefined) delete process.env.PAYSTACK_ENVIRONMENT;
  else process.env.PAYSTACK_ENVIRONMENT = originalEnvironment.environment;
  if (originalEnvironment.secret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
  else process.env.PAYSTACK_SECRET_KEY = originalEnvironment.secret;
  if (originalEnvironment.livePayments === undefined) delete process.env.PAYSTACK_LIVE_PAYMENTS_ENABLED;
  else process.env.PAYSTACK_LIVE_PAYMENTS_ENABLED = originalEnvironment.livePayments;
  if (originalEnvironment.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment.nodeEnv;
});
