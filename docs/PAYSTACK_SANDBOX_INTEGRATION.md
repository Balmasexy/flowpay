# Paystack sandbox integration

## Scope and safety

FlowPay supports a separate Paystack Standard hosted-checkout adapter in **test mode only**. This integration is independent of Flutterwave and uses FlowPay's own customer identity, NGN wallet, ledger transaction IDs, and deposit records. It does not copy PWFB customer data or credentials.

The API refuses to initialize checkout or process webhooks unless `PAYSTACK_ENVIRONMENT=test` and `PAYSTACK_SECRET_KEY` starts with `sk_test_`. No live mode is implemented. A verified Paystack webhook records provider verification only: the FlowPay deposit and ledger transaction remain pending and `walletCredited:false`. No wallet funds are posted until a separately reviewed, atomic double-entry posting implementation is completed and tested.

## Endpoints

- `POST /customer/paystack/deposits` — authenticated FlowPay customer creates hosted checkout.
- `POST /webhooks/paystack` — Paystack webhook; validates HMAC-SHA512 signature and independently verifies the transaction with Paystack.

Request:

```json
{ "amountMinor": 250000, "idempotencyKey": "b0ca3b0d-a69c-44e2-a661-6ccf9cf9b3f1" }
```

Amount is NGN kobo (250000 = NGN 2,500.00). Retries must reuse the same UUID idempotency key. Customer email/name are read from FlowPay's authenticated Neon Auth identity, never accepted from the client.

## Render API environment

Configure only on the FlowPay **backend** service:

- `PAYSTACK_ENVIRONMENT=test`
- `PAYSTACK_SECRET_KEY=sk_test_...` (secret; never place in frontend or source control)
- `PAYSTACK_CALLBACK_URL=https://flowpay-web-jx7i.onrender.com/...` (HTTPS customer return route)
- `PAYSTACK_DEPOSIT_MIN_MINOR` (positive integer kobo)
- `PAYSTACK_DEPOSIT_MAX_MINOR` (integer kobo, >= minimum)

Set the Paystack dashboard webhook URL to `https://flowpay-backend-qz79.onrender.com/webhooks/paystack`. Paystack signs webhooks with HMAC-SHA512 using the secret key; this handler validates `x-paystack-signature`, then calls the transaction verification endpoint and checks test domain, successful status, reference, NGN currency, and exact amount.

## Database

Migration `015_paystack_sandbox_deposits.sql` creates an independent Paystack deposit table and adds nullable receipt metadata to the shared provider-event table. It does not modify customer balances, Flutterwave records, or ledger entries. It must be reviewed and applied explicitly; API startup does not run migrations.

## Not yet enabled

- Wallet crediting / ledger posting.
- Transfers / payouts.
- Dedicated virtual account assignment.
- Production or live keys.
- Provider end-to-end verification until Paystack test credentials and webhook configuration are securely set in Render.

A callback redirect is not proof of payment. Only a signed webhook plus independent server-side transaction verification is accepted as provider-verified; even then, this stage does not credit the wallet.
