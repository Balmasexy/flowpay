# FlowPay customer authentication

## Sign-in methods

- Email and password remain the normal FlowPay sign-in method.
- Google sign-in uses the configured Neon Managed Auth social provider and returns to `/dashboard`.
- Email one-time codes are reserved for sign-up verification and password recovery; they are not a replacement for a normal password login.
- After a successful authenticated session, the existing customer bootstrap flow provisions or attaches the FlowPay customer record and account number. The browser does not create balances or payment records.

## Deployment configuration

The web build requires `VITE_NEON_AUTH_URL` to point to the Auth endpoint belonging to the same Neon branch as the production database. Production currently uses the main branch in the Neon project named FlowPay Production:

```env
VITE_NEON_AUTH_URL=https://ep-weathered-dust-akai74ps.neonauth.c-3.us-west-2.aws.neon.tech/flowpay/auth
```

The production Auth configuration must retain the FlowPay web origin in its trusted origins list and keep the Google social provider enabled. Do not expose OAuth client secrets or database credentials to the browser.

## Fingerprint and passkey status

The login page must not claim that a fingerprint scan authenticates a customer unless a server verifies a WebAuthn passkey challenge. Device biometrics are a local user-verification ceremony; they are not an authentication backend by themselves.

FlowPay currently uses Neon Managed Auth. Neon documents that Managed Auth does not currently support bringing custom Better Auth server plugins. The managed branch configuration does not expose a passkey plugin, so a client-only passkey button would fail and could mislead customers. The login UI therefore displays the future passkey option as unavailable until the authentication provider supports the required server-side WebAuthn plugin or FlowPay completes a separately reviewed migration to a compatible auth server.

Do not add client-only passkey registration, store reusable login tokens as a substitute, or bypass Neon Auth session validation to make the button appear functional.
