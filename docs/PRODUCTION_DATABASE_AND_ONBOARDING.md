# FlowPay production database, onboarding and money movement

## Production database

- Neon project: `FlowPay Production`
- Project ID: `quiet-sky-26410409`
- Region: `aws-us-west-2` (Oregon)
- Default branch: `main` (`br-billowing-field-aku5zego`)
- Database: `flowpay`
- Application role: `flowpay_app`
- Neon Managed Better Auth is provisioned on this branch.
- The production branch is currently unprotected because the Neon account has reached its protected-branch quota. Upgrade the Neon plan or free a protected-branch slot before enabling branch protection.

The application migrations `001_core` through `026_production_onboarding_face_kyc` have been applied to the new database. The database starts empty; no development customers, passwords, balances, payout records or ledger entries were copied.

## Render backend environment

Set these on the `flowpay-backend` Render service:

- `DATABASE_URL`: Neon connection string for project `quiet-sky-26410409`, branch `br-billowing-field-aku5zego`, database `flowpay`, role `flowpay_app`. Store it as a secret.
- `NEON_AUTH_JWKS_URL`: `https://ep-weathered-dust-akai74ps.neonauth.c-3.us-west-2.aws.neon.tech/flowpay/auth/.well-known/jwks.json`
- `NEON_AUTH_ISSUER`: `https://ep-weathered-dust-akai74ps.neonauth.c-3.us-west-2.aws.neon.tech/flowpay/auth`
- `WEB_ORIGIN`: `https://flowpay-web-jx7i.onrender.com`
- `NODE_ENV`: `production`
- `FLOWPAY_REQUIRE_FACE_VERIFICATION`: `true`

A fixed JWT audience is optional. The API verifies signature, expiry and the exact Neon Auth issuer. Do not set a development audience against this production auth issuer.

## Render frontend environment

Set these on `flowpay-web`:

- `VITE_NEON_AUTH_URL`: `https://ep-weathered-dust-akai74ps.neonauth.c-3.us-west-2.aws.neon.tech/flowpay/auth`
- `VITE_API_BASE_URL`: `https://flowpay-backend-qz79.onrender.com`

Do not place Neon connection strings, Smile ID API keys, Paystack secret keys or card-issuer secrets in frontend variables.

## Registration and account creation

After a customer has verified their email and starts their first authenticated session, the web app calls `POST /customer/bootstrap`. The API verifies the Neon JWT and verified email, then uses one database transaction to:

1. Attach or create the FlowPay customer profile.
2. Create the customer's NGN wallet with a zero opening balance.
3. Allocate one unique random 10-digit FlowPay-to-FlowPay transfer number.
4. Create a pending virtual-card display record with no PAN, CVV, expiry or issuer reference.

The bootstrap endpoint is idempotent. The dashboard displays the FlowPay transfer number and virtual-card status immediately. The FlowPay transfer number is not a Nigerian bank NUBAN and cannot receive an external-bank transfer. A separate Paystack Dedicated Virtual Account (DVA) NUBAN is required for bank-to-bank receipts and appears only after Paystack confirms assignment.

## Receiving from other Nigerian banks and account-name display

- Once a Paystack DVA is assigned and active, senders can transfer NGN to it from other supported Nigerian bank apps. The DVA's host bank is selected from Paystack's supported providers; this does not mean FlowPay opens a separate account at every Nigerian bank.
- Incoming DVA funds are not credited from a browser redirect or a sender screenshot. FlowPay accepts a signed Paystack `charge.success` event, verifies the transaction with Paystack, matches the receiver's 10-digit DVA and customer, and posts a single balanced NGN ledger credit. Duplicate or mismatched events do not create a second credit.
- The bank's account-name enquiry is controlled by Paystack and its receiving-bank partners. FlowPay stores and displays the exact `account_name` returned by Paystack; it must not overwrite this with a local label.
- FlowPay's requested bank-visible format is `FlowPay / <customer's verified name>`. Paystack's standard DVA naming combines a product/business name with the customer name. Paystack documents a separate custom naming arrangement for businesses providing virtual accounts to their customers; FlowPay must obtain Paystack's approval/activation and confirm its business/trading name is FlowPay before claiming the format is live.
- Until Paystack confirms the custom naming configuration, the app must show the exact provider-returned account name and explain that branding is pending. Do not change a DVA account name in FlowPay's database to simulate a bank-side name change.
- Paystack requires express customer consent for creating a DVA. For Nigerian financial-services businesses, BVN and linked-bank validation may also be required. Assignment remains blocked until the customer's consent, required validation, and the business's Paystack DVA approval are present.

## Password recovery

Neon Managed Better Auth uses the email OTP flow:
- Recovery code request: `/email-otp/send-verification-otp` with `type=forget-password`.
- Password update: `/email-otp/reset-password` with email, OTP and new password.
- `revoke_sessions_on_password_reset=true` invalidates prior sessions.
- Normal sign-in remains email and password; signup verification OTP is separate from login.

The production Neon Auth branch currently uses Neon's shared sender `auth@mail.myneon.app`. A custom SMTP sender may be configured before broad launch. An actual external inbox delivery and reset were not performed as part of provisioning.

## Face and liveness verification

FlowPay uses Smile ID SmartSelfie Registration (job type 4) with the official active-liveness camera and signed callbacks. Raw selfie/liveness frames are submitted to Smile ID and are not stored in FlowPay. Production and sandbox jobs are now explicitly separated in the database. Only `environment='production'` plus a provider-approved `verified` result satisfies the production face gate.

For production, configure on the backend only after Smile ID has activated FlowPay's production account:

- `SMILE_ID_ENVIRONMENT=production`
- `SMILE_ID_PARTNER_ID`
- `SMILE_ID_API_KEY` (secret)
- `SMILE_ID_CALLBACK_URL=https://flowpay-backend-qz79.onrender.com/face-verification/callback`

Smile ID production credentials and account activation are external provider gates. A sandbox pass is never accepted for production money movement. Production SmartSelfie registration is documented at https://docs.usesmileid.com/products/biometric-authentication.

## Deposits, transfers, withdrawals and bills

Existing FlowPay features remain provider-gated:
- Paystack deposits and dedicated bank accounts require the approved environment and matching secrets.
- Bank withdrawals use Paystack payout/transfer and remain disabled unless the bank payout feature flag and provider live approval are satisfied.
- FlowPay internal transfers, bank withdrawals and VTpass bill purchases require production face verification when `FLOWPAY_REQUIRE_FACE_VERIFICATION=true`.
- VTpass airtime, data and electricity require valid sandbox/live credentials and the matching live feature switch.
- A virtual card is shown as pending until an approved issuer provisions a real card. The application must not invent card number, CVV, expiry or PIN data.

Do not enable live Paystack, VTpass, Flutterwave or card-issuer modes until the business/provider approvals, production secrets, settlement/reconciliation and operational controls are confirmed.
