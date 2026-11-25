import test from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, requestId, serviceAllowed, providerState, resolveVtpassConfig } from "../src/vtpass-bills.js";

test("normalizes Nigerian phone numbers without accepting malformed values", () => {
  assert.equal(normalizePhone("080 1234 5678"), "08012345678");
  assert.equal(normalizePhone("+2348012345678"), "08012345678");
  assert.equal(normalizePhone("2348012345678"), "08012345678");
  assert.equal(normalizePhone("080123"), "");
  assert.equal(normalizePhone(""), "");
});

test("allows only configured VTpass airtime, data, electricity and cable TV services", () => {
  assert.equal(serviceAllowed("airtime", "mtn"), true);
  assert.equal(serviceAllowed("data", "airtel-data"), true);
  assert.equal(serviceAllowed("electricity", "ikeja-electric"), true);
  assert.equal(serviceAllowed("electricity", "unknown-provider"), false);
  assert.equal(serviceAllowed("cabletv", "dstv"), true);
  assert.equal(serviceAllowed("cabletv", "gotv"), true);
  assert.equal(serviceAllowed("cabletv", "startimes"), true);
  assert.equal(serviceAllowed("cabletv", "unknown-tv-provider"), false);
  assert.equal(serviceAllowed("cable", "dstv"), false);
  assert.equal(serviceAllowed("__proto__", "toString"), false);
});

test("generates a 24-digit Africa/Lagos VTpass request identifier", () => {
  const id = requestId();
  assert.match(id, /^\\d{24}$/);
  assert.ok(Number(id.slice(0, 4)) >= 2026);
});

test("classifies VTpass final, pending and unknown provider outcomes", () => {
  assert.equal(providerState({ code: "000", content: { transactions: { status: "delivered" } } }), "success");
  assert.equal(providerState({ code: "099", response_description: "Transaction Pending" }), "pending");
  assert.equal(providerState({ code: "999", response_description: "Unknown response" }), "unknown");
  assert.equal(providerState({ content: { transactions: { status: "reversed" } } }), "reversed");
  assert.equal(providerState({ content: { transactions: { status: "failed" } } }), "failed");
});

test("allows explicit VTpass sandbox credentials on the production Render runtime", () => {
  const names = ["NODE_ENV", "VTPASS_ENVIRONMENT", "VTPASS_API_KEY", "VTPASS_PUBLIC_KEY", "VTPASS_SECRET_KEY", "VTPASS_LIVE_ENABLED"];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.NODE_ENV = "production";
    process.env.VTPASS_ENVIRONMENT = "sandbox";
    process.env.VTPASS_API_KEY = "sandbox-api";
    process.env.VTPASS_PUBLIC_KEY = "sandbox-public";
    process.env.VTPASS_SECRET_KEY = "sandbox-secret";
    process.env.VTPASS_LIVE_ENABLED = "false";
    const config = resolveVtpassConfig();
    assert.equal(config?.environment, "sandbox");
    assert.equal(config?.baseUrl, "https://sandbox.vtpass.com/api");
  } finally {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name]!;
    }
  }
});

test("keeps VTpass live mode disabled unless the explicit live switch is enabled", () => {
  const names = ["NODE_ENV", "VTPASS_ENVIRONMENT", "VTPASS_API_KEY", "VTPASS_PUBLIC_KEY", "VTPASS_SECRET_KEY", "VTPASS_LIVE_ENABLED"];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.NODE_ENV = "production";
    process.env.VTPASS_ENVIRONMENT = "live";
    process.env.VTPASS_API_KEY = "live-api";
    process.env.VTPASS_PUBLIC_KEY = "live-public";
    process.env.VTPASS_SECRET_KEY = "live-secret";
    process.env.VTPASS_LIVE_ENABLED = "false";
    assert.equal(resolveVtpassConfig(), null);
  } finally {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name]!;
    }
  }
});
