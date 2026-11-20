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
async function postNeonAuth(path: string, body: Record<string, unknown>): Promise<NeonAuthResult> {
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

/** Normalize Nigerian mobile numbers before Neon Auth receives them. */
export function normalizeFlowPayPhone(value: string): string | null {
  const compact = value.trim().replace(/[\s().-]/g, "");
  const digits = compact.startsWith("+") ? compact.slice(1) : compact;
  if (/^0[789]\d{9}$/.test(digits)) return "+234" + digits.slice(1);
  if (/^234[789]\d{9}$/.test(digits)) return "+" + digits;
  if (/^[789]\d{9}$/.test(digits)) return "+234" + digits;
  return null;
}

/** Neon generates and validates this OTP; the configured send.otp webhook delivers it. */
export function sendSignupPhoneCode(phoneNumber: string): Promise<NeonAuthResult> {
  return postNeonAuth("/phone-number/send-otp", { phoneNumber });
}

/** Link the phone to the signed-in, email-verified Neon Auth user only after OTP confirmation. */
export function verifySignupPhoneCode(phoneNumber: string, code: string): Promise<NeonAuthResult> {
  return postNeonAuth("/phone-number/verify", {
    phoneNumber,
    code,
    updatePhoneNumber: true
  });
}

function isJwt(value: unknown): value is string {
  return typeof value === "string" && value.trim().split(".").length === 3;
}

function asAuthRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Neon Auth's browser session cookie is opaque, while FlowPay's API expects
 * the short-lived JWT exposed separately by Managed Auth as access_token.
 * Accept only JWT-shaped values; never send the opaque session cookie as a
 * Bearer token.
 */

const PASSKEY_SESSION_KEY = "flowpay.passkey-session.v1";

export type FlowPayPasskeySession = {
  token: string;
  expiresAt: number;
  user: { id: string; email: string; name: string; image?: string | null };
};

export function readFlowPayPasskeySession(): FlowPayPasskeySession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(PASSKEY_SESSION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    const row = asAuthRecord(value);
    const user = asAuthRecord(row?.user);
    if (!row || !user || !isJwt(row.token) ||
        typeof row.expiresAt !== "number" || row.expiresAt <= Date.now() + 5000 ||
        typeof user.id !== "string" || typeof user.email !== "string" ||
        typeof user.name !== "string") {
      window.sessionStorage.removeItem(PASSKEY_SESSION_KEY);
      return null;
    }
    return {
      token: row.token,
      expiresAt: row.expiresAt,
      user: { id: user.id, email: user.email, name: user.name, image: typeof user.image === "string" ? user.image : null }
    };
  } catch {
    try { window.sessionStorage.removeItem(PASSKEY_SESSION_KEY); } catch { /* storage unavailable */ }
    return null;
  }
}

export function saveFlowPayPasskeySession(value: unknown): FlowPayPasskeySession {
  const row = asAuthRecord(value);
  const user = asAuthRecord(row?.user);
  if (!row || !user || !isJwt(row.accessToken) ||
      typeof row.expiresAt !== "number" ||
      typeof user.id !== "string" || typeof user.email !== "string" ||
      typeof user.name !== "string") {
    throw new Error("The passkey service returned an invalid session.");
  }
  const session: FlowPayPasskeySession = {
    token: row.accessToken,
    expiresAt: row.expiresAt,
    user: { id: user.id, email: user.email, name: user.name, image: typeof user.image === "string" ? user.image : null }
  };
  if (typeof window === "undefined") throw new Error("Passkey sign-in requires a browser session.");
  window.sessionStorage.setItem(PASSKEY_SESSION_KEY, JSON.stringify(session));
  return session;
}

export function clearFlowPayPasskeySession(): void {
  try { window.sessionStorage.removeItem(PASSKEY_SESSION_KEY); } catch { /* storage unavailable */ }
}

export function readNeonApiJwt(value: unknown): string | null {
  const root = asAuthRecord(value);
  if (!root) return null;

  const nestedData = asAuthRecord(root.data);
  const session = asAuthRecord(root.session);
  const nestedSession = asAuthRecord(nestedData?.session);
  const sessionData = asAuthRecord(session?.data);
  const candidates = [
    root.access_token,
    root.accessToken,
    root.token,
    session?.access_token,
    session?.accessToken,
    session?.token,
    nestedSession?.access_token,
    nestedSession?.accessToken,
    nestedSession?.token,
    nestedData?.access_token,
    nestedData?.accessToken,
    nestedData?.token,
    sessionData?.access_token,
    sessionData?.accessToken,
    sessionData?.token,
  ];
  return candidates.find(isJwt) ?? null;
}

/**
 * Return a short-lived Neon Auth JWT for FlowPay API requests.
 * Call the documented Managed Auth /token endpoint directly first. This
 * avoids relying on SDK session-cache behavior for the token response.
 */
export async function getApiJwt(): Promise<string> {
  const passkeySession = readFlowPayPasskeySession();
  if (passkeySession) return passkeySession.token;

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
      const endpointJwt = readNeonApiJwt(payload);
      if (endpointJwt) return endpointJwt;
      endpointError = "Neon Auth token endpoint returned no valid access JWT.";
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
  // Neon Auth's React adapter injects set-auth-jwt into session data. Prefer
  // the typed session token, then fall back to the response header.
  const sessionJwt = readNeonApiJwt(session.data);
  if (sessionJwt) return sessionJwt;
  if (isJwt(headerJwt)) return headerJwt;

  throw new Error(
    "Neon Auth confirmed your session but did not return an API access token. " + endpointError
  );
}
