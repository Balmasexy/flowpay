import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeNigerianPhone } from "../src/customer-phone-alias.js";

test("normalizes common Nigerian mobile formats to E.164", () => {
  assert.deepEqual(normalizeNigerianPhone("08012345678"), {
    e164: "+2348012345678",
    local: "08012345678"
  });
  assert.deepEqual(normalizeNigerianPhone("+234 801 234 5678"), {
    e164: "+2348012345678",
    local: "08012345678"
  });
  assert.deepEqual(normalizeNigerianPhone("2348012345678"), {
    e164: "+2348012345678",
    local: "08012345678"
  });
});

test("rejects non-Nigerian, landline, short, and non-string values", () => {
  assert.equal(normalizeNigerianPhone("+14155552671"), null);
  assert.equal(normalizeNigerianPhone("0801234567"), null);
  assert.equal(normalizeNigerianPhone("01234567890"), null);
  assert.equal(normalizeNigerianPhone(""), null);
  assert.equal(normalizeNigerianPhone(null), null);
});
