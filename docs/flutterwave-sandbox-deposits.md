# FlowPay Flutterwave sandbox deposits

This integration is deliberately disabled by default. It accepts only Flutterwave v3 test secret keys and does not enable live payments.

## Required Render environment

Set these on the FlowPay API service only:

- `FLW_SECRET_KEY`: Flutterwave test-mode secret key beginning with `FLWSECK_TEST-`
- `FLUTTERWAVE_WEBHOOK_SECRET_HASH`: webhook secret hash configured in the Flutterwave sandbox dashboard
- `FLOWPAY_FLUTTERWAVE_CALLBACK_URL`: HTTPS callback URL for the FlowPay web app
- `FLOWPAY_FLUTTERWAVE_SANDBOX_ENABLED`: set to `true` only after migration 007 is applied and sandbox webhook settings are verified

Never put provider secrets in Vite variables, browser code, commits, or chat messages. Do not use a live key.

## Webhook

Configure the Flutterwave sandbox webhook destination as:

`https://flowpay-backend-qz79.onrender.com/webhooks/flutterwave`

The webhook hash must match `FLUTTERWAVE_WEBHOOK_SECRET_HASH`. The handler independently verifies the transaction with Flutterwave before it posts any ledger entry.

## Database migration

Review and apply `apps/api/migrations/007_flutterwave_sandbox_deposits.sql` to the intended FlowPay Neon database before enabling the feature flag. The migration creates separate deposit-intent and provider-clearing-account mapping tables; it does not rewrite customer balances or existing ledger rows.

When the feature flag is enabled, `/ready` includes `007_flutterwave_sandbox_deposits` in its required migration set.

## Customer flow

1. The signed-in customer opens Money Received.
2. FlowPay selects an active customer-owned NGN account.
3. The customer enters an amount and receives a hosted Flutterwave sandbox checkout link.
4. The customer completes a sandbox payment.
5. Flutterwave sends a signed webhook.
6. FlowPay verifies the transaction with the provider, checks the reference, NGN currency, and exact amount, then posts a balanced ledger transaction once.
7. The customer refreshes deposit status to see whether it is still pending or has posted.

A checkout URL or a browser redirect is not proof of payment. Only the verified webhook path can post the ledger credit.

## API

- `POST /v1/payments/flutterwave/deposits` — authenticated checkout creation; requires an `Idempotency-Key` header and JSON `accountId` plus `amountMinor`.
- `GET /v1/payments/flutterwave/deposits/:reference` — authenticated status lookup, scoped to the signed-in customer.
- `POST /webhooks/flutterwave` — public provider callback protected by the configured webhook hash.

All endpoints report live payments as disabled. Do not enable this feature for customers until CI, migration checks, sandbox checkout, webhook verification, and duplicate-webhook tests pass.
