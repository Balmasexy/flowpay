# FlowPay Render backend configuration checklist

This checklist is for the **FlowPay backend web service** in Render. Store secret values only in Render's encrypted Environment settings. Do not paste them into GitHub, the frontend, an APK, logs, or ChatGPT.

The customer web service is separate. It only needs the public Auth URL and backend URL as build-time Vite variables.

## 1. Core backend connection

| Variable | Purpose |
|---|---|
| `NODE_ENV=production` | Production runtime |
| `DATABASE_URL` | PostgreSQL connection to the **currently active FlowPay Development main branch** until a reviewed data/auth migration is completed |
| `NEON_AUTH_JWKS_URL` | JWKS endpoint for the same Neon Auth project as `DATABASE_URL` |
| `NEON_AUTH_ISSUER` | Neon Auth issuer origin (not the full `/flowpay/auth` path) |
| `NEON_AUTH_AUDIENCE` | Matching Neon Auth audience origin |
| `WEB_ORIGIN=https://flowpay-web-jx7i.onrender.com` | Allowed customer web origin |
| `FLOWPAY_REQUIRE_FACE_VERIFICATION=true` | Keeps production money movement behind the production face-verification gate |

**Database safety:** the live app currently relies on the existing FlowPay Development Neon project for customer/Auth continuity. The separately provisioned FlowPay Production project was previously empty of customer/Auth/wallet/ledger records. Do not repoint the live service until a reviewed migration preserves Auth identity, customer profiles, FlowPay IDs, wallets, provider references and every ledger entry.

## 2. Authentication and passkeys

| Variable | Purpose |
|---|---|
| `FLOWPAY_PASSKEY_JWT_SECRET` | Backend-only random secret of at least 32 bytes |
| `FLOWPAY_WEBAUTHN_ORIGIN=https://flowpay-web-jx7i.onrender.com` | Exact browser origin allowed for WebAuthn |
| `FLOWPAY_WEBAUTHN_RP_ID=flowpay-web-jx7i.onrender.com` | WebAuthn relying-party ID |

Neon Managed Auth's email sender, Google provider and recovery OTP delivery are configured in Neon Auth, not by putting SMTP or OAuth secrets in Vite. Complete sender-domain and redirect-origin verification in the Neon Auth project.

## 3. Paystack — keep product switches separate

| Variable | Purpose |
|---|---|
| `PAYSTACK_ENVIRONMENT=live` | Select live Paystack APIs |
| `PAYSTACK_SECRET_KEY` | Matching `sk_live_` secret for the selected live environment |
| `PAYSTACK_WEBHOOK_SECRET` | Paystack webhook signing secret (the current handler expects the `whsec_` format) |
| `PAYSTACK_CALLBACK_URL=https://flowpay-web-jx7i.onrender.com/payment-return/paystack` | Hosted checkout return route |
| `PAYSTACK_DEPOSIT_MIN_MINOR` | Approved minimum deposit in kobo |
| `PAYSTACK_DEPOSIT_MAX_MINOR` | Approved maximum deposit in kobo |
| `PAYSTACK_LIVE_PAYMENTS_ENABLED` | Live deposit checkout switch; set true only after Paystack approval and webhook/reconciliation checks |
| `PAYSTACK_LIVE_TRANSFERS_ENABLED` | Real Nigerian bank payout switch; keep unset/false until Paystack separately approves Transfers and funding, OTP, fee, reversal and reconciliation processes are ready |
| `PAYSTACK_LIVE_DEDICATED_ACCOUNTS_ENABLED` | Live DVA assignment switch; only after separate Paystack DVA approval, customer consent and bank/BVN validation |

Bank-directory/account-name lookup uses the matching Paystack environment and key. Enabling live deposits does **not** enable live payouts or live DVA assignment. Configure the Paystack dashboard webhook at `https://flowpay-backend-qz79.onrender.com/webhooks/paystack`. Do not activate any live switch only to remove a warning or make a button appear active.

## 4. Flutterwave deposits and utility bills

| Variable | Purpose |
|---|---|
| `FLW_SECRET_KEY` | Backend-only Flutterwave secret matching the chosen test/live mode |
| `FLW_ENVIRONMENT=test` | Hosted deposit integration's test environment |
| `FLW_REDIRECT_URL` | HTTPS checkout redirect |
| `FLW_DEPOSIT_MIN_MINOR` | Approved minimum NGN deposit in minor units |
| `FLW_DEPOSIT_MAX_MINOR` | Approved maximum NGN deposit in minor units |
| `FLW_WEBHOOK_SECRET_HASH` | Flutterwave deposit webhook signing hash |
| `FLW_BILLS_ENVIRONMENT=test` | Utility-bill sandbox mode; requires a matching `FLWSECK_TEST-` key |
| `FLW_BILLS_CALLBACK_URL` | HTTPS utility-bill webhook URL: `https://flowpay-backend-qz79.onrender.com/webhooks/flutterwave/bills` |
| `FLW_BILLS_WEBHOOK_SECRET_HASH` | Utility-bill callback signing hash (may fall back to `FLW_WEBHOOK_SECRET_HASH`) |
| `FLW_BILLS_LIVE_ENABLED` | Keep false/unset until Flutterwave activates the live Utility Bills product and approves the merchant |
| `FLW_WEBHOOK_SECRET_HASH` | Account-wide fallback hash for the Flutterwave webhook verifier |

Live utility-bill payments additionally require a matching `FLWSECK_LIVE-` secret, `FLW_BILLS_ENVIRONMENT=live`, `FLW_BILLS_LIVE_ENABLED=true`, Flutterwave merchant/product approval, source funding and Render outbound-IP allowlisting. A test credential is not a live credential.

## 5. VTpass — airtime, data, electricity and Cable TV

| Variable | Purpose |
|---|---|
| `VTPASS_ENVIRONMENT=sandbox` | Select VTpass sandbox APIs |
| `VTPASS_API_KEY` | VTpass API key |
| `VTPASS_PUBLIC_KEY` | VTpass public key used by GET/catalogue requests |
| `VTPASS_SECRET_KEY` | VTpass secret key used by POST/transaction requests |
| `VTPASS_LIVE_ENABLED` | Keep false/unset until the VTpass business account and live products are approved |

The same VTpass credentials are used by airtime, data, electricity catalogue/meter verification and the new DStv/GOtv/StarTimes Cable TV flow. Cable TV also requires migration `029_vtpass_cable_tv.sql` to be reviewed and applied to the intended FlowPay database before customer purchases can use the expanded transaction category. The application rechecks the smartcard and provider bouquet/price server-side, reserves wallet funds and waits for authoritative provider status before posting a debit.

## 6. Smile ID face and liveness verification

| Variable | Purpose |
|---|---|
| `SMILE_ID_ENVIRONMENT` | Provider environment currently supported by the code |
| `SMILE_ID_PARTNER_ID` | Smile ID partner identifier |
| `SMILE_ID_API_KEY` | Backend-only Smile ID API secret |
| `SMILE_ID_CALLBACK_URL=https://flowpay-backend-qz79.onrender.com/face-verification/callback` | Signed result callback |

The current integration is sandbox-only. A sandbox pass is never production KYC clearance. Configure production only after Smile ID activates FlowPay's production account and the production result-signature, liveness and compliance checks are completed.

## 7. BALMZ AI and Storyblok

| Variable | Purpose |
|---|---|
| `FLOWPAY_BALMZ_AI_API_KEY` | Dedicated OpenAI API key for the FlowPay customer assistant |
| `FLOWPAY_BALMZ_AI_MODEL` | Optional model override |
| `STORYBLOK_SPACE_ID` | Storyblok space identifier |
| `STORYBLOK_PREVIEW_API_TOKEN` | Backend-only signed preview token |
| `STORYBLOK_REGION` | Storyblok region used by the preview integration |

BALMZ AI is guidance-only and cannot view, change or settle customer balances. Storyblok controls public content and preview access; it does not control wallets, authentication, payments or admin permissions.

## 8. Frontend build variables (FlowPay web service only)

| Variable | Purpose |
|---|---|
| `VITE_NEON_AUTH_URL` | Public Neon Auth URL for the matching FlowPay Auth project |
| `VITE_API_BASE_URL=https://flowpay-backend-qz79.onrender.com` | Public FlowPay backend URL |

Never put `DATABASE_URL`, provider secrets, Smile ID keys, webhook hashes, passkey signing secrets or admin-only credentials in a `VITE_*` variable.

## 9. Before switching on real money

1. Confirm the correct Render backend and frontend services and matching active Neon project/branch.
2. Review and apply only the required additive migrations to the intended database; do not apply the Cable TV migration to a production database until reviewed and rehearsed.
3. Confirm each provider's live product approval independently (Paystack deposits, Paystack Transfers, Paystack DVA, Flutterwave bills, VTpass and Smile ID are separate approvals).
4. Verify callbacks, webhook signatures, provider transaction verification, duplicate delivery protection, reservations, settlement and reversals.
5. Confirm merchant funding, customer identity/KYC, support/dispute handling, fraud monitoring, reconciliation, incident response and backup/restore procedures.
6. Run the authorised CI and sandbox tests, then a restricted, approved live test before opening the feature to customers.

A configured API key is not proof of provider approval, available funds, successful settlement or an issued financial product. Leave any unapproved live switch disabled.
