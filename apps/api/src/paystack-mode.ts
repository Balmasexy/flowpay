export type PaystackEnvironment = "test" | "live";

export type PaystackRuntime = {
  environment: PaystackEnvironment;
  secretKey: string;
};

export function getPaystackRuntime(): PaystackRuntime | null {
  const environment = process.env.PAYSTACK_ENVIRONMENT;
  const secretKey = process.env.PAYSTACK_SECRET_KEY?.trim() ?? "";

  if (
    environment === "test" &&
    secretKey.startsWith("sk_test_") &&
    process.env.NODE_ENV !== "production"
  ) {
    return { environment: "test", secretKey };
  }

  if (
    environment === "live" &&
    secretKey.startsWith("sk_live_") &&
    process.env.NODE_ENV === "production" &&
    process.env.PAYSTACK_LIVE_PAYMENTS_ENABLED === "true"
  ) {
    return { environment: "live", secretKey };
  }

  return null;
}
