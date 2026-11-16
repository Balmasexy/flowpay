# FlowPay

FlowPay is an independent Nigerian digital-finance application. Its own branding, product identity, API, provider configuration, and customer experience are maintained separately from other projects. OPay is used only as a usability benchmark; FlowPay is not affiliated with OPay and does not use its proprietary assets or code.

## Current system

- apps/web/: React + TypeScript customer web application.
- apps/api/: Node.js + TypeScript API for authenticated customer data, transfers, provider integrations, receipts, notifications, support, and readiness checks.
- apps/android/: WebView packaging source for the web client. The current delivery target is the web application; do not generate or publish an APK as part of this release.
- Database/auth: Neon PostgreSQL with Neon Managed Auth. The configured project currently identifies itself as FlowPay Development.
- Hosting: Render web static site and Render API service.
- CI: API type-check/regression tests, API/web dependency audits, readiness smoke test, and web production build.

## Implemented and tested paths

The API contains ledger-backed internal FlowPay wallet transfers, Paystack bank beneficiary lookup and sandbox payout safeguards, Paystack deposit checkout/webhook settlement, Flutterwave test deposits, dedicated-account assignment/settlement controls, VTpass airtime/data/electricity purchase/status handling, customer notifications, customer support requests, BALMZ AI endpoint, deposit receipt upload/review, Storyblok signed preview, and Smile ID sandbox callback/result handling.

“Implemented and tested” describes code and automated regression coverage. It does not imply provider business approval, live credentials, or production money-movement authorization. See docs/FLOWPAY_END_TO_END_READINESS.md for the route matrix.

## Build and test

```sh
npm ci --prefix apps/api
npm run typecheck --prefix apps/api

npm ci --prefix apps/web
npm run build --prefix apps/web
```

Run API regression scripts from apps/api/package.json using the matching npm run test:... command. GitHub Actions runs the configured suite on pull requests and pushes that touch application or documentation files.

## Financial and privacy safety

- Account balances and transaction history must come from the server-side ledger; never create sample balances or transactions for customers.
- Only provider-verified and idempotently posted transactions are settled.
- Internal FlowPay numbers are not external bank NUBANs.
- Dedicated bank accounts and payment cards are separate provider products; never show placeholder numbers or card credentials.
- Keep provider secrets, Neon credentials, JWT signing material, and Android signing keys out of Git, frontend variables, browser storage, and chat.
- Preserve existing customer data. Production migrations require an explicit change review and backup/restore plan.
- Live deposits, bank payouts, dedicated accounts, VTpass live bills, and card issuance each have their own provider and operational approval gate.
