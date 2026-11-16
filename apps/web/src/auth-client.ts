import { createAuthClient } from "@neondatabase/auth";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";

const authUrl = (import.meta.env.VITE_NEON_AUTH_URL as string | undefined)?.trim().replace(/\/$/, "");
export const authConfigured = Boolean(authUrl);

// FlowPay and Neon Auth use different origins. Configure cross-origin cookie
// credentials on the adapter itself. Neon manages the server-side auth
// configuration; FlowPay calls its documented OTP endpoints directly.
export const authClient = createAuthClient(
  authUrl || "https://invalid-neon-auth-url.invalid",
  {
    adapter: BetterAuthReactAdapter({
      fetchOptions: { credentials: "include" },
    }),
  }
);

export type NeonAuthResult = {
  data: unknown | null;
  error: { message: string } | null;
};

/** Call a documented Neon Managed Auth endpoint using the browser session cookie. */
async function postNeonAuth(path: string, body: Record<string, string>): Promise<NeonAuthResult> {
  if (!authUrl) {
    return { data: null, error: { message: "Authentication is not configured on this deployment." } };
  }

  try {
    const response = await fetch(authUrl + path, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const item = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const nested = item.error && typeof item.error === "object" ? item.error as Record<string, unknown> : {};
      const message = [nested.message, item.message, item.error_description]
        .find(value => typeof value === "string" && value.trim());
      return { data: null, error: { message: typeof message === "string" ? message : "Neon Auth rejected the request (HTTP " + response.status + ")." } };
    }
    return { data: payload, error: null };
  } catch {
    return { data: null, error: { message: "FlowPay could not reach Neon Auth. Please try again." } };
  }
}

export function requestPasswordRecoveryCode(email: string): Promise<NeonAuthResult> {
  return postNeonAuth("/email-otp/send-verification-otp", { email, type: "forget-password" });
}

export function resetPasswordWithRecoveryCode(email: string, otp: string, password: string): Promise<NeonAuthResult> {
  return postNeonAuth("/email-otp/reset-password", { email, otp, password });
}

export function verifySignupEmailCode(email: string, otp: string): Promise<NeonAuthResult> {
  return postNeonAuth("/email-otp/verify-email", { email, otp });
}

export function sendSignupEmailCode(email: string): Promise<NeonAuthResult> {
  return postNeonAuth("/email-otp/send-verification-otp", { email, type: "email-verification" });
}

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
