import assert from "node:assert/strict";
import test from "node:test";
import {
  isValidPasskeyPrototypePin,
  isValidPasskeyPrototypeTransferContext,
  passkeyPrototypeContextHash
} from "../src/passkey-prototype.js";

const validContext = {
  accountNumber: "0123456789",
  bankCode: "058",
  amountMinor: "125050",
  idempotencyKey: "00000000-0000-4000-8000-000000000001"
};

test("prototype transaction context accepts valid NGN bank review fields", () => {
  assert.equal(isValidPasskeyPrototypeTransferContext(validContext), true);
});

test("prototype context rejects non-10-digit account numbers", () => {
  assert.equal(isValidPasskeyPrototypeTransferContext({...validContext,accountNumber:"1234"}), false);
});

test("prototype context rejects invalid or zero amounts", () => {
  assert.equal(isValidPasskeyPrototypeTransferContext({...validContext,amountMinor:"0"}), false);
  assert.equal(isValidPasskeyPrototypeTransferContext({...validContext,amountMinor:"1.5"}), false);
  assert.equal(isValidPasskeyPrototypeTransferContext({...validContext,amountMinor:"-100"}), false);
});

test("prototype context rejects malformed idempotency keys and unsupported fields", () => {
  assert.equal(isValidPasskeyPrototypeTransferContext({...validContext,idempotencyKey:"not-a-uuid"}), false);
  assert.equal(isValidPasskeyPrototypeTransferContext({...validContext,transactionPin:"123456"}), false);
});

test("prototype transaction PIN accepts exactly six numeric digits", () => {
  for (const pin of ["000000","123456","999999"]) assert.equal(isValidPasskeyPrototypePin(pin),true);
  for (const pin of ["12345","1234567","12a456"," 12345",""]) assert.equal(isValidPasskeyPrototypePin(pin),false);
});

test("passkey transaction challenge is deterministic for an identical review", () => {
  const first=passkeyPrototypeContextHash(validContext);
  const second=passkeyPrototypeContextHash({...validContext});
  assert.equal(first,second);
  assert.match(first,/^[a-f0-9]{64}$/);
});

test("passkey transaction challenge binds account, bank, amount and idempotency key", () => {
  const original=passkeyPrototypeContextHash(validContext);
  for (const patch of [
    {accountNumber:"9876543210"},
    {bankCode:"011"},
    {amountMinor:"125051"},
    {idempotencyKey:"00000000-0000-4000-8000-000000000002"}
  ]) {
    assert.notEqual(passkeyPrototypeContextHash({...validContext,...patch}),original);
  }
  assert.equal(original.includes(validContext.accountNumber),false);
});
