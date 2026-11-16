# FlowPay implementation and release plan

## Completed in the current repository

- Isolated FlowPay repository, separate API/web projects, Render services, and Neon development database.
- Neon Managed Auth email/password sign-up and sign-in with email OTP verification during registration. Normal sign-in does not require an OTP.
- OPay-inspired FlowPay login UI using FlowPay branding, email/password sign-in, password visibility, and a separate forgot-password OTP flow.
- Authenticated customer profile, dashboard overview, transaction history, internal wallet transfer, To Bank transfer, account number, transaction PIN, notifications, support, receipt upload/review, and customer AI routes.
- Paystack deposit checkout/status/webhook/ledger-settlement paths, Paystack bank lookup and payout safeguards, Paystack dedicated-account assignment and incoming-credit settlement controls.
- Flutterwave test deposit integration, Smile ID sandbox callback/result handling, signed Storyblok preview, and VTpass airtime/data/electricity adapter.
- Idempotency, provider verification, customer ownership checks, ledger safeguards, and regression tests for the implemented financial paths.
- GitHub Actions API type-check and regression suite, dependency audit, API health/readiness smoke test, and web production build.
- Better Auth dependency tree patched to 1.7.25 in the web lockfile, with a clean web audit recorded on the security-release branch.

## Remaining product/provider work

1. **Production infrastructure:** The configured Neon database project is named FlowPay Development. Provision a separate production database/auth environment, review access controls and backup retention, run a migration rehearsal, and verify restore before production customer data is moved. Do not point live processing at a development database.
2. **Live Paystack:** Obtain business approval separately for live deposits, Transfers, and dedicated virtual accounts. Configure the matching Render secrets, webhook, callback, limits, and feature flags only after approval.
3. **VTpass:** Complete sandbox account setup and sandbox transactions with the business account, then obtain live approval and configure the API credentials and live switch.
4. **Flutterwave cards:** Obtain written issuer access, approved card lifecycle APIs, PCI scope guidance, and secure hosted/reveal component. Until then, keep the card design explicitly marked as a preview.
5. **KYC:** Complete Smile ID sandbox testing with provider credentials and callback. Obtain live approval, consent, legal review, retention rules, and monitored staff decision flow before production KYC.
6. **Remaining customer services:** Implement secure document storage/review; savings product/partner, statements and withdrawals; cable TV subscriptions; betting funding; referrals; and customer Security actions (password changes, passkeys/MFA, session revocation). Do not show these as active until end-to-end flows exist.
7. **Operations/compliance:** Complete support staffing and complaints SLA, fraud/chargeback handling, reconciliation, alerts, incident response, staff MFA and maker-checker controls, and periodic backup restore drills.

## Release gate

The web application can be built and deployed independently of live payment activation. Before production money movement, require approved provider contracts, distinct production credentials/database, migration rehearsal and backup, security and legal review, monitored low-value authorized live tests, duplicate webhook and reversal tests, and ledger reconciliation.

Never fabricate balances, account numbers, transactions, identity verification, card credentials, provider approvals, or payment success. Preserve existing data. Apply production migrations or activate live payment switches only after explicit authorization and a documented rollback/restore plan.
