import { createAuthClient } from "@neondatabase/auth";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";

const authUrl = (import.meta.env.VITE_NEON_AUTH_URL as string | undefined)?.trim();
export const authConfigured = Boolean(authUrl);

// FlowPay's web app and Neon Auth are on different origins. Include the
// browser session cookie so authClient.token() can exchange the session for
// a short-lived API JWT. Without credentials, Neon returns data.token undefined.
export const authClient = createAuthClient(
  authUrl || "https://invalid-neon-auth-url.invalid",
  {
    adapter: BetterAuthReactAdapter(),
    fetchOptions: { credentials: "include" },
  }
);
