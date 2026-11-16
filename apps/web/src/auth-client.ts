import { createAuthClient } from "@neondatabase/auth";
import { emailOTPClient } from "better-auth/client/plugins";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";

const authUrl = (import.meta.env.VITE_NEON_AUTH_URL as string | undefined)?.trim().replace(/\/$/, "");
export const authConfigured = Boolean(authUrl);

// FlowPay and Neon Auth use different origins. Configure cross-origin cookie
// credentials on the adapter itself; add the official Email OTP client plugin
// for the recovery and signup verification endpoints used by FlowPay.
export const authClient = createAuthClient(
  authUrl || "https://invalid-neon-auth-url.invalid",
  {
    adapter: BetterAuthReactAdapter({
      fetchOptions: { credentials: "include" },
    }),
    plugins: [emailOTPClient()],
  }
);

function isJwt(value: unknown): value is string {
  return typeof value === "string" && value.trim().split(".").length === 3;
}

/**
 * Return a short-lived Neon Auth JWT for FlowPay API requests.
 * Call the documented Managed Auth /token endpoint directly first. This
 * avoids relying on SDK session-cache behavior for the token response.
 */
export async function getApiJwt(): Promise<string> {
  if (!authUrl) {
    throw new Error("Neon Auth is not configured on this deployment.");
  }

  let endpointError = "";
  try {
    const response = await fetch(authUrl + "/token", {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      if (payload && typeof payload === "object" && "token" in payload && isJwt(payload.token)) {
        return payload.token;
      }
      endpointError = "Neon Auth token endpoint returned no valid JWT.";
    } else {
      endpointError = "Neon Auth token endpoint returned HTTP " + response.status + ".";
    }
  } catch {
    endpointError = "FlowPay could not reach the Neon Auth token endpoint.";
  }

  // Some Better Auth deployments return the session JWT in this header.
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
  if (isJwt(headerJwt)) return headerJwt;

  throw new Error(
    "Neon Auth confirmed your session but did not return an API access token. " + endpointError
  );
}
