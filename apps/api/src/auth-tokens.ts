import { decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from "jose";

export const FLOWPAY_PASSKEY_JWT_ISSUER = "flowpay-passkey";
export const FLOWPAY_PASSKEY_JWT_AUDIENCE = "flowpay-api";

export type FlowPayTokenVerifyOptions = {
  algorithms?: string[];
  issuer?: string;
  audience?: string;
};

function invalidToken(message: string): Error {
  const error = new Error(message);
  error.name = "JWTInvalid";
  return error;
}

/**
 * Neon Managed Auth uses EdDSA/Ed25519 and the project's own JWKS.
 * FlowPay's verified WebAuthn ceremony issues HS256 tokens with a separate
 * application secret. Select the verifier from the JWT header; never fall
 * through from a mismatched Neon key to the passkey secret. This prevents an
 * old token from a different Neon project from being misreported as an
 * unsupported algorithm or accidentally accepted by the wrong verifier.
 */
export async function verifyFlowPayToken(
  token: string,
  jwks: JWTVerifyGetKey | null,
  options: FlowPayTokenVerifyOptions
) {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw invalidToken("The supplied authentication token is malformed.");
  }

  if (header.alg === "EdDSA") {
    if (!jwks || !options.issuer) {
      throw invalidToken("Neon Auth verification is not configured for this project.");
    }
    try {
      // Let jose enforce the algorithm compatible with the signing key returned
      // by Neon's configured JWKS. Do not pin a guessed algorithm here: Neon
      // access-token signing configuration may change independently.
      return await jwtVerify(token, jwks, {
        issuer: options.issuer,
        ...(options.audience ? { audience: options.audience } : {})
      });
    } catch (error) {
      if (error instanceof Error && error.name === "JWKSNoMatchingKey") {
        throw invalidToken("This Neon Auth token was issued by a different Auth project or signing-key set.");
      }
      throw error;
    }
  }

  if (header.alg === "HS256") {
    const secret = process.env.FLOWPAY_PASSKEY_JWT_SECRET?.trim() ?? "";
    if (Buffer.byteLength(secret, "utf8") < 32) {
      const error = new Error("FlowPay passkey authentication is not configured.");
      error.name = "PASSKEY_AUTH_NOT_CONFIGURED";
      throw error;
    }
    return jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
      issuer: FLOWPAY_PASSKEY_JWT_ISSUER,
      audience: FLOWPAY_PASSKEY_JWT_AUDIENCE
    });
  }

  throw invalidToken("The authentication token uses an unsupported signing algorithm.");
}
