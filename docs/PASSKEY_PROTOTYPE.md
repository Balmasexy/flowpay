# FlowPay device passkey prototype (isolated test only)

This prototype is deliberately separate from the live FlowPay authentication service. It does not replace Neon Auth, access production customer records, or submit real payments.

## Isolated database

A new empty Neon project was created for this prototype:

- Project: `FlowPay Passkey Prototype`
- Project ID: `mute-violet-49061423`
- Region: `aws-eu-west-2`
- Database: `flowpay_passkey_prototype`
- Default branch: `br-divine-credit-za0yvt6m`
- Better Auth schema: `passkey_auth`

No production branch was cloned. The schema is created by `apps/api/migrations/passkey_prototype_test.sql`. The schema has its own Better Auth users, sessions, accounts, verifications, passkeys, PIN records, short-lived transaction challenges and audit events.

Use only a dedicated test email and test password in this lab. Do not enter production customer credentials.

## Staging environment variables

Set these only on a separate prototype API service, not the production `flowpay-backend`:

| Variable | Purpose |
|---|---|
| `FLOWPAY_PASSKEY_ENABLED` | Set to `true` only on the prototype API |
| `FLOWPAY_PASSKEY_DATABASE_URL` | Connection string for the isolated project/database above |
| `FLOWPAY_PASSKEY_AUTH_SECRET` | A new random secret with at least 32 characters |
| `FLOWPAY_PASSKEY_AUTH_BASE_URL` | HTTPS base URL of the prototype API, without `/prototype-auth` |
| `FLOWPAY_PASSKEY_FRONTEND_ORIGIN` | Exact HTTPS origin of the prototype web app |
| `FLOWPAY_PASSKEY_RP_ID` | Hostname of the prototype web app, without scheme or path |
| `VITE_PASSKEY_PROTOTYPE_API_BASE_URL` | HTTPS base URL of the prototype API, without trailing slash |

The Better Auth endpoint is mounted at `/prototype-auth`. The transaction step-up test endpoints are under `/prototype-security`.

The prototype service rejects transaction-security requests unless the browser `Origin` exactly matches `FLOWPAY_PASSKEY_FRONTEND_ORIGIN`. Better Auth also uses that exact trusted origin. Keep the RP ID limited to the prototype hostname.

## Test flow

1. Open `/passkey-lab` on the HTTPS prototype web app.
2. Create a test account using a dedicated email and password.
3. Register a device passkey. The platform authenticator is selected and WebAuthn user verification is required.
4. Sign out, then use **Sign in with device passkey**. This tests passkey-first sign-in.
5. Configure a separate six-digit transaction PIN.
6. Enter test bank details, amount and transaction PIN.
7. Continue through the device's biometric or screen-lock prompt. The backend verifies both factors and returns a prototype-only authorization result.

The OS may use fingerprint, face unlock, or the device's secure screen lock depending on Android/browser capabilities and device settings. FlowPay never receives or stores fingerprint images, face images, biometric templates, or device secrets. The relying party stores public credential material only.

## Transaction step-up safeguards

- The transaction review is hashed and bound to the passkey challenge: account number, bank code, amount in minor units, and idempotency key.
- The challenge expires after five minutes and can be consumed once.
- The transaction details must match at verification time. Editing the account, bank, amount, or idempotency key invalidates the assertion.
- WebAuthn user verification is required during registration, sign-in and transaction approval.
- The six-digit PIN is hashed with a unique random salt using scrypt. Five failed attempts trigger a 15-minute lockout.
- Passkey counters are updated after successful verification.
- Security events record the result and masked account details, not the full account number or PIN.

## Explicit payment boundary

**This prototype never submits a bank transfer.** A successful test displays `prototype_authorized_only` with `transferSubmitted: false`. It does not call Paystack, debit a wallet, write to a production ledger, or change a customer balance. The final integration into the real bank-transfer route requires a separate reviewed change after the staging authentication flow passes.

## Production isolation

- Live Neon Auth configuration and customer data are unchanged.
- The current production login page and its six-digit email OTP recovery flow are unchanged.
- The production transaction PIN remains separate.
- No Render production environment variables, deploys, migrations, secrets or payment settings are changed by this prototype.
