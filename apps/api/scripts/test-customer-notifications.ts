import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { createLocalJWKSet, SignJWT, type JWTPayload } from "jose";
import { test } from "node:test";
import {
  createCustomerNotificationsHandler,
  enqueueTransferNotification
} from "../src/customer-notifications.js";

const userId = "00000000-0000-4000-8000-000000000001";
const notificationId = "00000000-0000-4000-8000-000000000002";
const transactionId = "00000000-0000-4000-8000-000000000003";
const pair = generateKeyPairSync("ed25519");
const publicJwk = pair.publicKey.export({ format: "jwk" });
const jwks = createLocalJWKSet({
  keys: [{ ...publicJwk, kid: "flowpay-notification-test", alg: "EdDSA", use: "sig" }]
});
const notificationRow = {
  id: notificationId,
  reference: "FPW-TEST",
  transfer_type: "wallet",
  direction: "received",
  status: "success",
  amount_minor: "250000",
  currency: "NGN",
  title: "Money received",
  message: "You received NGN 2,500.00 from FlowPay customer.",
  created_at: new Date("2026-11-13T06:00:00.000Z"),
  read_at: null
};

async function makeContext() {
  const token = await new SignJWT({} satisfies JWTPayload)
    .setProtectedHeader({ alg: "EdDSA", kid: "flowpay-notification-test" })
    .setIssuer("https://flowpay.test")
    .setAudience("flowpay-api")
    .setSubject("neon-auth-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey);
  const statements: { sql: string; values?: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (sql.includes('FROM neon_auth."user"')) return { rowCount: 1, rows: [{ id: userId }] };
      if (sql.includes("SELECT id, reference, transfer_type")) return { rowCount: 1, rows: [notificationRow] };
      if (sql.includes("COUNT(*)::text AS unread_count")) return { rowCount: 1, rows: [{ unread_count: "1" }] };
      if (sql.includes("UPDATE public.fp_customer_notifications")) return { rowCount: 1, rows: [] };
      throw new Error("Unexpected notification query: " + sql);
    }
  } as unknown as Pool;
  const handler = createCustomerNotificationsHandler({
    pool,
    jwks: jwks as unknown as ReturnType<typeof import("jose").createRemoteJWKSet>,
    issuer: "https://flowpay.test",
    audience: "flowpay-api"
  });
  const request = (method: string, url: string, body?: Record<string, unknown>, auth = true) =>
    Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
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
  return { handler, request, response, statements };
}

test("returns only the authenticated customer's notification feed and unread count", async () => {
  const context = await makeContext();
  const response = context.response();
  await context.handler(context.request("GET", "/customer/notifications"), response.res);
  const result = response.result();
  assert.equal(result.status, 200);
  assert.equal(result.body.unreadCount, 1);
  assert.equal(result.body.notifications.length, 1);
  assert.equal(result.body.notifications[0].id, notificationId);
  assert.equal(result.body.notifications[0].status, "success");
  const listQuery = context.statements.find(item => item.sql.includes("SELECT id, reference, transfer_type"));
  assert.equal(listQuery?.values?.[0], userId);
  assert.ok(listQuery?.sql.includes("WHERE user_id = $1"));
});

test("marks only notification IDs owned by the authenticated customer as read", async () => {
  const context = await makeContext();
  const response = context.response();
  await context.handler(context.request("POST", "/customer/notifications/read", {
    ids: [notificationId]
  }), response.res);
  assert.equal(response.result().status, 200);
  assert.equal(response.result().body.markedRead, 1);
  const update = context.statements.find(item => item.sql.includes("UPDATE public.fp_customer_notifications"));
  assert.equal(update?.values?.[0], userId);
  assert.deepEqual(update?.values?.[1], [notificationId]);
  assert.ok(update?.sql.includes("id = ANY($2::uuid[])"));
});

test("rejects missing authentication and malformed notification identifiers", async () => {
  const unauthenticated = await makeContext();
  const noAuth = unauthenticated.response();
  await unauthenticated.handler(unauthenticated.request("GET", "/customer/notifications", undefined, false), noAuth.res);
  assert.equal(noAuth.result().status, 401);

  const invalid = await makeContext();
  const invalidResponse = invalid.response();
  await invalid.handler(invalid.request("POST", "/customer/notifications/read", { ids: ["not-a-uuid"] }), invalidResponse.res);
  assert.equal(invalidResponse.result().status, 400);
  assert.equal(invalidResponse.result().body.error, "VALID_NOTIFICATION_IDS_REQUIRED");
});

test("inserts success, failure and reversal alerts with idempotent event keys", async () => {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      return { rowCount: 1, rows: [] };
    }
  } as unknown as PoolClient;
  for (const status of ["success", "failed", "reversed"] as const) {
    await enqueueTransferNotification(client, {
      userId, eventKey: "bank-transfer:" + status, transactionId,
      reference: "flowpay-bnk-reference", transferType: "bank",
      direction: "sent", status, amountMinor: "500000",
      title: "Bank transfer " + status,
      message: "Transfer status: " + status
    });
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.sql.includes("ON CONFLICT (user_id, event_key) DO NOTHING")));
  assert.deepEqual(calls.map(call => call.values?.[6]), ["success", "failed", "reversed"]);
});
