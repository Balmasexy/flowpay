# FlowPay Paystack sandbox deposits

Paystack is integrated inside the existing FlowPay API. It is a separate provider adapter and uses FlowPay customer authentication, pending deposit records, a provider-specific clearing account, the existing double-entry ledger, and the shared provider-event receipt table.

## Paystack environment safety boundary

- Test mode accepts a secret beginning with `sk_test_` only when the API is not running with `NODE_ENV=production`.
- Live mode accepts a secret beginning with `sk_live_` only when `NODE_ENV=production` and `PAYSTACK_LIVE_PAYMENTS_ENABLED=true`.
- The selected environment is returned by the authenticated deposit provider status and shown in the customer checkout UI.
- Test and live checkout idempotency keys are environment-scoped. Keep test and live API services on separate databases.
- The customer identity and email are loaded from the verified FlowPay session; the browser cannot substitute an email or customer ID.
- The only supported currency is NGN. The browser submits an amount in kobo as an integer string.
- A deposit is credited only after a valid Paystack signature, independent Paystack transaction verification, matching provider reference, amount, currency, provider transaction ID, and a pending FlowPay deposit have all been confirmed.
- Live mode is not activated by this code change. It requires the actual live secret and explicit feature switch to be configured securely in Render after Paystack has approved the business for go-live.
- Live dedicated virtual accounts remain a separate approval-dependent capability. Bank payout code uses the same selected Paystack secret/environment as bank lookup but has its own environment-specific transfer switch; keep live payouts disabled until Paystack confirms Transfers access and the operational review is complete. See `docs/PAYSTACK_BANK_PAYOUTS_SANDBOX.md` and `docs/PAYSTACK_LIVE_MODE_READINESS.md`.
- The webhook posts a balanced ledger transaction atomically: a positive customer-wallet entry and equal negative entry in the dedicated `paystack_ngn_clearing` system account. A database constraint requires at least two balanced entries before the transaction can be marked posted.
- Duplicate webhook delivery cannot post a second credit. A previously received event can resume a pending deposit if its ledger posting did not complete.
- No test clearing account balance represents money held at Paystack or a bank. Sandbox credits are not real funds.
- Live money movement remains disabled.

## Render backend configuration

Configure these variables on the FlowPay backend service only. Do not put the secret in the web service, APK, source code, build arguments, or this repository.

| Variable | Value |
|---|---|
| `PAYSTACK_ENVIRONMENT` | `test` |
| `PAYSTACK_SECRET_KEY` | Paystack test secret (`sk_test_...`) |
| `PAYSTACK_CALLBACK_URL` | `https://flowpay-web-jx7i.onrender.com/payment-return/paystack` |
| `PAYSTACK_DEPOSIT_MIN_MINOR` | Approved minimum amount in kobo |
| `PAYSTACK_DEPOSIT_MAX_MINOR` | Approved maximum amount in kobo |

The backend requires positive integer min/max values and rejects amounts outside that inclusive range. The API never accepts a provider secret from the browser.

## Paystack webhook setup

Register this HTTPS endpoint in the Paystack dashboard for the **test integration**:

`https://flowpay-backend-qz79.onrender.com/webhooks/paystack`

Paystack signs the raw request body with HMAC-SHA512 using the test secret. FlowPay compares `x-paystack-signature` in constant time, then independently calls Paystack's transaction verification endpoint. Only `charge.success` events for a verified `test` transaction in NGN are eligible for ledger posting.

Do not configure the live integration to call this test-only webhook. Do not use an `sk_live_` key.

## Customer API

### Initialize checkout

`POST /customer/paystack/deposits`

Requires a verified FlowPay bearer session.

```json
{
  "amountMinor": "250000",
  "idempotencyKey": "UUID"
}
```

A successful response contains a hosted `checkoutUrl`, the FlowPay transaction ID, the unique provider reference, and `environment: "test"`. The customer UI accepts only the HTTPS host `checkout.paystack.com` before redirecting.

### Check callback status

`GET /customer/paystack/deposits/status?reference=flowpay-ps-...`

Requires the same customer's verified bearer session. A reference belonging to another customer is not returned. The API returns the persisted deposit status and whether the wallet was credited.

### Deposit history

`GET /customer/money-received`

Returns posted Flutterwave deposits plus Paystack pending, posted, and failed attempts for the authenticated customer. The Paystack part is omitted until the Paystack schema migration is applied; existing Flutterwave history remains available.

## Database migration

Apply `apps/api/migrations/016_paystack_sandbox_ledger_posting.sql` to the approved FlowPay database before accepting test deposits. The migration is additive and idempotent: it creates the Paystack deposit table, adds nullable provider-event receipt metadata when absent, extends the system-account role check, and creates a zero-opening-balance Paystack clearing account. It does not alter existing customer balances, existing ledger entries, Flutterwave deposits, or customer records.

The migration also records `015_paystack_sandbox_deposits` because the Paystack table and event columns are created in this consolidated migration to accommodate existing FlowPay databases where the older Flutterwave migration sequence is incomplete.

Never apply this migration to Production without explicit approval. Confirm the database and Neon branch before applying it.

## Operational behavior and recovery

- A provider verification or database error returns a retryable server error; the provider event is not marked processed.
- A duplicate receipt with the same payload and FlowPay transaction may safely resume a pending ledger posting.
- A posted FlowPay transaction is acknowledged as a duplicate only after its two ledger entries are checked against the customer account, clearing account, amount, and equal-and-opposite balance.
- A deposit whose account, amount, provider transaction ID, or existing ledger entries do not match is not credited automatically and requires reconciliation.
- Checkout initialization that returns an uncertain provider outcome remains pending. Do not treat an HTTP error as evidence that a payment failed or was successful; reconcile the provider reference before retrying with a new request.
