# FlowPay Face Verification — Smile ID Sandbox

## Scope

This integration is sandbox-only. It must not submit production jobs, mark a customer as KYC-approved, unlock transfers, or change balances/ledger records.

Smile ID SmartSelfie Registration (job type 4) is the initial enrollment operation. Smile ID performs selfie/liveness checks and creates a reference selfie for later SmartSelfie Authentication (job type 2). Authentication requires a previously enrolled reference selfie.

Official product documentation:
- https://docs.usesmileid.com/products/biometric-authentication
- https://docs.usesmileid.com/

## Render API environment

Configure these variables on the FlowPay API service only:

- `SMILE_ID_ENVIRONMENT=sandbox`
- `SMILE_ID_PARTNER_ID` — partner ID from Smile ID
- `SMILE_ID_API_KEY` — sandbox API key; store as a secret
- `SMILE_ID_CALLBACK_URL` — HTTPS callback URL on the FlowPay API

Do not put credentials in the web app, GitHub, mobile app, or chat. Never use production credentials or the production host during this phase.

The sandbox API host is `https://testapi.smileidentity.com/v1`. Production uses a different host and is deliberately not enabled by this foundation.

## Required next implementation steps

1. Confirm the Smile ID sandbox account has SmartSelfie Registration enabled and configure the Render secrets above.
2. Add authenticated customer endpoints to create a unique job ID and initiate job type 4 using the official Smile ID server-side SDK/API signing flow.
3. Integrate the official Smile ID Web SDK / capture flow so the camera collects the required selfie and liveness frames. Do not substitute a single browser screenshot for liveness.
4. Receive callbacks, verify their Smile ID signature, and persist only the minimum result metadata against the authenticated FlowPay customer. Do not trust unsigned callbacks.
5. Treat only final approved outcomes as verified. Pending/manual review remains pending; failed, spoof, invalid, and service errors never pass.
6. Add a separate job type 2 re-authentication flow for enrolled users where appropriate.
7. Complete privacy notice, explicit consent, retention/deletion policy, manual review, and account-recovery controls before production.

## Security rules

- Face verification is independent of device passkeys/biometrics.
- Never expose partner secrets or signed upload URLs to logs or browser bundles.
- Never store raw selfie/video payloads in FlowPay logs or ordinary application tables.
- Fail closed: missing configuration, callback verification failure, timeout, or provider outage must not set verification to approved.
- Do not use verification status to alter financial records. Payments remain disabled.
- No production activation is part of this work.
