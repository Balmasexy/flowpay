# Flutterwave sandbox checkout foundation

## Scope

This change adds an authenticated backend endpoint that creates a Flutterwave Standard hosted checkout in **test mode only**. It persists a unique pending FlowPay ledger transaction and Flutterwave deposit reference before requesting the provider checkout URL. The provider call is server-side; Flutterwave secret keys never reach the browser.

This is deliberately not a funds-posting or live-payment release:

- The endpoint refuses to run unless `FLW_ENVIRONMENT=test` and `FLW_SECRET_KEY` starts with `FLWSECK_TEST-`.
- It does not create ledger entries, change customer balances, or mark a deposit as posted.
- It does not implement a provider webhook or final transaction verification in this stage.
- Transfers and live payment flags remain disabled.
- The customer-facing Money Received page continues to list only posted deposits.

Flutterwave requires a server-side Standard checkout request and says the final transaction state must be verified server-side before value is provided. See the [Standard checkout guide](https://developer.flutterwave.com/docs/flutterwave-standard-1), [webhook guide](https://developer.flutterwave.com/docs/webhooks), and [authentication guide](https://developer.flutterwave.com/docs/authentication).

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

## Required next stage before any wallet credit

1. Add and test the public Flutterwave webhook using the configured `verif-hash` secret, then independently verify the provider transaction by ID/reference.
2. Verify exact `tx_ref`, NGN currency, amount, account ownership, provider status, and transaction identity against the pending database record.
3. Add duplicate-event and duplicate-verification tests using `fp_payment_events`.
4. Establish and test the FlowPay ledger debit/credit sign convention in a disposable database, then post both customer and clearing-account entries atomically under row locks. Never infer wallet balance from a provider redirect or an unverified webhook.
5. Add a status/recovery endpoint and reconciliation for pending or uncertain provider requests.
6. Complete sandbox end-to-end tests and independently review them before any live configuration or activation.

No live payment, bank transfer, or production release is enabled by this foundation.
