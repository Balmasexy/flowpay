import assert from "node:assert/strict";
import { generateKeyPairSync, scryptSync } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { createLocalJWKSet, SignJWT, type JWTPayload } from "jose";
import { test } from "node:test";
import { createFlowPayTransfersHandler } from "../src/flowpay-transfers.js";

const senderId = "00000000-0000-4000-8000-000000000001";
const recipientId = "00000000-0000-4000-8000-000000000002";
const senderWalletId = "00000000-0000-4000-8000-000000000003";
const recipientWalletId = "00000000-0000-4000-8000-000000000004";
const transactionId = "00000000-0000-4000-8000-000000000005";
const recipientAccountNumber = "1234567890";
const idempotencyKey = "00000000-0000-4000-8000-000000000006";
const accountName = "Test Recipient";
const pinSalt = Buffer.from("0123456789abcdef");
const pinHash = scryptSync("123456", pinSalt, 64);
const privateKeyPair = generateKeyPairSync("ed25519");
const publicJwk = privateKeyPair.publicKey.export({ format: "jwk" });
const localJwks = createLocalJWKSet({
  keys: [{ ...publicJwk, kid: "flowpay-transfer-test", alg: "EdDSA", use: "sig" }]
});

type SetupOptions = {
  balance?: string;
  savedPin?: string;
  recipientId?: string;
  prior?: boolean;
  priorAmount?: string;
  priorRecipient?: string;
};

async function makeContext(options: SetupOptions = {}) {
  const token = await new SignJWT({} satisfies JWTPayload)
    .setProtectedHeader({ alg: "EdDSA", kid: "flowpay-transfer-test" })
    .setIssuer("https://flowpay.test")
    .setAudience("flowpay-api")
    .setSubject(senderId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKeyPair.privateKey);

  const statements: { sql: string; values?: unknown[] }[] = [];
  const ledgerValues: unknown[][] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
      if (sql.includes("FROM public.fp_customer_account_numbers AS account_number")) {
        return {
          rowCount: 1,
          rows: [{
            id: options.recipientId ?? recipientId,
            account_number: recipientAccountNumber,
            recipient_name: accountName
          }]
        };
      }
      if (sql.includes("SELECT id FROM public.fp_users") && sql.includes("ORDER BY id FOR UPDATE")) {
        return {
          rowCount: 2,
          rows: [{ id: senderId }, { id: options.recipientId ?? recipientId }]
        };
      }
      if (sql.includes("FROM public.fp_ledger_transactions AS t") &&
          sql.includes("fp_internal_transfer_details") && sql.includes("idempotency_key")) {
        if (!options.prior) return { rowCount: 0, rows: [] };
        return {
          rowCount: 1,
          rows: [{
            id: transactionId, status: "posted", sender_user_id: senderId,
            recipient_user_id: options.priorRecipient ?? recipientId,
            recipient_account_number: recipientAccountNumber,
            amount_minor: options.priorAmount ?? "12345", currency: "NGN",
            reference: "FPW-TEST-REFERENCE"
          }]
        };
      }
      if (sql.includes("FROM public.fp_transaction_pins")) {
        return options.savedPin === "missing"
          ? { rowCount: 0, rows: [] }
          : {
              rowCount: 1,
              rows: [{
                pin_salt: pinSalt,
                pin_hash: options.savedPin === "wrong" ? scryptSync("654321", pinSalt, 64) : pinHash,
                failed_attempts: 0,
                locked_until: null
              }]
            };
      }
      if (sql.includes("FROM public.fp_accounts") && sql.includes("ORDER BY id")) {
        return {
          rowCount: 2,
          rows: [
            { id: senderWalletId, user_id: senderId, status: "active" },
            { id: recipientWalletId, user_id: options.recipientId ?? recipientId, status: "active" }
          ]
        };
      }
      if (sql.includes("COALESCE(SUM(entry.amount_minor)")) {
        return { rowCount: 1, rows: [{ balance_minor: options.balance ?? "500000" }] };
      }
      if (sql.includes("INSERT INTO public.fp_ledger_transactions")) {
        return { rowCount: 1, rows: [{ id: transactionId }] };
      }
      if (sql.includes("INSERT INTO public.fp_internal_transfer_details")) return { rowCount: 1, rows: [] };
      if (sql.includes("INSERT INTO public.fp_ledger_entries")) {
        ledgerValues.push(values ?? []);
        return { rowCount: 2, rows: [] };
      }
      if (sql.includes("UPDATE public.fp_ledger_transactions") && sql.includes("SET status = 'posted'")) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
    release: () => undefined
  };
  const pool = {
    query: async (sql: string) => {
      assert.ok(sql.includes('FROM neon_auth."user"'));
      return { rowCount: 1, rows: [{ id: senderId, name: "Test Sender" }] };
    },
    connect: async () => client
  } as unknown as Pool;

  const handler = createFlowPayTransfersHandler({
    pool,
    jwks: localJwks as unknown as ReturnType<typeof import("jose").createRemoteJWKSet>,
    issuer: "https://flowpay.test",
    audience: "flowpay-api"
  });
  const request = (body: Record<string, unknown>) => Object.assign(
    Readable.from([Buffer.from(JSON.stringify(body))]),
    { method: "POST", url: "/customer/transfers/flowpay", headers: { authorization: "Bearer " + token } }
  ) as unknown as IncomingMessage;
  const response = () => {
    let status = 0;
    let body = "";
    const res = {
      writeHead: (code: number) => { status = code; },
      end: (value?: string) => { body = value ?? ""; }
    } as unknown as ServerResponse;
    return { res, result: () => ({ status, body: body ? JSON.parse(body) : null }) };
  };
  return { handler, request, response, statements, ledgerValues };
}

function transferBody(overrides: Record<string, unknown> = {}) {
  return {
    recipientAccountNumber,
    amountMinor: "12345",
    currency: "NGN",
    idempotencyKey,
    transactionPin: "123456",
    ...overrides
  };
}

test("posts exactly one balanced sender debit and recipient credit", async () => {
  const context = await makeContext();
  const response = context.response();
  assert.equal(await context.handler(context.request(transferBody()), response.res), true);
  const result = response.result();
  assert.equal(result.status, 201);
  assert.equal(result.body.status, "posted");
  assert.equal(result.body.recipientName, accountName);
  assert.equal(context.ledgerValues.length, 1);
  assert.deepEqual(context.ledgerValues[0], [
    transactionId, senderWalletId, "-12345", recipientWalletId, "12345"
  ]);
  assert.ok(context.statements.some(item => item.sql === "COMMIT"));
  assert.ok(context.statements.some(item => item.sql.includes("SET status = 'posted'")));
});

test("does not create a ledger transaction when the sender balance is insufficient", async () => {
  const context = await makeContext({ balance: "100" });
  const response = context.response();
  await context.handler(context.request(transferBody()), response.res);
  assert.equal(response.result().status, 409);
  assert.equal(response.result().body.error, "INSUFFICIENT_AVAILABLE_BALANCE");
  assert.equal(context.ledgerValues.length, 0);
  assert.equal(context.statements.some(item => item.sql.includes("INSERT INTO public.fp_ledger_transactions")), false);
  assert.ok(context.statements.some(item => item.sql === "ROLLBACK"));
});

test("rejects an incorrect transaction PIN without writing ledger entries", async () => {
  const context = await makeContext({ savedPin: "wrong" });
  const response = context.response();
  await context.handler(context.request(transferBody()), response.res);
  assert.equal(response.result().status, 401);
  assert.equal(response.result().body.error, "INVALID_TRANSACTION_PIN");
  assert.equal(context.ledgerValues.length, 0);
  assert.equal(context.statements.some(item => item.sql.includes("INSERT INTO public.fp_ledger_transactions")), false);
  assert.ok(context.statements.some(item => item.sql.includes("failed_attempts = $2")));
});

test("rejects transfers to the sender's own FlowPay account", async () => {
  const context = await makeContext({ recipientId: senderId });
  const response = context.response();
  await context.handler(context.request(transferBody()), response.res);
  assert.equal(response.result().status, 400);
  assert.equal(response.result().body.error, "CANNOT_TRANSFER_TO_SAME_ACCOUNT");
  assert.equal(context.ledgerValues.length, 0);
});

test("returns the saved transaction for an identical idempotent retry without a second posting", async () => {
  const context = await makeContext({ prior: true });
  const response = context.response();
  await context.handler(context.request(transferBody()), response.res);
  assert.equal(response.result().status, 200);
  assert.equal(response.result().body.duplicate, true);
  assert.equal(response.result().body.reference, "FPW-TEST-REFERENCE");
  assert.equal(context.ledgerValues.length, 0);
  assert.equal(context.statements.some(item => item.sql.includes("FROM public.fp_transaction_pins")), false);
});

test("rejects reuse of an idempotency key for different transfer details", async () => {
  const context = await makeContext({ prior: true, priorAmount: "999" });
  const response = context.response();
  await context.handler(context.request(transferBody()), response.res);
  assert.equal(response.result().status, 409);
  assert.equal(response.result().body.error, "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_TRANSFER");
  assert.equal(context.ledgerValues.length, 0);
});

test("requires transaction PIN setup before a wallet transfer", async () => {
  const context = await makeContext({ savedPin: "missing" });
  const response = context.response();
  await context.handler(context.request(transferBody()), response.res);
  assert.equal(response.result().status, 403);
  assert.equal(response.result().body.error, "TRANSACTION_PIN_SETUP_REQUIRED");
  assert.equal(context.ledgerValues.length, 0);
});
