# FlowPay Paystack live-mode readiness

## What this branch enables

The Paystack deposit checkout, webhook signature verification, and deposit-status response now resolve the active Paystack environment through a shared fail-closed configuration check.

- Test mode accepts an `sk_test_` key only when `NODE_ENV` is not `production`.
- Live mode accepts an `sk_live_` key only when `NODE_ENV=production` and `PAYSTACK_LIVE_PAYMENTS_ENABLED=true`.
- Checkout idempotency keys include the environment so test and live references cannot collide if environments are accidentally pointed at the same database.
- Webhook transaction verification requires Paystack's verified transaction domain to match the configured environment.
- The dedicated-account assignment path remains separate and test-only. Bank payouts use the same selected Paystack runtime/key as bank lookup and are gated separately by `PAYSTACK_LIVE_TRANSFERS_ENABLED=true`; this change does not silently enable that switch or issue live virtual accounts.

## Production Render configuration

Only after Paystack confirms the FlowPay business is live, configure these on the production API service in Render:

- `PAYSTACK_ENVIRONMENT=live`
- `PAYSTACK_SECRET_KEY=sk_live_...` (store the actual secret only in Render; never in GitHub or chat)
- `PAYSTACK_LIVE_PAYMENTS_ENABLED=true`
- `PAYSTACK_LIVE_TRANSFERS_ENABLED=true` only after Paystack separately approves/enables Transfers for the FlowPay business and payout operations are ready
- `PAYSTACK_CALLBACK_URL=https://flowpay-web-jx7i.onrender.com/payment-return/paystack` (must be the actual deployed callback route)
- `PAYSTACK_DEPOSIT_MIN_MINOR` and `PAYSTACK_DEPOSIT_MAX_MINOR` (NGN kobo limits approved by the business)

Keep the test keys and `PAYSTACK_ENVIRONMENT=test` on a separate development API connected to a separate development Neon database. Do not point test and live API instances at the same database.

Do not set `PAYSTACK_LIVE_PAYMENTS_ENABLED=true` until the live secret key, callback URL, webhook configuration, database readiness, and Paystack go-live approval have all been independently confirmed.

## Webhook setup

Configure Paystack Live Mode to send `charge.success` to:

`https://flowpay-backend-qz79.onrender.com/webhooks/paystack`

The webhook handler verifies the HMAC signature using the configured live secret key, then independently calls Paystack's transaction verification endpoint. It checks the reference, NGN amount, currency, provider transaction ID, success status, and live transaction domain before posting the balanced ledger entries. Duplicate webhook events are protected by the payment-event uniqueness key and transaction row locks.

A successful checkout initialization is not a successful deposit. Only a provider-verified successful transaction is posted to the customer's ledger.

## Not enabled by this change

- Paystack live dedicated virtual accounts: the current dedicated-account route still only supports the isolated test flow. FlowPay's financial-services business category must collect customer consent and validate a bank account linked to the customer's BVN before a live DVA can be assigned. The async identity and account-assignment webhooks must be completed before showing an account number.
- Paystack live bank payouts: the route now selects the same `PAYSTACK_ENVIRONMENT` and `PAYSTACK_SECRET_KEY` as bank lookup, recipient creation, transfer verification and webhook reconciliation. It stays disabled unless the production runtime has a valid `sk_live_` key, `PAYSTACK_LIVE_PAYMENTS_ENABLED=true`, and the separate `PAYSTACK_LIVE_TRANSFERS_ENABLED=true` switch. Do not enable real payouts until Paystack confirms Transfers access and the merchant funding, recipient approval/OTP, fees/limits, failure, reversal, webhook and reconciliation procedures are independently tested. See `docs/PAYSTACK_BANK_PAYOUTS_SANDBOX.md`.
- Airtime, data, and NEPA electricity bills: no VTpass credentials or provider transaction flow currently exist in this repository. VTpass requires separate sandbox/live API credentials. Its POST requests use API key and secret key headers; GET requests use API key and public key headers. Request IDs must start with a Lagos-time `YYYYMMDDHHII` timestamp and be at least 12 characters. Do not credit a customer or mark a bill paid until provider status confirms fulfilment.
- Bulk payment execution and external bulk identity verification: these remain incomplete and must not be represented as completed by CSV validation alone.

## Safe first live test

After the business is approved for live mode and the live credentials are stored in Render:

1. Confirm `/health` and `/ready` are healthy.
2. Confirm the live callback and webhook URL are reachable over HTTPS.
3. Enable live mode for a restricted internal tester account first.
4. Initiate one low-value, explicitly approved payment.
5. Verify it appears in Paystack Live Mode and in FlowPay's ledger exactly once.
6. Test duplicate webhook delivery and status refresh.
7. Reconcile the Paystack transaction report against the FlowPay clearing ledger before opening access to customers.

A live test moves real money and may incur provider fees. Never use a fake balance or a fabricated provider response as evidence of success.
