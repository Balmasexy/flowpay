# FlowPay Face Verification — Smile ID Sandbox

## Scope

This integration is sandbox-only. It does not submit production jobs, unlock transfers, change balances or ledger records, or treat a profile photo as a verified selfie.

FlowPay uses Smile ID SmartSelfie Registration (job type 4). The official Smart Camera Web Component collects the selfie and liveness frames. The FlowPay API submits the capture through the official server-side smile-identity-core SDK. Smile ID performs liveness and spoof checks and creates a reference selfie for later SmartSelfie Authentication.

Official references:
- https://docs.usesmileid.com/products/biometric-authentication
- https://www.npmjs.com/package/@smile_identity/smart-camera-web
- https://github.com/smileidentity/smile-identity-core-js

## Render API environment

Configure these variables on the FlowPay API service only:

- SMILE_ID_ENVIRONMENT=sandbox
- SMILE_ID_PARTNER_ID — sandbox partner ID
- SMILE_ID_API_KEY — sandbox API key; store as a Render secret
- SMILE_ID_CALLBACK_URL=https://flowpay-backend-qz79.onrender.com/face-verification/callback

The API deliberately pins the Smile ID server to sandbox (sid_server=0). No production host or production credentials are accepted by this feature. Never put partner secrets in the web app, GitHub, mobile app, or browser bundle.

## Database

Review apps/api/migrations/011_face_verification.sql before applying it to the FlowPay database. The migration is additive: it creates a separate table containing a FlowPay user reference, provider job references, status/check results, and a consent timestamp. It does not modify or delete customer profiles, accounts, balances, ledger entries, Transaction History, or any existing table.

## Camera and verification flow

1. The customer signs in and opens Face & liveness verification.
2. The customer explicitly consents before the camera can open.
3. The official Smile ID Smart Camera Web Component captures the selfie and liveness frames over HTTPS and dispatches the imagesComputed event.
4. The browser sends the capture payload to the authenticated FlowPay API. The API creates all Smile ID user/job references; client-supplied IDs are ignored.
5. The API submits job type 4 using the official Smile ID server-side SDK.
6. Smile ID calls the HTTPS callback. FlowPay verifies the provider signature and matches the callback to the exact pending job and customer before updating result metadata.
7. Only an approved registration result with explicit passing liveness, selfie, and selfie-provided checks is marked verified. Pending, manual review, failed, spoof, malformed, unsigned, or unknown callbacks fail closed.

Raw selfie/liveness frames are transmitted to Smile ID and are not persisted in FlowPay database tables or application logs. The database stores only result metadata and the consent timestamp.

## Remaining rollout gates

- Confirm SmartSelfie Registration is enabled on the Smile ID sandbox partner account.
- Apply additive migration 011 after review.
- Configure the sandbox-only Render secrets above.
- Exercise camera permissions and real sandbox capture from supported desktop/mobile HTTPS browsers.
- Verify success, failure, inconclusive/manual-review, duplicate callback, and invalid-signature cases.
- Complete privacy notice, retention/deletion, manual review, and account-recovery policy before any production KYC use.

No production activation, live payments, transfers, ledger posting, balance changes, or APK rebuild are part of this integration.
