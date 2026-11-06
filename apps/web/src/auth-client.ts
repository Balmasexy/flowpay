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

/**
 * Return a short-lived Neon Auth JWT for FlowPay API requests.
 * Prefer the SDK token endpoint; fall back to the documented JWT response
 * header on getSession() for SDK/adapter versions that omit data.token.
 */
export async function getApiJwt(): Promise<string> {
  let jwt = "";
  let tokenError = "";

  try {
    const result = await authClient.token();
    if (result.error) {
      tokenError = typeof result.error.message === "string"
        ? result.error.message
        : "Neon Auth token endpoint rejected the request.";
    } else if (typeof result.data?.token === "string") {
      jwt = result.data.token;
    }
  } catch (cause) {
    tokenError = cause instanceof Error ? cause.message : "Neon Auth token request failed.";
  }

  if (!jwt) {
    let headerJwt = "";
    const session = await authClient.getSession({
      fetchOptions: {
        onSuccess: (context) => {
          headerJwt = context.response.headers.get("set-auth-jwt") || "";
        },
      },
    });

    if (session.error) {
      const detail = typeof session.error.message === "string"
        ? session.error.message
        : "Neon Auth could not verify this session.";
      throw new Error("Neon Auth session check failed: " + detail);
    }
    if (!session.data?.user) {
      throw new Error("Your Neon Auth sign-in session is no longer active. Please sign in again.");
    }
    jwt = headerJwt;
  }

  if (!jwt.trim() || jwt.split(".").length !== 3) {
    throw new Error(
      tokenError
        ? "Neon Auth confirmed your session but did not return an API access token. " + tokenError
        : "Neon Auth confirmed your session but did not return an API access token."
    );
  }

  return jwt;
}
