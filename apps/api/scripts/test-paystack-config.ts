import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { getPaystackCredential, getSelectedPaystackCredential, paystackReferenceEnvironment } from "./paystack-config.js";

const keys = ["PAYSTACK_ENVIRONMENT", "PAYSTACK_TEST_SECRET_KEY", "PAYSTACK_LIVE_SECRET_KEY", "PAYSTACK_SECRET_KEY", "PAYSTACK_LIVE_ENABLED"] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe("FlowPay Paystack dual credentials", () => {
  it("prefers the test-specific key and preserves the old test key fallback", () => {
    process.env.PAYSTACK_ENVIRONMENT = "test";
    process.env.PAYSTACK_TEST_SECRET_KEY = "sk_test_specific";
    process.env.PAYSTACK_SECRET_KEY = "sk_test_legacy";
    assert.deepEqual(getSelectedPaystackCredential(), { environment: "test", secretKey: "sk_test_specific" });
    delete process.env.PAYSTACK_TEST_SECRET_KEY;
    assert.equal(getSelectedPaystackCredential()?.secretKey, "sk_test_legacy");
  });

  it("requires an independent live key and an explicit live enable switch", () => {
    process.env.PAYSTACK_ENVIRONMENT = "live";
    process.env.PAYSTACK_SECRET_KEY = "sk_live_legacy";
    process.env.PAYSTACK_LIVE_SECRET_KEY = "sk_live_dedicated";
    assert.equal(getSelectedPaystackCredential(), null);
    process.env.PAYSTACK_LIVE_ENABLED = "true";
    assert.deepEqual(getSelectedPaystackCredential(), { environment: "live", secretKey: "sk_live_dedicated" });
  });

  it("rejects mismatched prefixes and unknown modes", () => {
    process.env.PAYSTACK_ENVIRONMENT = "test";
    process.env.PAYSTACK_TEST_SECRET_KEY = "sk_live_wrong";
    assert.equal(getSelectedPaystackCredential(), null);
    process.env.PAYSTACK_ENVIRONMENT = "other";
    assert.equal(getSelectedPaystackCredential(), null);
  });

  it("maps dual-mode transaction references and legacy sandbox references", () => {
    assert.equal(paystackReferenceEnvironment("flowpay-ps-live-0123456789abcdef0123456789abcdef"), "live");
    assert.equal(paystackReferenceEnvironment("flowpay-ps-test-0123456789abcdef0123456789abcdef"), "test");
    assert.equal(paystackReferenceEnvironment("flowpay-ps-0123456789abcdef0123456789abcdef"), "test");
    assert.equal(paystackReferenceEnvironment("anything-else"), null);
  });

  it("can resolve an explicit test secret without changing the selected mode", () => {
    process.env.PAYSTACK_ENVIRONMENT = "live";
    process.env.PAYSTACK_LIVE_ENABLED = "true";
    process.env.PAYSTACK_TEST_SECRET_KEY = "sk_test_webhook";
    assert.deepEqual(getPaystackCredential("test"), { environment: "test", secretKey: "sk_test_webhook" });
  });
});
