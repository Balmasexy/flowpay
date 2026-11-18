# FlowPay database environments, onboarding and money movement

## Active customer-data continuity environment

**As of November 17, 2026, the live Render app is temporarily connected to the existing FlowPay Development Neon project** because it contains the pre-existing verified FlowPay Auth user and customer account records.

- Neon project: `FlowPay Development`
- Project ID: `red-sound-13711068`
- Branch: `main` (`br-square-field-za1ayx6p`)
- Database: `flowpay`
- Auth URL: `https://ep-quiet-grass-zabt9514.neonauth.c-2.eu-west-2.aws.neon.tech/flowpay/auth`
- JWKS URL: `https://ep-quiet-grass-zabt9514.neonauth.c-2.eu-west-2.aws.neon.tech/flowpay/auth/.well-known/jwks.json`
- JWT issuer and audience: `https://ep-quiet-grass-zabt9514.neonauth.c-2.eu-west-2.aws.neon.tech`

This is a data-continuity configuration, not a declaration that the Development project has become the final production database. The existing verified customer, 10-digit FlowPay transfer number and active NGN wallet must remain reachable while a proper migration is prepared.

## Staged production target

A separate Neon project was provisioned:

- Neon project: `FlowPay Production`
- Project ID: `quiet-sky-26410409`
- Region: `aws-us-west-2`
- Branch: `main` (`br-billowing-field-aku5zego`)
- Database: `flowpay`

Its schema migrations were applied, but it was empty of Auth users, FlowPay customers, account numbers, customer wallets, cards and ledger entries during the November 17, 2026 verification. It is **not** the active Render database following the repair.

Do not reconnect the live Render app to this empty project until a reviewed data/auth migration preserves existing Neon Auth identities, password/Google sign-in continuity, FlowPay customer profiles, account numbers, wallet rows, provider records and any ledger history. Never copy auth secrets or financial data through ad-hoc scripts. No balances or transactions may be invented during that migration.

## Render backend environment

The active `flowpay-backend` service must use one consistent Neon project/branch for all of the following:

- `DATABASE_URL`: connection string for the active FlowPay Development main branch above. Store it only as a Render secret.
- `NEON_AUTH_JWKS_URL`: the Auth JWKS URL above.
- `NEON_AUTH_ISSUER`: `https://ep-quiet-grass-zabt9514.neonauth.c-2.eu-west-2.aws.neon.tech`.
- `NEON_AUTH_AUDIENCE`: `https://ep-quiet-grass-zabt9514.neonauth.c-2.eu-west-2.aws.neon.tech`.
- `WEB_ORIGIN`: `https://flowpay-web-jx7i.onrender.com`.
- `NODE_ENV`: `production`.
- `FLOWPAY_REQUIRE_FACE_VERIFICATION`: `true`.

Neon Managed Better Auth JWTs use EdDSA. Both `iss` and `aud` must match the origin of the matching Auth URL. Do not use the full `/flowpay/auth` path for issuer or audience.

Keep passkey secrets and provider credentials server-side only:

- `FLOWPAY_PASSKEY_JWT_SECRET`: at least 32 random bytes.
- `FLOWPAY_WEBAUTHN_ORIGIN=https://flowpay-web-jx7i.onrender.com`.
- `FLOWPAY_WEBAUTHN_RP_ID=flowpay-web-jx7i.onrender.com`.

## Render frontend environment

The active `flowpay-web` service must use:

- `VITE_NEON_AUTH_URL`: `https://ep-quiet-grass-zabt9514.neonauth.c-2.eu-west-2.aws.neon.tech/flowpay/auth`.
- `VITE_API_BASE_URL`: `https://flowpay-backend-qz79.onrender.com`.

Do not put database connection strings, Smile ID keys, Paystack keys or issuer secrets in Vite frontend variables.

## Registration and account creation

After a customer has verified their email and starts their first authenticated session, the web app calls `POST /customer/bootstrap`. The API verifies the Neon JWT and verified email, then uses one database transaction to:

1. Attach or create the FlowPay customer profile.
2. Create the customer's NGN wallet with a zero opening balance.
3. Allocate one unique random 10-digit FlowPay-to-FlowPay transfer number.
4. Create a pending virtual-card display record with no PAN, CVV, expiry or issuer reference.

The bootstrap endpoint is idempotent. The FlowPay transfer number is not a Nigerian bank NUBAN. A separate Paystack Dedicated Virtual Account (DVA) is required for bank-to-bank receipts and appears only after Paystack confirms assignment.

## Bank beneficiary account names and incoming DVA accounts

- The **To Bank** transfer form loads the Paystack bank directory and verifies the exact beneficiary bank/account combination through Paystack's bank account resolve API.
- The UI must display the provider's exact `account_name` only after a successful response tied to the entered 10-digit account number and selected bank.
- Do not replace the provider-returned name with a user's profile name or a locally invented label.
- A DVA assigned to the FlowPay customer is separate from a transfer beneficiary. Show the DVA number, bank and account name only after Paystack confirms assignment.
- Incoming DVA funds are credited only after a signed Paystack event and a server-side transaction verification, matched to the assigned DVA and customer, followed by one balanced ledger posting.
- If Paystack returns a pending or failed assignment, do not show an assigned account or invent bank details.

## Password recovery

Neon Managed Better Auth uses the email OTP flow:
- Recovery code request: `/email-otp/send-verification-otp` with `type=forget-password`.
- Password update: `/email-otp/reset-password` with email, OTP and new password.
- `revoke_sessions_on_password_reset=true` invalidates prior sessions.
- Normal sign-in remains email and password; signup verification OTP is separate from login.

## Face and liveness verification

FlowPay uses Smile ID SmartSelfie Registration (job type 4) with the official active-liveness camera and signed callbacks. Raw selfie/liveness frames are submitted to Smile ID and are not stored in FlowPay. Production and sandbox jobs are separated in the database. Only `environment='production'` plus a provider-approved `verified` result satisfies the production face gate.

For production, configure on the backend only after Smile ID has activated FlowPay's production account:

- `SMILE_ID_ENVIRONMENT=production`
- `SMILE_ID_PARTNER_ID`
- `SMILE_ID_API_KEY` (secret)
- `SMILE_ID_CALLBACK_URL=https://flowpay-backend-qz79.onrender.com/face-verification/callback`

Smile ID production credentials and account activation are external provider gates. A sandbox pass is never accepted for production money movement.

## Deposits, transfers, withdrawals and bills

Existing FlowPay features remain provider-gated:
- Paystack deposits and dedicated bank accounts require the approved environment and matching secrets.
- Bank withdrawals use Paystack payout/transfer and remain disabled unless the bank payout feature flag and provider live approval are satisfied.
- FlowPay internal transfers, bank withdrawals and VTpass bill purchases require production face verification when `FLOWPAY_REQUIRE_FACE_VERIFICATION=true`.
- VTpass airtime and data require valid sandbox/live credentials and the matching live feature switch.
- Electricity / NEPA uses Flutterwave Utility Bills. Before enabling the FlowPay customer route, apply additive migration `023_flutterwave_utility_bills.sql` to the currently active FlowPay Development database branch without changing existing customer, wallet or ledger rows.
- Configure on the backend only: `FLW_BILLS_ENVIRONMENT=test` with an `FLWSECK_TEST-` secret key for sandbox; live requires `FLW_BILLS_ENVIRONMENT=live`, an `FLWSECK_LIVE-` secret key, `FLW_BILLS_LIVE_ENABLED=true`, and `NODE_ENV=production`.
- Flutterwave also requires merchant KYC/product activation, a funded source balance, and allowlisting the Render backend's outbound IP. Optional `FLW_BILLS_CALLBACK_URL` must be an HTTPS URL. Do not place any Flutterwave key in a Vite/browser variable.
- A virtual card is shown as pending until an approved issuer provisions a real card. The application must not invent card number, CVV, expiry or PIN data.

Do not enable live Paystack, VTpass, Flutterwave or card-issuer modes until the business/provider approvals, production secrets, settlement/reconciliation and operational controls are confirmed.
