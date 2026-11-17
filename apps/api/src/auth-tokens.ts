import { jwtVerify, type JWTVerifyGetKey } from "jose";

export const FLOWPAY_PASSKEY_JWT_ISSUER = "flowpay-passkey";
export const FLOWPAY_PASSKEY_JWT_AUDIENCE = "flowpay-api";

/**
 * Verify a Neon Managed Auth EdDSA JWT first. FlowPay passkey sessions are
 * short-lived HS256 JWTs issued only after a WebAuthn assertion has passed.
 * Both token types identify the same verified Neon user via sub.
 */
export type FlowPayTokenVerifyOptions = {
  algorithms?: string[];
  issuer?: string;
  audience?: string;
};

export async function verifyFlowPayToken(
  token: string,
  jwks: JWTVerifyGetKey | null,
  options: FlowPayTokenVerifyOptions
) {
  let neonError: unknown = new Error("Neon Auth verification is unavailable.");
  if (jwks && options.issuer) {
    try {
      return await jwtVerify(token, jwks, {
        algorithms: ["EdDSA"],
        issuer: options.issuer,
        ...(options.audience ? { audience: options.audience } : {})
      });
    } catch (error) {
      neonError = error;
    }
  }

  const secret = process.env.FLOWPAY_PASSKEY_JWT_SECRET?.trim() ?? "";
  if (Buffer.byteLength(secret, "utf8") < 32) throw neonError;

  return jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ["HS256"],
    issuer: FLOWPAY_PASSKEY_JWT_ISSUER,
    audience: FLOWPAY_PASSKEY_JWT_AUDIENCE
  });
}
