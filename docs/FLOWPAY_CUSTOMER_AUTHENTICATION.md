# FlowPay customer authentication

## Sign-in methods

- Email and password remain available through Neon Managed Auth.
- Google sign-in uses the shared Google provider and returns to `/dashboard`.
- Email one-time codes are used for sign-up email verification and password recovery; they are not required for ordinary password login.
- Accounts created using Google can establish an email/password credential through the Forgot Password flow.
- A successful sign-in must produce a Neon Managed Auth JWT that the FlowPay API verifies against the JWKS for the same Auth project.

## Active Render configuration

The active Render frontend and backend are intentionally aligned to the existing FlowPay customer/Auth dataset so the already-created verified customer profile, FlowPay transfer number and NGN wallet remain available.

```env
# Frontend build
VITE_NEON_AUTH_URL=https://ep-quiet-grass-zabt9514.neonauth.c-2.eu-west-2.aws.neon.tech/flowpay/auth
VITE_API_BASE_URL=https://flowpay-backend-qz79.onrender.com

# Backend
NEON_AUTH_JWKS_URL=https://ep-quiet-grass-zabt9514.neonauth.c-2.eu-west-2.aws.neon.tech/flowpay/auth/.well-known/jwks.json
NEON_AUTH_ISSUER=https://ep-quiet-grass-zabt9514.neonauth.c-2.eu-west-2.aws.neon.tech/flowpay/auth
NEON_AUTH_AUDIENCE=https://ep-quiet-grass-zabt9514.neonauth.c-2.eu-west-2.aws.neon.tech/flowpay/auth
WEB_ORIGIN=https://flowpay-web-jx7i.onrender.com
FLOWPAY_WEBAUTHN_ORIGIN=https://flowpay-web-jx7i.onrender.com
FLOWPAY_WEBAUTHN_RP_ID=flowpay-web-jx7i.onrender.com
```

**Critical invariant:** the frontend Auth URL, backend JWKS URL, backend issuer/audience, and backend `DATABASE_URL` must all refer to the same Neon project and branch. Neon Managed Auth's base URL is the full URL shown in `VITE_NEON_AUTH_URL`, including `/flowpay/auth`. Better Auth's default JWT `iss` and `aud` use that full base URL, not only the hostname/origin. Neon Managed Better Auth signs JWTs with EdDSA; the API must verify EdDSA against that branch's JWKS and check both claims against the full Auth base URL. The backend now derives these defaults from `NEON_AUTH_JWKS_URL`. Never point a working frontend at a newly provisioned, empty Auth project while leaving the API/database on another project.

The separate Neon project named **FlowPay Production** was provisioned as a target database, but its customer/Auth data was empty during the November 17, 2026 repair. Do not switch the Render runtime to that empty project until a reviewed migration preserves the existing Auth identities, verified customer rows, FlowPay account numbers, wallets, provider records and any ledger history. Do not copy passwords, customer records or money data ad hoc.

Never expose Neon connection strings, private keys, OAuth client secrets, Paystack keys or other provider secrets to the browser or source control.

## Customer bootstrap and dashboard

After sign-in, `POST /customer/bootstrap` verifies the Neon JWT and verified email, then idempotently attaches or creates the customer's FlowPay record, NGN wallet and 10-digit FlowPay transfer number. It never creates a sample balance or credits money.

The dashboard balance is calculated from posted NGN ledger entries. A wallet with no posted ledger entries must display a verified zero balance, not an estimated amount. A failed API/authentication request must remain a visible error and must never be replaced with a fake balance.

The FlowPay 10-digit number is for transfers between FlowPay customers. It is not a Nigerian bank NUBAN and cannot receive transfers from an external bank.

## Account name and bank transfers

- The **To Bank** flow loads the Paystack bank directory from the backend and resolves the beneficiary name using Paystack's bank-account resolve API.
- Show the exact `account_name` returned by Paystack only after the account number and selected bank have been verified together.
- Do not substitute the signed-in customer's name, a local contact label, or a guessed name for the provider response.
- The customer's own Paystack Dedicated Virtual Account (DVA) is different from a transfer beneficiary. Its NUBAN, bank name and account name can be shown only after Paystack confirms assignment. A pending or failed DVA must not be made to look assigned.
- Live payouts remain behind the existing Paystack live-transfer feature gate. Never run a real payout as a test.

## Fingerprint and passkey

FlowPay implements server-verified WebAuthn passkeys using the existing `fp_passkeys` and `fp_passkey_challenges` tables.

- Registration is available to an authenticated, active, email-verified FlowPay customer from **Security → Register device passkey**.
- Registration and sign-in both use short-lived, single-use challenges, expected origin and RP ID validation, and required authenticator user verification.
- The backend stores credential IDs, public keys, counters and transports; it does not store the user's fingerprint or face image.
- A platform authenticator may ask for fingerprint, face verification or the device's secure screen lock. The browser/device chooses the actual user-verification method.
- A FlowPay passkey API token is HMAC-signed, has the `flowpay-passkey` issuer and `flowpay-api` audience, and expires after 15 minutes. The API accepts it only after WebAuthn verification and validates the same Neon user subject.

Backend-only passkey settings:

```env
FLOWPAY_PASSKEY_JWT_SECRET=<at least 32 random bytes>
FLOWPAY_WEBAUTHN_ORIGIN=https://flowpay-web-jx7i.onrender.com
FLOWPAY_WEBAUTHN_RP_ID=flowpay-web-jx7i.onrender.com
```

Do not create a client-only fingerprint button or bypass a server challenge/signature check.

## Transfers and money movement

- FlowPay-to-FlowPay transfers verify an active FlowPay recipient, check the sender's available posted ledger balance, require the transaction PIN, and write the sender debit and recipient credit atomically.
- Bank transfers use the Paystack bank directory and verified beneficiary name. The API retains idempotency, balance reservations, provider-status verification and the separate live payout gate.
- Automated tests must not initiate live money movement. Use provider sandbox or test fixtures for regression coverage.
- Deposits, virtual cards and DVA accounts remain provider-gated. No PAN, CVV, expiry, DVA number, bank account name or balance may be fabricated.
