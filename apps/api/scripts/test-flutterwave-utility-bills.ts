import test from "node:test";
import assert from "node:assert/strict";
import { classifyFlutterwaveBillStatus, resolveFlutterwaveBillsConfig } from "../src/flutterwave-utility-bills.js";

test("Flutterwave utility bills require an explicitly selected matching environment and key", () => {
  const names = ["NODE_ENV", "FLW_BILLS_ENVIRONMENT", "FLW_BILLS_LIVE_ENABLED", "FLW_SECRET_KEY"];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.NODE_ENV = "production";
    process.env.FLW_BILLS_ENVIRONMENT = "test";
    process.env.FLW_BILLS_LIVE_ENABLED = "false";
    process.env.FLW_SECRET_KEY = "FLWSECK_TEST-sandbox";
    assert.equal(resolveFlutterwaveBillsConfig()?.environment, "test");
    process.env.FLW_BILLS_ENVIRONMENT = "live";
    assert.equal(resolveFlutterwaveBillsConfig(), null);
    process.env.FLW_BILLS_LIVE_ENABLED = "true";
    process.env.FLW_SECRET_KEY = "FLWSECK_LIVE-production";
    assert.equal(resolveFlutterwaveBillsConfig()?.environment, "live");
    process.env.NODE_ENV = "development";
    assert.equal(resolveFlutterwaveBillsConfig(), null);
    process.env.FLW_BILLS_ENVIRONMENT = "test";
    process.env.FLW_SECRET_KEY = "FLWSECK_LIVE-production";
    assert.equal(resolveFlutterwaveBillsConfig(), null);
  } finally {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name]!;
    }
  }
});

test("Flutterwave utility bill success requires matching provider reference and exact NGN amount", () => {
  const successful = {
    status: "success",
    data: { tx_ref: "CF-FLYAPI-123", amount: "24900.00", currency: "NGN", extra: "TOKEN123" }
  };
  assert.equal(classifyFlutterwaveBillStatus(successful, "CF-FLYAPI-123", "2490000"), "success");
  assert.equal(classifyFlutterwaveBillStatus(successful, "CF-FLYAPI-OTHER", "2490000"), "unknown");
  assert.equal(classifyFlutterwaveBillStatus(successful, "CF-FLYAPI-123", "2490001"), "unknown");
  assert.equal(classifyFlutterwaveBillStatus({ status: "pending", data: { tx_ref: "CF-FLYAPI-123" } }, "CF-FLYAPI-123", "2490000"), "pending");
  assert.equal(classifyFlutterwaveBillStatus({ status: "failed", data: { tx_ref: "CF-FLYAPI-123" } }, "CF-FLYAPI-123", "2490000"), "failed");
  assert.equal(classifyFlutterwaveBillStatus({ status: "success", data: { tx_ref: "CF-FLYAPI-123", amount: "24900.00", currency: "USD" } }, "CF-FLYAPI-123", "2490000"), "unknown");
});
