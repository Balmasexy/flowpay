import { createAuthClient } from "@neondatabase/auth";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";

const authUrl = (import.meta.env.VITE_NEON_AUTH_URL as string | undefined)?.trim();
export const authConfigured = Boolean(authUrl);

// FlowPay's web app and Neon Auth are on different origins. Include the
// browser session cookie so authClient.token() can exchange the session for
// a short-lived API JWT. Without credentials, Neon returns data.token undefined.
// The installed Neon SDK types omit fetchOptions from NeonAuthConfig, while
// the Managed Auth runtime supports Better Auth fetch options. Keep the
// documented cross-origin cookie behavior without changing auth methods.
const authOptions = {
  adapter: BetterAuthReactAdapter(),
  fetchOptions: { credentials: "include" as const },
} as Parameters<typeof createAuthClient>[1];

export const authClient = createAuthClient(
  authUrl || "https://invalid-neon-auth-url.invalid",
  authOptions
);
