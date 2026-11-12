import test from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, requestId, serviceAllowed, providerState } from "../src/vtpass-bills.js";

test("normalizes Nigerian phone numbers without accepting malformed values", () => {
  assert.equal(normalizePhone("080 1234 5678"), "08012345678");
  assert.equal(normalizePhone("+2348012345678"), "08012345678");
  assert.equal(normalizePhone("2348012345678"), "08012345678");
  assert.equal(normalizePhone("080123"), "");
  assert.equal(normalizePhone(""), "");
});

test("allows only the configured VTpass airtime, data and electricity services", () => {
  assert.equal(serviceAllowed("airtime", "mtn"), true);
  assert.equal(serviceAllowed("data", "airtel-data"), true);
  assert.equal(serviceAllowed("electricity", "ikeja-electric"), true);
  assert.equal(serviceAllowed("electricity", "unknown-provider"), false);
  assert.equal(serviceAllowed("cable", "dstv"), false);
  assert.equal(serviceAllowed("__proto__", "toString"), false);
});

test("generates a 24-digit Africa/Lagos VTpass request identifier", () => {
  const id = requestId();
  assert.match(id, /^\d{24}$/);
  assert.ok(Number(id.slice(0, 4)) >= 2026);
});

test("classifies VTpass final, pending and unknown provider outcomes", () => {
  assert.equal(providerState({ code: "000", content: { transactions: { status: "delivered" } } }), "success");
  assert.equal(providerState({ code: "099", response_description: "Transaction Pending" }), "pending");
  assert.equal(providerState({ code: "999", response_description: "Unknown response" }), "unknown");
  assert.equal(providerState({ content: { transactions: { status: "reversed" } } }), "reversed");
  assert.equal(providerState({ content: { transactions: { status: "failed" } } }), "failed");
});
