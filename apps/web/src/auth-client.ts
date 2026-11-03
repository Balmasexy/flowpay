import { createAuthClient } from "@neondatabase/auth";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";

const authUrl = (import.meta.env.VITE_NEON_AUTH_URL as string | undefined)?.trim();
export const authConfigured = Boolean(authUrl);

// Keep the client constructible in local builds; UI stays locked without the public URL.
export const authClient = createAuthClient(
  authUrl || "https://invalid-neon-auth-url.invalid",
  { adapter: BetterAuthReactAdapter() }
);
