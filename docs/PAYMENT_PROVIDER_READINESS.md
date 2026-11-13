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

## Paystack deposits and webhook settlement

The backend supports authenticated NGN checkout, idempotent pending-deposit creation, hosted Paystack checkout, transaction verification, customer-owned status lookup, webhook settlement, and balanced customer-wallet / Paystack-clearing ledger posting. The authenticated status endpoint also re-checks a pending reference against Paystack so webhook delays do not leave a successful deposit permanently pending.

Register the production webhook URL in the Paystack dashboard:

`https://flowpay-backend-qz79.onrender.com/webhooks/paystack`

Subscribe the endpoint to `charge.success`, `transfer.success`, `transfer.failed`, and `transfer.reversed`. Dedicated-account assignment and customer-identification events are processed by the same endpoint when that feature is enabled. Paystack retries a webhook when the endpoint does not return a successful response; the handler is idempotent and checks the ledger before acknowledging a previously posted transaction.

For current Paystack signing, configure `PAYSTACK_WEBHOOK_SECRET` with the webhook signing secret beginning `whsec_`. The API verifies the `Paystack-Signature` header against the raw request body, accepts any matching rotation signature, and rejects timestamps more than five minutes away from server time. During transition, it continues to accept the legacy `x-paystack-signature` header signed by `PAYSTACK_SECRET_KEY` when the new header is absent. A present but invalid/stale `Paystack-Signature` is rejected rather than falling back to the legacy header. Never put either secret in the web app or APK.

Live deposits require the matching live API key/mode plus:
- `PAYSTACK_LIVE_PAYMENTS_ENABLED=true`
- `PAYSTACK_CALLBACK_URL=https://flowpay-web-jx7i.onrender.com/payment-return/paystack`
- `PAYSTACK_DEPOSIT_MIN_MINOR` and `PAYSTACK_DEPOSIT_MAX_MINOR` in kobo

Disabling new checkout does not disable webhook or status reconciliation for an already-created deposit. Status lookup remains available for the authenticated customer, and pending references are checked with Paystack using the configured API key.

Dedicated virtual-account assignment is a separate approval-dependent capability controlled by `PAYSTACK_LIVE_DEDICATED_ACCOUNTS_ENABLED=true`; it is not switched on by the deposit flag. Live transfers are separately controlled by `PAYSTACK_LIVE_TRANSFERS_ENABLED=true`. Both require the relevant Paystack product approval and explicit operational authorization.

Successful transfers into an already assigned Paystack DVA are processed from the signed `charge.success` webhook. FlowPay independently verifies the Paystack transaction, matches the receiving NUBAN and provider customer code to the assigned DVA, and credits only the one active customer NGN wallet through a balanced Paystack-clearing ledger transaction. This settlement path remains active when new DVA assignment is disabled.

Customers can request a delayed-transfer requery through the authenticated `POST /customer/dedicated-bank-account/requery` endpoint. FlowPay uses the account's verified Paystack provider slug and stores a database-backed per-account ten-minute rate limit. The endpoint only requests Paystack to requery; the wallet is credited later, only after Paystack delivers the normal signed and verified `charge.success` webhook. Existing accounts without a saved provider slug are checked against the customer's Paystack record before requery. The additive migration `025_paystack_dva_requery_controls.sql` adds the provider slug and last-requery timestamp columns required by this endpoint.

Paystack's DVA feature is approval-dependent and available only to eligible Nigerian or Ghanaian registered businesses that completed its go-live process. Do not switch on live DVA assignment just because a live API key is configured.

For an isolated sandbox service (not the production API), configure `PAYSTACK_ENVIRONMENT=test`, a matching `sk_test_` secret, `FLOWPAY_RUNTIME_ENV=development`, `NODE_ENV` other than `production`, and `PAYSTACK_TRANSFERS_ENABLED=true`. The test API must use an isolated development database and test customers.

## Readiness endpoint

`GET /ready` reports database status and individual provider readiness:
- Paystack bank directory and beneficiary verification
- Paystack bank payouts, including schema and transfer-switch readiness
- Paystack deposits, including webhook signing mode and callback-side recovery
- Paystack dedicated-account assignment readiness
- Paystack DVA incoming-credit settlement and delayed requery readiness
- Flutterwave sandbox deposits

The endpoint reports readiness booleans and mode only. It never returns secret values. It does not globally mark all payments disabled just because one provider is not configured.

The customer overview has no global `paymentsEnabled=false` property; each feature is governed by its own operational checks.

## Flutterwave status

The current Flutterwave code path is a sandbox hosted-deposit integration, not a Nigerian bank-payout route. It remains independent from Paystack To Bank transfers. Keep the Flutterwave deposit entry visible, but report missing sandbox credentials/webhook verification separately from Paystack bank-transfer readiness.

## Deployment

This branch changes application code only. It does not modify Render environment variables, production database migrations, provider approvals, payout switches or production deploys. After merge, add/verify the production Paystack secret directly in the Render Environment page. Never paste provider secrets into GitHub, chat, browser variables or logs.
