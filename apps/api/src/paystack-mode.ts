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

/**
 * Resolve a correctly matched Paystack API key for safe bank-directory,
 * beneficiary-verification and transfer operations. This deliberately does
 * not depend on PAYSTACK_LIVE_PAYMENTS_ENABLED: the live-deposit switch must
 * not prevent bank lookup or the separately gated bank-payout webhook path.
 * Real live payouts remain independently protected by
 * PAYSTACK_LIVE_TRANSFERS_ENABLED in isPaystackBankPayoutsEnabled().
 */
export function getPaystackBankRuntime(): PaystackRuntime | null {
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
    process.env.NODE_ENV === "production"
  ) {
    return { environment: "live", secretKey };
  }

  return null;
}
