import assert from "node:assert/strict";
import { after, test } from "node:test";
import { getPaystackRuntime } from "../src/paystack-mode.js";

const original = {
  nodeEnv: process.env.NODE_ENV,
  environment: process.env.PAYSTACK_ENVIRONMENT,
  secret: process.env.PAYSTACK_SECRET_KEY,
  liveEnabled: process.env.PAYSTACK_LIVE_PAYMENTS_ENABLED
};
function restore(key: keyof typeof original, envKey: string) {
  const value = original[key];
  if (value === undefined) delete process.env[envKey];
  else process.env[envKey] = value;
}
after(() => {
  restore("nodeEnv", "NODE_ENV");
  restore("environment", "PAYSTACK_ENVIRONMENT");
  restore("secret", "PAYSTACK_SECRET_KEY");
  restore("liveEnabled", "PAYSTACK_LIVE_PAYMENTS_ENABLED");
});

test("accepts test credentials only outside production", () => {
  process.env.NODE_ENV = "test";
  process.env.PAYSTACK_ENVIRONMENT = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_unit";
  process.env.PAYSTACK_LIVE_PAYMENTS_ENABLED = "false";
  assert.deepEqual(getPaystackRuntime(), { environment: "test", secretKey: "sk_test_unit" });
  process.env.NODE_ENV = "production";
  assert.equal(getPaystackRuntime(), null);
});

test("accepts live credentials only in production with the explicit live switch", () => {
  process.env.NODE_ENV = "production";
  process.env.PAYSTACK_ENVIRONMENT = "live";
  process.env.PAYSTACK_SECRET_KEY = "sk_live_unit";
  process.env.PAYSTACK_LIVE_PAYMENTS_ENABLED = "false";
  assert.equal(getPaystackRuntime(), null);
  process.env.PAYSTACK_LIVE_PAYMENTS_ENABLED = "true";
  assert.deepEqual(getPaystackRuntime(), { environment: "live", secretKey: "sk_live_unit" });
});

test("rejects a key whose prefix does not match the selected mode", () => {
  process.env.NODE_ENV = "production";
  process.env.PAYSTACK_ENVIRONMENT = "live";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_unit";
  process.env.PAYSTACK_LIVE_PAYMENTS_ENABLED = "true";
  assert.equal(getPaystackRuntime(), null);
  process.env.NODE_ENV = "test";
  process.env.PAYSTACK_ENVIRONMENT = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_live_unit";
  assert.equal(getPaystackRuntime(), null);
});
