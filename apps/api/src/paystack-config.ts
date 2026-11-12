export type PaystackEnvironment = "test" | "live";
export type PaystackCredential = { environment: PaystackEnvironment; secretKey: string };

export function getPaystackCredential(environment?: PaystackEnvironment): PaystackCredential | null {
  const configured = (process.env.PAYSTACK_ENVIRONMENT?.trim().toLowerCase() || "test") as PaystackEnvironment;
  const selected = environment ?? configured;
  if (selected !== "test" && selected !== "live") return null;
  if (selected === "live" && process.env.PAYSTACK_LIVE_ENABLED !== "true") return null;

  const prefix = selected === "test" ? "sk_test_" : "sk_live_";
  const raw = selected === "test"
    ? process.env.PAYSTACK_TEST_SECRET_KEY || process.env.PAYSTACK_SECRET_KEY
    : process.env.PAYSTACK_LIVE_SECRET_KEY;
  const secretKey = String(raw || "").trim();
  if (!secretKey.startsWith(prefix)) return null;

  return { environment: selected, secretKey };
}

export function getSelectedPaystackCredential(): PaystackCredential | null {
  const configured = (process.env.PAYSTACK_ENVIRONMENT?.trim().toLowerCase() || "test");
  if (configured !== "test" && configured !== "live") return null;
  return getPaystackCredential(configured);
}

export function paystackReferenceEnvironment(reference: string): PaystackEnvironment | null {
  if (/^flowpay-ps-live-[0-9a-f]{32}$/i.test(reference)) return "live";
  if (/^flowpay-ps-test-[0-9a-f]{32}$/i.test(reference)) return "test";
  // References created before dual-mode support were sandbox-only.
  if (/^flowpay-ps-[0-9a-f]{32}$/i.test(reference)) return "test";
  return null;
}
