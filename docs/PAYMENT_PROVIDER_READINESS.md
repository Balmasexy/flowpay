# FlowPay payment route availability and provider readiness

FlowPay must keep customer payment destinations visible. Provider configuration, validation, funding, identity, balance and transaction-authorization checks belong at the service boundary; a missing provider configuration must not be disguised by hiding a payment feature.

## To Bank route

The React transfer screen always renders the To Bank destination. Bank choices are loaded from authenticated `GET /customer/banks`; bank-name verification is performed through `POST /customer/bank-account-lookup`. The bank directory is not a static fallback because Paystack's current Nigerian bank codes are used by subsequent name verification and payout creation.

If the provider directory request fails, the screen shows the cause and a **Reload bank list** action. The transfer form stays visible. The server responds with the required mode/key configuration without returning or logging the secret.

On the production `flowpay-backend` API, bank listing and beneficiary verification require:
- `PAYSTACK_ENVIRONMENT=live`
- `PAYSTACK_SECRET_KEY` with the matching `sk_live_` prefix
- `NODE_ENV=production`

The same Paystack live secret is used for bank directory, account resolution, recipient creation, transfer initiation and transfer verification. Do not create a second key only for bank transfers.

The To Bank confirmation action is not hidden or disabled solely because the server-side payout switch is off. It may be attempted after beneficiary review and transaction PIN entry, and the backend responds with `PAYSTACK_BANK_PAYOUTS_NOT_ENABLED` and the exact missing configuration. The backend gate remains mandatory: it checks provider mode and the separate transfer switch before any payout, then requires authenticated customer, verified beneficiary, transaction PIN, idempotency, wallet balance, recipient validation, webhook verification and ledger reconciliation.

Live payout submissions require Paystack Transfers approval and:
- `PAYSTACK_LIVE_TRANSFERS_ENABLED=true`

The separate `PAYSTACK_LIVE_PAYMENTS_ENABLED` flag governs live Paystack deposit checkout, not the independent live bank-payout gate. Live bank transfers move real money and must not be switched on just to make the button look active.

For an isolated sandbox service (not the production API), configure `PAYSTACK_ENVIRONMENT=test`, a matching `sk_test_` secret, `FLOWPAY_RUNTIME_ENV=development`, `NODE_ENV` other than `production`, and `PAYSTACK_TRANSFERS_ENABLED=true`. The test API must use an isolated development database and test customers.

## Readiness endpoint

`GET /ready` reports database status and individual provider readiness:
- Paystack bank directory and beneficiary verification
- Paystack bank payouts, including schema and transfer-switch readiness
- Paystack deposits
- Flutterwave sandbox deposits

The endpoint reports readiness booleans and mode only. It never returns secret values. It does not globally mark all payments disabled just because one provider is not configured.

The customer overview has no global `paymentsEnabled=false` property; each feature is governed by its own operational checks.

## Flutterwave status

The current Flutterwave code path is a sandbox hosted-deposit integration, not a Nigerian bank-payout route. It remains independent from Paystack To Bank transfers. Keep the Flutterwave deposit entry visible, but report missing sandbox credentials/webhook verification separately from Paystack bank-transfer readiness.

## Deployment

This branch changes application code only. It does not modify Render environment variables, production database migrations, provider approvals, payout switches or production deploys. After merge, add/verify the production Paystack secret directly in the Render Environment page. Never paste provider secrets into GitHub, chat, browser variables or logs.
