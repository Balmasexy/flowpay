import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import {
  FLOWPAY_PASSKEY_JWT_AUDIENCE,
  FLOWPAY_PASSKEY_JWT_ISSUER,
  verifyFlowPayToken
} from "../src/auth-tokens.js";

const secret = "flowpay-passkey-test-secret-0123456789abcdef0123456789abcdef";
const encoder = new TextEncoder();

test("accepts a valid short-lived FlowPay WebAuthn token", async () => {
  const token = await new SignJWT({ amr: ["webauthn"] })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(FLOWPAY_PASSKEY_JWT_ISSUER)
    .setAudience(FLOWPAY_PASSKEY_JWT_AUDIENCE)
    .setSubject("verified-neon-user")
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(encoder.encode(secret));

  const previous = process.env.FLOWPAY_PASSKEY_JWT_SECRET;
  process.env.FLOWPAY_PASSKEY_JWT_SECRET = secret;
  try {
    const result = await verifyFlowPayToken(token, null, { algorithms: ["EdDSA"], issuer: "neon-managed-auth" });
    assert.equal(result.payload.sub, "verified-neon-user");
    assert.equal(result.payload.iss, FLOWPAY_PASSKEY_JWT_ISSUER);
    assert.equal(result.payload.aud, FLOWPAY_PASSKEY_JWT_AUDIENCE);
  } finally {
    if (previous === undefined) delete process.env.FLOWPAY_PASSKEY_JWT_SECRET;
    else process.env.FLOWPAY_PASSKEY_JWT_SECRET = previous;
  }
});

test("rejects a FlowPay passkey token signed with the wrong secret", async () => {
  const token = await new SignJWT({ amr: ["webauthn"] })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(FLOWPAY_PASSKEY_JWT_ISSUER)
    .setAudience(FLOWPAY_PASSKEY_JWT_AUDIENCE)
    .setSubject("verified-neon-user")
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(encoder.encode(secret));

  const previous = process.env.FLOWPAY_PASSKEY_JWT_SECRET;
  process.env.FLOWPAY_PASSKEY_JWT_SECRET = "a-different-test-secret-that-is-also-at-least-32-bytes";
  try {
    await assert.rejects(
      verifyFlowPayToken(token, null, { algorithms: ["EdDSA"], issuer: "neon-managed-auth" })
    );
  } finally {
    if (previous === undefined) delete process.env.FLOWPAY_PASSKEY_JWT_SECRET;
    else process.env.FLOWPAY_PASSKEY_JWT_SECRET = previous;
  }
});

test("rejects a Neon token signed by a different project's JWKS without passkey fallback", async () => {
  const expectedPair = await generateKeyPair("EdDSA");
  const otherPair = await generateKeyPair("EdDSA");
  const jwk = await exportJWK(otherPair.publicKey);
  jwk.alg = "EdDSA";
  jwk.use = "sig";
  const wrongProjectJwks = createLocalJWKSet({ keys: [jwk] });
  const token = await new SignJWT({ email: "customer@example.invalid" })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer("https://neon-auth.example.invalid")
    .setAudience("https://neon-auth.example.invalid")
    .setSubject("verified-neon-user")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(expectedPair.privateKey);

  const previous = process.env.FLOWPAY_PASSKEY_JWT_SECRET;
  process.env.FLOWPAY_PASSKEY_JWT_SECRET = secret;
  try {
    await assert.rejects(
      verifyFlowPayToken(token, wrongProjectJwks, {
        algorithms: ["EdDSA"],
        issuer: "https://neon-auth.example.invalid",
        audience: "https://neon-auth.example.invalid"
      }),
      error => error instanceof Error && error.name === "JWTInvalid"
    );
  } finally {
    if (previous === undefined) delete process.env.FLOWPAY_PASSKEY_JWT_SECRET;
    else process.env.FLOWPAY_PASSKEY_JWT_SECRET = previous;
  }
});

test("continues to accept the existing Neon EdDSA access JWT", async () => {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const jwk = await exportJWK(publicKey);
  jwk.alg = "EdDSA";
  jwk.use = "sig";
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const token = await new SignJWT({ email: "customer@example.invalid" })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer("https://neon.example.invalid/flowpay/auth")
    .setSubject("verified-neon-user")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  const result = await verifyFlowPayToken(token, jwks, {
    algorithms: ["EdDSA"],
    issuer: "https://neon.example.invalid/flowpay/auth"
  });
  assert.equal(result.payload.sub, "verified-neon-user");
});
