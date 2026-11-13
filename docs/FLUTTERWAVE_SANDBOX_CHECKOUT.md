# Flutterwave sandbox checkout foundation

## Scope

This change adds an authenticated backend endpoint that creates a Flutterwave Standard hosted checkout in **test mode only**. It persists a unique pending FlowPay ledger transaction and Flutterwave deposit reference before requesting the provider checkout URL. The provider call is server-side; Flutterwave secret keys never reach the browser.

This is deliberately not a live-payment release. Test settlement is enabled only on an isolated development API/database:

- The endpoint refuses to run unless `FLW_ENVIRONMENT=test` and `FLW_SECRET_KEY` starts with `FLWSECK_TEST-`.
- It does not create ledger entries, change customer balances, or mark a deposit as posted.
- It does not implement a provider webhook or final transaction verification in this stage.
- Live payment flags remain disabled. The sandbox checkout and settlement endpoints reject production runtime or a non-development runtime label.
- The customer-facing Money Received page continues to list only posted deposits.

Flutterwave requires a server-side Standard checkout request and says the final transaction state must be verified server-side before value is provided. See the [Standard checkout guide](https://developer.flutterwave.com/docs/flutterwave-standard-1), [webhook guide](https://developer.flutterwave.com/docs/webhooks), and [authentication guide](https://developer.flutterwave.com/docs/authentication).

## Required isolated test runtime

The Flutterwave test credentials and customer wallet ledger must never be connected to the live production API/database. Configure the sandbox API only with:

- `FLOWPAY_RUNTIME_ENV=development`
- `NODE_ENV` other than `production`
- `FLW_ENVIRONMENT=test`
- `FLW_SECRET_KEY=FLWSECK_TEST-...`
- `FLW_WEBHOOK_SECRET_HASH` equal to the Flutterwave dashboard webhook secret hash
- `FLW_REDIRECT_URL=https://<test-web-origin>/payment-return/flutterwave`
- Positive `FLW_DEPOSIT_MIN_MINOR` and `FLW_DEPOSIT_MAX_MINOR` values
- A separate development `DATABASE_URL` containing the Flutterwave clearing account and `fp_payment_events` receipt table

The live production API intentionally rejects Flutterwave sandbox checkout, webhook settlement and status recovery. Use the production Paystack live integration for approved real-money payment paths. Do not point the Flutterwave sandbox API at the production Neon project.

## Endpoint

`POST /customer/flutterwave/deposits`

Requires a valid FlowPay Neon Auth JWT in the `Authorization: Bearer <token>` header.

Request:

```json
{
  "amountMinor": 250000,
  "idempotencyKey": "b0ca3b0d-a69c-44e2-a661-6ccf9cf9b3f1"
}
```

- `amountMinor` is an integer number of kobo (250000 = NGN 2,500.00).
- `idempotencyKey` must be a UUID and must be generated once per user submission. A retry must reuse the same key.
- Only the authenticated user's single active NGN customer wallet is eligible.
- The server obtains customer name and verified email from Neon Auth; client-supplied identity fields are rejected.

Successful response:

```json
{
  "transactionId": "FlowPay ledger transaction UUID",
  "providerReference": "flowpay-flw-...",
  "status": "pending",
  "environment": "test",
  "checkoutUrl": "https://checkout.flutterwave.com/v3/hosted/pay/..."
}
```

The client may navigate to `checkoutUrl`. It must not display the deposit as successful based on redirect parameters. A repeated request with the same idempotency key returns the same saved checkout URL. If an earlier request is still being processed or its provider outcome is uncertain, the API returns a conflict rather than creating a second payment.

## Server configuration

Configure these values only in the API service's secret/environment settings (never in frontend variables):

| Variable | Requirement |
|---|---|
| `FLW_ENVIRONMENT` | Must be exactly `test` |
| `FLW_SECRET_KEY` | Flutterwave test secret beginning `FLWSECK_TEST-` |
| `FLW_REDIRECT_URL` | HTTPS URL to the FlowPay payment-return page |
| `FLW_DEPOSIT_MIN_MINOR` | Positive integer minimum amount in kobo |
| `FLW_DEPOSIT_MAX_MINOR` | Integer maximum amount in kobo, at least the minimum |

Also requires the existing `DATABASE_URL`, `NEON_AUTH_JWKS_URL`, `NEON_AUTH_ISSUER`, and `NEON_AUTH_AUDIENCE` configuration.

No provider keys or environment settings are added to Render by this PR. Do not set a live key or set `FLW_ENVIRONMENT=live`.

## Database change

Migration `012_flutterwave_pending_checkout_sessions.sql` only makes the existing `fp_flutterwave_deposits.checkout_url` nullable so the pending reference can be persisted before the external checkout call. Existing checkout URLs and historical rows remain unchanged. The migration is additive and is not applied automatically by the API.

## Sandbox webhook settlement and recovery

The test webhook is `POST /webhooks/flutterwave`. It validates the dashboard `verif-hash` using a constant-time comparison and independently calls Flutterwave's transaction verification endpoint. It requires the provider transaction ID, `tx_ref`, NGN currency and exact amount to match the pending FlowPay deposit.

After successful verification, `settleVerifiedFlutterwaveDeposit`:
- Locks the pending deposit, transaction, customer wallet and Flutterwave clearing account.
- Adds a unique `fp_payment_events` receipt and rejects duplicate receipts that do not match the same transaction and payload digest.
- Writes one positive customer-wallet entry and one equal negative `flutterwave_ngn_clearing` entry in the same transaction.
- Marks the ledger transaction and provider deposit as posted only after the balanced entries are written.
- Validates an already-posted duplicate has exactly the same balanced ledger entries and does not post another credit.

The authenticated `GET /customer/flutterwave/deposits/status?reference=...` endpoint is customer-owner scoped. After a redirect it can also accept Flutterwave's `transaction_id`, independently verify the provider transaction by ID, and recover a pending deposit if a webhook was delayed. It returns `walletCredited: true` only after the ledger posting transaction commits.

The checkout uses one FlowPay idempotency record per customer submission. The provider reference is stored in both required `provider_reference` and `provider_tx_ref` columns. Retries return the saved hosted checkout instead of creating another provider session.

**Sandbox settlement remains strictly isolated.** Checkout, webhook settlement and status recovery require `FLOWPAY_RUNTIME_ENV=development`, `NODE_ENV` other than `production`, `FLW_ENVIRONMENT=test`, a matching test secret, and the webhook secret hash. Production FlowPay rejects this sandbox path. No live Flutterwave key or live payout route is enabled by these changes.

The repository test suite covers checkout persistence/idempotency, invalid webhook signatures, amount mismatches, duplicate webhooks, inactive customer wallets, non-empty pending ledger entries and production runtime rejection. These are mocked provider tests; a final real sandbox run still requires the isolated development Render API, its development database, and the Flutterwave dashboard's sandbox webhook configuration.
