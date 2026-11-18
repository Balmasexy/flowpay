import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyFlutterwaveBillStatus,
  flutterwaveBillWalletDebitMinor,
  resolveFlutterwaveBillsConfig
} from "../src/flutterwave-utility-bills.js";

test("Flutterwave utility bills require an explicitly selected matching environment and key", () => {
  const names = ["NODE_ENV", "FLOWPAY_RUNTIME_ENV", "FLW_BILLS_ENVIRONMENT", "FLW_BILLS_LIVE_ENABLED", "FLW_SECRET_KEY"];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.NODE_ENV = "development";
    process.env.FLOWPAY_RUNTIME_ENV = "development";
    process.env.FLW_BILLS_ENVIRONMENT = "test";
    process.env.FLW_BILLS_LIVE_ENABLED = "false";
    process.env.FLW_SECRET_KEY = "FLWSECK_TEST-sandbox";
    assert.equal(resolveFlutterwaveBillsConfig()?.environment, "test");
    process.env.NODE_ENV = "production";
    assert.equal(resolveFlutterwaveBillsConfig(), null);
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
    data: { tx_ref: "CF-FLYAPI-123", amount: "24900.00", fee: 100, currency: "NGN", extra: "TOKEN123" }
  };
  assert.equal(classifyFlutterwaveBillStatus(successful, "CF-FLYAPI-123", "2490000", "10000"), "success");
  assert.equal(classifyFlutterwaveBillStatus({ ...successful, data: { ...successful.data, amount: "24900.0000" } }, "CF-FLYAPI-123", "2490000", "10000"), "success");
  assert.equal(classifyFlutterwaveBillStatus({ ...successful, data: { ...successful.data, amount: "24900.0010" } }, "CF-FLYAPI-123", "2490000", "10000"), "unknown");
  assert.equal(classifyFlutterwaveBillStatus(successful, "CF-FLYAPI-OTHER", "2490000", "10000"), "unknown");
  assert.equal(classifyFlutterwaveBillStatus({ ...successful, data: { ...successful.data, fee: 101 } }, "CF-FLYAPI-123", "2490000", "10000"), "unknown");
  assert.equal(classifyFlutterwaveBillStatus(successful, "CF-FLYAPI-123", "2490001", "10000"), "unknown");
  const matchingStatusData = { tx_ref: "CF-FLYAPI-123", amount: "24900.00", fee: 100, currency: "NGN" };
  assert.equal(classifyFlutterwaveBillStatus({ status: "pending", data: matchingStatusData }, "CF-FLYAPI-123", "2490000", "10000"), "pending");
  assert.equal(classifyFlutterwaveBillStatus({ status: "failed", data: matchingStatusData }, "CF-FLYAPI-123", "2490000", "10000"), "failed");
  assert.equal(classifyFlutterwaveBillStatus({ status: "failed", data: { ...matchingStatusData, tx_ref: "OTHER" } }, "CF-FLYAPI-123", "2490000", "10000"), "unknown");
  assert.equal(classifyFlutterwaveBillStatus({ status: "failed", data: { ...matchingStatusData, amount: "1.00" } }, "CF-FLYAPI-123", "2490000", "10000"), "unknown");
  assert.equal(classifyFlutterwaveBillStatus({ status: "success", data: { tx_ref: "CF-FLYAPI-123", amount: "24900.00", fee: 100, currency: "USD" } }, "CF-FLYAPI-123", "2490000", "10000"), "unknown");
});

test("reserves the complete customer bill debit including Flutterwave fee", () => {
  assert.equal(flutterwaveBillWalletDebitMinor("2490000", "10000"), "2500000");
  assert.equal(flutterwaveBillWalletDebitMinor("2490000", "0"), "2490000");
  assert.throws(() => flutterwaveBillWalletDebitMinor("0", "100"), /INVALID_FLUTTERWAVE_BILL_AMOUNT/);
  assert.throws(() => flutterwaveBillWalletDebitMinor("2490000", "-1"), /INVALID_FLUTTERWAVE_BILL_AMOUNT/);
  assert.throws(() => flutterwaveBillWalletDebitMinor("9999999999", "1"), /FLUTTERWAVE_BILL_TOTAL_OUT_OF_RANGE/);
});
