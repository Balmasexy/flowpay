import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createLocalJWKSet, SignJWT, type JWTPayload } from "jose";
import { test } from "node:test";
import { createFlowPayTransfersHandler } from "../src/flowpay-transfers.js";

const senderId = "00000000-0000-4000-8000-000000000001";
const recipientId = "00000000-0000-4000-8000-000000000002";
const recipientAccountNumber = "1234567890";
const registeredName = "FlowPay Registered Customer";
const registeredPhone = "+2348012345678";
const pair = generateKeyPairSync("ed25519");
const publicJwk = pair.publicKey.export({ format: "jwk" });
const jwks = createLocalJWKSet({
  keys: [{ ...publicJwk, kid: "flowpay-recipient-lookup-test", alg: "EdDSA", use: "sig" }]
});

type Options = {
  phoneVerified?: boolean;
  phoneAliasExists?: boolean;
  registeredName?: string | null;
};

async function makeContext(options: Options = {}) {
  const token = await new SignJWT({} satisfies JWTPayload)
    .setProtectedHeader({ alg: "EdDSA", kid: "flowpay-recipient-lookup-test" })
    .setIssuer("https://flowpay.test")
    .setAudience("flowpay-api")
    .setSubject(senderId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey);

  const queries: { sql: string; values?: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes('FROM neon_auth."user" AS auth_user') &&
          sql.includes("JOIN public.fp_users AS app_user")) {
        return { rowCount: 1, rows: [{ id: senderId, name: "Sender" }] };
      }
      if (sql.includes("to_regclass('public.fp_customer_phone_aliases')")) {
        return { rowCount: 1, rows: [{ available: true }] };
      }
      if (sql.includes("FROM public.fp_customer_account_numbers AS account_number")) {
        const isPhoneLookup = values?.[1] === "phone";
        const allowed = !isPhoneLookup ||
          (options.phoneAliasExists !== false && options.phoneVerified !== false);
        const name = options.registeredName === undefined ? registeredName : options.registeredName;
        if (!allowed || !name?.trim()) return { rowCount: 0, rows: [] };
        return {
          rowCount: 1,
          rows: [{
            id: recipientId,
            recipient_name: name,
            account_number: recipientAccountNumber
          }]
        };
      }
      throw new Error("Unexpected recipient lookup query: " + sql);
    },
    connect: async () => { throw new Error("Lookup must not open a ledger transaction."); }
  } as unknown as Pool;

  const handler = createFlowPayTransfersHandler({
    pool,
    jwks: jwks as unknown as ReturnType<typeof import("jose").createRemoteJWKSet>,
    issuer: "https://flowpay.test",
    audience: "flowpay-api"
  });

  const request = (body: Record<string, unknown>) => Object.assign(
    Readable.from([Buffer.from(JSON.stringify(body))]),
    {
      method: "POST",
      url: "/customer/flowpay/recipients/lookup",
      headers: { authorization: "Bearer " + token }
    }
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
  return { handler, request, response, queries };
}

test("phone lookup returns FlowPay and the name saved at customer registration", async () => {
  const context = await makeContext({ phoneVerified: true, phoneAliasExists: true });
  const response = context.response();
  await context.handler(context.request({ phoneNumber: registeredPhone }), response.res);

  const result = response.result();
  assert.equal(result.status, 200);
  assert.equal(result.body.verified, true);
  assert.equal(result.body.institutionName, "FlowPay");
  assert.equal(result.body.recipientName, registeredName);
  assert.equal(result.body.registeredName, registeredName);
  assert.equal(result.body.phoneAliasVerified, true);
  assert.equal(result.body.nameSource, "FlowPay registration");
  assert.equal(result.body.accountNumber, recipientAccountNumber);

  const lookup = context.queries.find(item =>
    item.sql.includes("LEFT JOIN public.fp_customer_phone_aliases")
  );
  assert.ok(lookup);
  assert.ok(lookup?.sql.includes("phone_alias.verified_at IS NOT NULL"));
  assert.ok(lookup?.sql.includes("phoneNumberVerified"));
  assert.ok(lookup?.sql.includes("NULLIF(BTRIM(auth_user.name), '') IS NOT NULL"));
});

test("phone lookup refuses an alias when Neon Auth no longer verifies that phone", async () => {
  const context = await makeContext({ phoneVerified: false, phoneAliasExists: true });
  const response = context.response();
  await context.handler(context.request({ phoneNumber: registeredPhone }), response.res);

  assert.equal(response.result().status, 404);
  assert.equal(response.result().body.error, "FLOWPAY_RECIPIENT_NOT_FOUND");
});

test("phone lookup refuses stale or unlinked phone aliases", async () => {
  const context = await makeContext({ phoneVerified: true, phoneAliasExists: false });
  const response = context.response();
  await context.handler(context.request({ phoneNumber: registeredPhone }), response.res);

  assert.equal(response.result().status, 404);
  assert.equal(response.result().body.error, "FLOWPAY_RECIPIENT_NOT_FOUND");
});

test("phone lookup does not display a fallback name when the registration name is missing", async () => {
  const context = await makeContext({ phoneVerified: true, registeredName: " " });
  const response = context.response();
  await context.handler(context.request({ phoneNumber: registeredPhone }), response.res);

  assert.equal(response.result().status, 404);
  assert.equal(response.result().body.error, "FLOWPAY_RECIPIENT_NOT_FOUND");
});

test("permanent FlowPay ID lookup still returns the same registered account identity", async () => {
  const context = await makeContext();
  const response = context.response();
  await context.handler(context.request({ accountNumber: recipientAccountNumber }), response.res);

  const result = response.result();
  assert.equal(result.status, 200);
  assert.equal(result.body.institutionName, "FlowPay");
  assert.equal(result.body.lookupType, "flowpay_id");
  assert.equal(result.body.recipientName, registeredName);
  assert.equal(result.body.accountNumber, recipientAccountNumber);
});
