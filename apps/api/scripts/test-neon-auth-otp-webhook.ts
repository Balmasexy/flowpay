import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import {
  createNeonAuthOtpWebhookHandler,
  verifyNeonWebhookSignature
} from "../src/neon-auth-otp-webhook.js";

const keyPair = generateKeyPairSync("ed25519");
const publicJwk = keyPair.publicKey.export({ format: "jwk" });
const kid = "flowpay-neon-auth-test";
const jwks = { keys: [{ ...publicJwk, kid, alg: "EdDSA", use: "sig" }] };
const originalFetch = globalThis.fetch;

function makeSignature(rawBody: string, timestamp = String(Date.now())) {
  const protectedHeader = Buffer.from(JSON.stringify({ alg: "EdDSA", kid })).toString("base64url");
  const payloadB64 = Buffer.from(rawBody, "utf8").toString("base64url");
  const timestampPayloadB64 = Buffer.from(timestamp + "." + payloadB64, "utf8").toString("base64url");
  const signingInput = Buffer.from(protectedHeader + "." + timestampPayloadB64, "utf8");
  const signature = sign(null, signingInput, keyPair.privateKey).toString("base64url");
  return { signature: protectedHeader + ".." + signature, timestamp };
}

function makeRequest(payload: Record<string, unknown>, timestamp?: string) {
  const rawBody = JSON.stringify(payload);
  const signed = makeSignature(rawBody, timestamp);
  const request = Object.assign(Readable.from([Buffer.from(rawBody)]), {
    method: "POST",
    url: "/webhooks/neon-auth/otp",
    headers: {
      "x-neon-signature": signed.signature,
      "x-neon-signature-kid": kid,
      "x-neon-timestamp": signed.timestamp
    }
  }) as unknown as IncomingMessage;
  let status = 0;
  let responseBody = "";
  const response = {
    writeHead: (code: number) => { status = code; },
    end: (value?: string) => { responseBody = value ?? ""; }
  } as unknown as ServerResponse;
  return {
    request,
    response,
    result: () => ({ status, body: responseBody ? JSON.parse(responseBody) : null }),
    rawBody,
    signature: signed.signature,
    timestamp: signed.timestamp
  };
}

test("validates Neon detached EdDSA signatures and rejects tampering", () => {
  const raw = JSON.stringify({ event_type: "send.otp", event_data: { otp_code: "123456" } });
  const signed = makeSignature(raw);
  assert.equal(verifyNeonWebhookSignature(raw, signed.signature, signed.timestamp, publicJwk), true);
  assert.equal(verifyNeonWebhookSignature(raw + " ", signed.signature, signed.timestamp, publicJwk), false);
  assert.equal(verifyNeonWebhookSignature(raw, signed.signature, String(Date.now() - 600_000), publicJwk), false);
});

test("routes Neon phone OTP events to Termii without generating or verifying a second OTP", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://neon-auth.test/.well-known/jwks.json") {
      return new Response(JSON.stringify(jwks), { status: 200 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, body });
    return new Response(JSON.stringify({ message_id: "termii-message-1" }), { status: 200 });
  };
  const handler = createNeonAuthOtpWebhookHandler({
    jwksUrl: "https://neon-auth.test/.well-known/jwks.json",
    termiiApiKey: "termii-test-key",
    termiiBaseUrl: "https://api.ng.termii.com",
    termiiChannel: "dnd"
  });
  const context = makeRequest({
    event_type: "send.otp",
    user: { id: "neon-user-1" },
    event_data: {
      phone_number: "+2348012345678",
      otp_code: "123456",
      otp_type: "phone-number-verification",
      delivery_preference: "sms"
    }
  });
  try {
    assert.equal(await handler(context.request, context.response), true);
    assert.equal(context.result().status, 200);
    assert.deepEqual(context.result().body, { success: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.ng.termii.com/api/sms/send");
    assert.equal(calls[0].body.to, "2348012345678");
    assert.equal(calls[0].body.from, "FLOWPAY");
    assert.match(String(calls[0].body.sms), /123456/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("routes Neon email OTP events to Resend so enabling send.otp does not break email verification", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://neon-auth.test/.well-known/jwks.json") {
      return new Response(JSON.stringify(jwks), { status: 200 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, body });
    return new Response(JSON.stringify({ id: "resend-email-1" }), { status: 200 });
  };
  const handler = createNeonAuthOtpWebhookHandler({
    jwksUrl: "https://neon-auth.test/.well-known/jwks.json",
    resendApiKey: "re_test_key",
    emailFrom: "FlowPay <auth@example.com>"
  });
  const context = makeRequest({
    event_type: "send.otp",
    user: { email: "customer@example.com", name: "FlowPay Customer" },
    event_data: { otp_code: "654321", otp_type: "email-verification" }
  });
  try {
    assert.equal(await handler(context.request, context.response), true);
    assert.equal(context.result().status, 200);
    assert.deepEqual(context.result().body, { success: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.deepEqual(calls[0].body.to, ["customer@example.com"]);
    assert.match(String(calls[0].body.html), /654321/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

process.on("exit", () => {
  globalThis.fetch = originalFetch;
});
