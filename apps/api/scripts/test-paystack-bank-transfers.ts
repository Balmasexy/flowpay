import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, scryptSync } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { createLocalJWKSet, SignJWT, type JWTPayload } from "jose";
import { test } from "node:test";
import { createPaystackBankTransfersHandler } from "../src/paystack-bank-transfers.js";

const originalFetch = globalThis.fetch;
const originalEnvironment = {
  environment: process.env.PAYSTACK_ENVIRONMENT,
  secret: process.env.PAYSTACK_SECRET_KEY,
  transfers: process.env.PAYSTACK_TRANSFERS_ENABLED,
  runtime: process.env.FLOWPAY_RUNTIME_ENV,
  nodeEnv: process.env.NODE_ENV
};
const senderId = "00000000-0000-4000-8000-000000000001";
const walletId = "00000000-0000-4000-8000-000000000003";
const clearingId = "00000000-0000-4000-8000-000000000007";
const transactionId = "00000000-0000-4000-8000-000000000008";
const accountNumber = "0000000000";
const bankCode = "057";
const amountMinor = "5000000";
const pinSalt = Buffer.from("0123456789abcdef");
const pinHash = scryptSync("123456", pinSalt, 64);
const pair = generateKeyPairSync("ed25519");
const jwk = pair.publicKey.export({ format: "jwk" });
const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "paystack-bank-transfer-test", alg: "EdDSA", use: "sig" }] });

type SetupOptions = {
  balance?: string;
  wrongPin?: boolean;
  existing?: boolean;
  held?: string;
};
function payoutRecord(reference = "flowpay-bnk-00000000000000000000000000000001") {
  return {
    transaction_id: transactionId,
    user_id: senderId,
    account_id: walletId,
    reference,
    recipient_code: "RCP_test123",
    transfer_code: "TRF_test123",
    provider_transfer_id: "987654321",
    amount_minor: amountMinor,
    currency: "NGN",
    bank_code: bankCode,
    bank_name: "Zenith Bank",
    account_name: "Test Customer",
    account_number_last4: "0000",
    account_fingerprint: createHmac("sha256", "sk_test_unit_test_secret").update(accountNumber, "utf8").digest("hex"),
    status: "success",
    provider_status: "success"
  };
}

async function setup(options: SetupOptions = {}) {
  process.env.PAYSTACK_ENVIRONMENT = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_unit_test_secret";
  process.env.PAYSTACK_TRANSFERS_ENABLED = "true";
  process.env.FLOWPAY_RUNTIME_ENV = "development";
  process.env.NODE_ENV = "test";
  const token = await new SignJWT({} satisfies JWTPayload)
    .setProtectedHeader({ alg: "EdDSA", kid: "paystack-bank-transfer-test" })
    .setIssuer("https://flowpay.test")
    .setAudience("flowpay-api")
    .setSubject("neon-auth-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey);

  const statements: { sql: string; values?: unknown[]; client: number }[] = [];
  const ledgerValues: unknown[][] = [];
  let connections = 0;
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM neon_auth."user"')) {
        return { rowCount: 1, rows: [{ id: senderId, email: "test@example.invalid", name: "Test Customer" }] };
      }
      if (sql.includes("FROM public.fp_paystack_bank_transfers") && sql.includes("WHERE idempotency_key")) {
        return options.existing
          ? { rowCount: 1, rows: [payoutRecord()] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes("UPDATE public.fp_paystack_bank_transfers")) {
        statements.push({ sql, values, client: 0 });
        return { rowCount: 1, rows: [] };
      }
      throw new Error("Unexpected pool query: " + sql);
    },
    connect: async () => {
      const clientNumber = ++connections;
      const client = {
        query: async (sql: string, values?: unknown[]) => {
          statements.push({ sql, values, client: clientNumber });
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: 0, rows: [] };
          if (sql.includes("FROM public.fp_transaction_pins")) {
            return {
              rowCount: 1,
              rows: [{
                pin_salt: pinSalt,
                pin_hash: options.wrongPin ? scryptSync("654321", pinSalt, 64) : pinHash,
                failed_attempts: 0,
                locked_until: null
              }]
            };
          }
          if (sql.includes("UPDATE public.fp_transaction_pins")) return { rowCount: 1, rows: [] };
          if (sql.includes("FROM public.fp_accounts") && sql.includes("WHERE user_id = $1")) {
            return { rowCount: 1, rows: [{ id: walletId, status: "active" }] };
          }
          if (sql.includes("FROM public.fp_paystack_bank_transfers") && sql.includes("WHERE idempotency_key")) {
            return options.existing
              ? { rowCount: 1, rows: [payoutRecord()] }
              : { rowCount: 0, rows: [] };
          }
          if (sql.includes("system_account_role = 'paystack_ngn_clearing'")) {
            return { rowCount: 1, rows: [{ id: clearingId }] };
          }
          if (sql.includes("SUM(entry.amount_minor)")) {
            return { rowCount: 1, rows: [{ amount_minor: options.balance ?? "20000000" }] };
          }
          if (sql.includes("SUM(reservation.amount_minor)") && sql.includes("fp_paystack_bank_transfers") && sql.includes("fp_vtpass_bill_payments")) {
            return { rowCount: 1, rows: [{ amount_minor: options.held ?? "0" }] };
          }
          if (sql.includes("INSERT INTO public.fp_ledger_transactions")) {
            return { rowCount: 1, rows: [{ id: transactionId }] };
          }
          if (sql.includes("INSERT INTO public.fp_paystack_bank_transfers")) {
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes("FROM public.fp_paystack_bank_transfers") && sql.includes("FOR UPDATE")) {
            return { rowCount: 1, rows: [payoutRecord(values?.[0] as string)] };
          }
          if (sql.includes("SELECT status FROM public.fp_ledger_transactions")) {
            return { rowCount: 1, rows: [{ status: "pending" }] };
          }
          if (sql.includes("SELECT COUNT(*)::int AS count FROM public.fp_ledger_entries")) {
            return { rowCount: 1, rows: [{ count: 0 }] };
          }
          if (sql.includes("INSERT INTO public.fp_ledger_entries")) {
            ledgerValues.push(values ?? []);
            return { rowCount: 2, rows: [] };
          }
          if (sql.includes("UPDATE public.fp_ledger_transactions") &&
              (sql.includes("SET status = 'posted'") || sql.includes("SET status = 'failed'"))) {
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes("UPDATE public.fp_paystack_bank_transfers")) return { rowCount: 1, rows: [] };
          throw new Error("Unexpected client query #" + clientNumber + ": " + sql);
        },
        release: () => undefined
      };
      return client as unknown as PoolClient;
    }
  } as unknown as Pool;

  const handler = createPaystackBankTransfersHandler({
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
  return { handler, request, response, statements, ledgerValues, connections: () => connections };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    accountNumber,
    bankCode,
    amountMinor,
    idempotencyKey: "00000000-0000-4000-8000-000000000006",
    transactionPin: "123456",
    ...overrides
  };
}

test("requires the explicit sandbox feature switch and never accepts live credentials", async () => {
  const context = await setup();
  delete process.env.PAYSTACK_TRANSFERS_ENABLED;
  const response = context.response();
  await context.handler(context.request("POST", "/customer/transfers/bank", body()), response.res);
  assert.equal(response.result().status, 503);
  assert.equal(response.result().body.error, "PAYSTACK_BANK_PAYOUTS_NOT_ENABLED");
  assert.equal(context.connections(), 0);
});

test("posts a ₦50,000 sandbox bank withdrawal with one balanced wallet debit and clearing credit", async () => {
  const context = await setup();
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
  let reference = "";
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const requestBody = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, method, body: requestBody });
    if (url.startsWith("https://api.paystack.co/bank/resolve?")) {
      assert.ok(url.includes("account_number=" + accountNumber));
      assert.ok(url.includes("bank_code=" + bankCode));
      return new Response(JSON.stringify({ status: true, data: { account_number: accountNumber, account_name: "Test Customer" } }), { status: 200 });
    }
    if (url === "https://api.paystack.co/transferrecipient") {
      return new Response(JSON.stringify({
        status: true,
        data: {
          domain: "test", active: true, type: "nuban", currency: "NGN",
          recipient_code: "RCP_test123",
          details: { bank_name: "Zenith Bank", account_number: accountNumber, bank_code: bankCode }
        }
      }), { status: 200 });
    }
    if (url === "https://api.paystack.co/transfer") {
      reference = String(requestBody.reference);
      return new Response(JSON.stringify({
        status: true,
        data: {
          domain: "test", status: "success", reference, amount: Number(amountMinor), currency: "NGN",
          transfer_code: "TRF_test123", id: 987654321,
          recipient: { recipient_code: "RCP_test123", details: { account_number: accountNumber, bank_code: bankCode } }
        }
      }), { status: 200 });
    }
    if (url.endsWith("/transfer/verify/" + reference)) {
      return new Response(JSON.stringify({
        status: true,
        data: {
          domain: "test", status: "success", reference, amount: Number(amountMinor), currency: "NGN",
          transfer_code: "TRF_test123", id: 987654321,
          recipient: { recipient_code: "RCP_test123", details: { account_number: accountNumber, bank_code: bankCode } }
        }
      }), { status: 200 });
    }
    throw new Error("Unexpected Paystack request: " + method + " " + url);
  };

  const response = context.response();
  await context.handler(context.request("POST", "/customer/transfers/bank", body()), response.res);
  const result = response.result();
  assert.equal(result.status, 201);
  assert.equal(result.body.status, "success");
  assert.equal(result.body.environment, "test");
  assert.equal(result.body.livePayoutsEnabled, false);
  assert.equal(result.body.bankName, "Zenith Bank");
  assert.equal(result.body.accountNumberMasked, "******0000");
  assert.ok(/^flowpay-bnk-[a-f0-9]{32}$/.test(result.body.reference));
  assert.deepEqual(context.ledgerValues, [[transactionId, walletId, "-5000000", clearingId, "5000000"]]);
  const payoutInsert = context.statements.find(item => item.sql.includes("INSERT INTO public.fp_paystack_bank_transfers"));
  assert.ok(payoutInsert);
  assert.ok(payoutInsert.values?.includes("0000"));
  assert.equal(payoutInsert.values?.includes(accountNumber), false);
  assert.equal(calls.filter(item => item.url.endsWith("/transfer")).length, 1);
});

test("insufficient available balance prevents transfer initiation and ledger posting", async () => {
  const context = await setup({ balance: "100" });
  let transferInitiations = 0;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.paystack.co/bank/resolve?")) {
      return new Response(JSON.stringify({ status: true, data: { account_number: accountNumber, account_name: "Test Customer" } }), { status: 200 });
    }
    if (url === "https://api.paystack.co/transferrecipient") {
      return new Response(JSON.stringify({
        status: true,
        data: { domain: "test", active: true, type: "nuban", currency: "NGN", recipient_code: "RCP_test123", details: { bank_name: "Zenith Bank", account_number: accountNumber, bank_code: bankCode } }
      }), { status: 200 });
    }
    if (url === "https://api.paystack.co/transfer") transferInitiations += 1;
    return new Response("{}", { status: 500 });
  };
  const response = context.response();
  await context.handler(context.request("POST", "/customer/transfers/bank", body()), response.res);
  assert.equal(response.result().status, 409);
  assert.equal(response.result().body.error, "INSUFFICIENT_AVAILABLE_BALANCE");
  assert.equal(transferInitiations, 0);
  assert.equal(context.ledgerValues.length, 0);
});


test("pending VTpass bills reduce the available balance for bank transfers", async () => {
  const context = await setup({ balance: "10000000", held: "6000000" });
  let transferInitiations = 0;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://api.paystack.co/bank/resolve?")) {
      return new Response(JSON.stringify({ status: true, data: { account_number: accountNumber, account_name: "Test Customer" } }), { status: 200 });
    }
    if (url === "https://api.paystack.co/transferrecipient") {
      return new Response(JSON.stringify({
        status: true,
        data: { domain: "test", active: true, type: "nuban", currency: "NGN", recipient_code: "RCP_test123", details: { bank_name: "Zenith Bank", account_number: accountNumber, bank_code: bankCode } }
      }), { status: 200 });
    }
    if (url === "https://api.paystack.co/transfer") transferInitiations += 1;
    throw new Error("Unexpected Paystack request: " + url);
  };
  const response = context.response();
  await context.handler(context.request("POST", "/customer/transfers/bank", body()), response.res);
  assert.equal(response.result().status, 409);
  assert.equal(response.result().body.error, "INSUFFICIENT_AVAILABLE_BALANCE");
  assert.equal(response.result().body.availableMinor, "4000000");
  assert.equal(transferInitiations, 0);
  assert.equal(context.ledgerValues.length, 0);
});

test("a definite Paystack rejection releases the reservation without a wallet debit", async () => {
  const context = await setup();
  let transferInitiations = 0;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://api.paystack.co/bank/resolve?")) {
      return new Response(JSON.stringify({ status: true, data: { account_number: accountNumber, account_name: "Test Customer" } }), { status: 200 });
    }
    if (url === "https://api.paystack.co/transferrecipient") {
      return new Response(JSON.stringify({
        status: true,
        data: { domain: "test", active: true, type: "nuban", currency: "NGN", recipient_code: "RCP_test123", details: { bank_name: "Zenith Bank", account_number: accountNumber, bank_code: bankCode } }
      }), { status: 200 });
    }
    if (url === "https://api.paystack.co/transfer") {
      transferInitiations += 1;
      return new Response(JSON.stringify({ status: false, message: "Transfer feature unavailable" }), { status: 400 });
    }
    throw new Error("Unexpected Paystack request: " + url);
  };
  const response = context.response();
  await context.handler(context.request("POST", "/customer/transfers/bank", body()), response.res);
  assert.equal(response.result().status, 202);
  assert.equal(response.result().body.status, "failed");
  assert.equal(response.result().body.final, true);
  assert.equal(transferInitiations, 1);
  assert.equal(context.ledgerValues.length, 0);
  assert.ok(context.statements.some(item => item.sql.includes("SET status = 'failed'")));
});

test("incorrect transaction PIN is rejected before beneficiary creation", async () => {
  const context = await setup({ wrongPin: true });
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response("{}", { status: 500 });
  };
  const response = context.response();
  await context.handler(context.request("POST", "/customer/transfers/bank", body()), response.res);
  assert.equal(response.result().status, 401);
  assert.equal(response.result().body.error, "INVALID_TRANSACTION_PIN");
  assert.equal(providerCalls, 0);
});

test("idempotent retry returns the existing payout without contacting Paystack", async () => {
  const context = await setup({ existing: true });
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response("{}", { status: 500 });
  };
  const response = context.response();
  await context.handler(context.request("POST", "/customer/transfers/bank", body()), response.res);
  assert.equal(response.result().status, 200);
  assert.equal(response.result().body.duplicate, true);
  assert.equal(response.result().body.reference, payoutRecord().reference);
  assert.equal(providerCalls, 0);
});

process.on("exit", () => {
  globalThis.fetch = originalFetch;
  if (originalEnvironment.environment === undefined) delete process.env.PAYSTACK_ENVIRONMENT;
  else process.env.PAYSTACK_ENVIRONMENT = originalEnvironment.environment;
  if (originalEnvironment.secret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
  else process.env.PAYSTACK_SECRET_KEY = originalEnvironment.secret;
  if (originalEnvironment.transfers === undefined) delete process.env.PAYSTACK_TRANSFERS_ENABLED;
  else process.env.PAYSTACK_TRANSFERS_ENABLED = originalEnvironment.transfers;
  if (originalEnvironment.runtime === undefined) delete process.env.FLOWPAY_RUNTIME_ENV;
  else process.env.FLOWPAY_RUNTIME_ENV = originalEnvironment.runtime;
  if (originalEnvironment.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment.nodeEnv;
});
