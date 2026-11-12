# FlowPay Paystack deposits and environment separation

Paystack is integrated inside the existing FlowPay API. FlowPay uses a server-side Paystack adapter, verified customer authentication, pending deposit records, a provider-specific clearing account, the double-entry ledger, signed webhooks, independent provider verification, and idempotent event handling.

## Separate Test and Live credentials

Configure the following variables on the **FlowPay backend only**. Never add Paystack secrets to the web service, browser bundle, Android APK, build arguments, source code, or GitHub.

| Variable | Purpose |
|---|---|
| `PAYSTACK_ENVIRONMENT` | Selects `test` or `live` for new checkout and bank-lookup operations |
| `PAYSTACK_TEST_SECRET_KEY` | Dedicated Test secret beginning with `sk_test_` |
| `PAYSTACK_LIVE_SECRET_KEY` | Dedicated Live secret beginning with `sk_live_` |
| `PAYSTACK_LIVE_ENABLED` | Must be `true` before the Live secret can be selected; keep `false` until Live is separately approved |
| `PAYSTACK_SECRET_KEY` | Legacy Test-only fallback while migrating older configurations; never used for Live |
| `PAYSTACK_CALLBACK_URL` | Canonical HTTPS callback URL |
| `PAYSTACK_DEPOSIT_MIN_MINOR` | Approved minimum amount in kobo |
| `PAYSTACK_DEPOSIT_MAX_MINOR` | Approved maximum amount in kobo |

The API validates the key prefix against the selected mode. Test-specific credentials take priority over the legacy `PAYSTACK_SECRET_KEY`. A Live request requires `PAYSTACK_LIVE_SECRET_KEY` and `PAYSTACK_LIVE_ENABLED=true`; a Test key is never accepted in Live mode or vice versa.

The API uses hosted checkout initialized server-to-server. A Paystack public key is not required by this backend flow.

## Webhook registrations

Register separate HTTPS webhook URLs in the matching Paystack integration:

- Test: `https://flowpay-backend-qz79.onrender.com/webhooks/paystack/test`
- Live: `https://flowpay-backend-qz79.onrender.com/webhooks/paystack/live`

The legacy `/webhooks/paystack` endpoint remains Test-only for compatibility. Each endpoint verifies the raw-body HMAC-SHA512 signature using the matching environment's secret. FlowPay then independently verifies the transaction and checks the provider domain, reference, amount, currency, and provider transaction ID before posting a balanced ledger transaction.

New references include the mode (`flowpay-ps-test-…` or `flowpay-ps-live-…`), and idempotency is namespaced by mode. Existing sandbox references without a mode marker remain valid on the Test webhook only.

## Supported behavior and safety boundaries

- Customer deposits can use the selected Test or Live mode when the corresponding server configuration is valid.
- Bank directory and account-name lookup use the selected mode and corresponding credential.
- Existing Paystack deposit records and ledger posting remain on the existing FlowPay schema; this branch adds no database migration.
- Payouts/bank transfers remain sandbox-only and development-only. They are not enabled for Live by this change.
- Paystack dedicated virtual-account provisioning remains test-only and requires its existing development and explicit feature guards. Live DVA provisioning is not enabled by this change.
- No customer balance is credited from a browser callback or unsigned webhook.
- No real charge is initiated by configuration or deployment; a customer must still deliberately start checkout.
- An uncertain provider result remains pending and must be reconciled before retrying.

## Test configuration

Use a dedicated Test key:

```dotenv
PAYSTACK_ENVIRONMENT=test
PAYSTACK_TEST_SECRET_KEY=sk_test_replace_with_the_test_key
PAYSTACK_LIVE_ENABLED=false
```

The legacy `PAYSTACK_SECRET_KEY` may be retained temporarily for existing Test-only services. Move it into `PAYSTACK_TEST_SECRET_KEY` when ready.

## Live configuration — do not activate without approval

Set the Live variables only after the merchant's Live integration, settlement account, business eligibility, limits, callback URL, webhook, and reconciliation process have been checked:

```dotenv
PAYSTACK_ENVIRONMENT=live
PAYSTACK_LIVE_SECRET_KEY=sk_live_replace_with_the_live_key
PAYSTACK_LIVE_ENABLED=false
```

The Live key must be entered only in the Render backend's encrypted Environment settings. Keep the Live enable switch false until the owner explicitly approves activation. Do not overwrite or delete Test credentials.

## Database migration

The existing Paystack deposit schema is required before deposit checkout can post to the FlowPay ledger. Apply the approved Paystack schema migrations only after confirming the intended Neon database and branch. This code change does not execute any migration and does not alter existing ledger rows or balances.

## Customer API

### Initialize checkout

`POST /customer/paystack/deposits`

Requires a verified FlowPay bearer session. The browser submits an amount in kobo as an integer string and a UUID idempotency key. The API loads the customer identity and email from the verified session.

### Check callback status

`GET /customer/paystack/deposits/status?reference=flowpay-ps-…`

Requires the same customer's verified bearer session. The reference identifies the mode and the API returns only that customer's persisted deposit state.
