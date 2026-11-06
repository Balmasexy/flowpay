import { createAuthClient } from "@neondatabase/auth";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";

const authUrl = (import.meta.env.VITE_NEON_AUTH_URL as string | undefined)?.trim();
export const authConfigured = Boolean(authUrl);

// FlowPay and Neon Auth use different origins. Configure cross-origin cookie
// credentials on the adapter itself; this preserves the React adapter's
// concrete client type (useSession, signIn, signUp, and token).
export const authClient = createAuthClient(
  authUrl || "https://invalid-neon-auth-url.invalid",
  {
    adapter: BetterAuthReactAdapter({
      fetchOptions: { credentials: "include" },
    }),
  }
);
