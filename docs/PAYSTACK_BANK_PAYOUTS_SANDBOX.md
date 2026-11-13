# Paystack bank transfers — environment-matched setup

## What this feature does

The customer **To Bank** screen can verify a Nigerian bank account and, when the selected environment's payout gate is enabled, submit a Nigerian NGN payout after the customer reviews the beneficiary and amount and authorizes with the existing six-digit FlowPay transaction PIN.

FlowPay re-resolves the bank account before recipient creation, submits a uniquely referenced transfer, verifies the provider response, reconciles signed transfer webhooks, and includes payout records in customer transfer history. It stores only the final four beneficiary account digits and a keyed HMAC fingerprint for idempotency; it does not persist the full beneficiary account number.

## One matching Paystack key for every bank step

There is **one Paystack credential pair per API service**, selected by `PAYSTACK_ENVIRONMENT` and `PAYSTACK_SECRET_KEY`. Bank operations use the bank runtime, which validates that the key prefix matches the selected environment but does not depend on the separate live-deposit switch. Do not create a different secret specifically for bank transfers. The same selected key and environment are used for:

1. the Nigerian bank directory;
2. account-name resolution;
3. transfer-recipient creation;
4. transfer initiation;
5. transfer status verification; and
6. signature validation of the existing `/webhooks/paystack` endpoint and subsequent payout reconciliation.

The runtime rejects mismatched combinations (for example, `PAYSTACK_ENVIRONMENT=live` with an `sk_test_` key). The customer transfer page reads the selected environment from the API instead of hard-coding a test-mode label.

### Test / sandbox API service

Configure these only on the isolated sandbox API connected to a disposable or Development Neon database:

- `PAYSTACK_ENVIRONMENT=test`
- `PAYSTACK_SECRET_KEY=sk_test_…` (store the actual secret only in Render's encrypted environment settings)
- `FLOWPAY_RUNTIME_ENV=development`
- `PAYSTACK_TRANSFERS_ENABLED=true`
- `NODE_ENV` must not be `production`

The test bank runtime requires a matching test key and a non-production Node runtime. The test payout gate additionally requires all sandbox switches. Keep this service isolated from production and connect it to a separate development database. A successful Paystack test transfer is simulated; it does **not** move real money. Use only Paystack's published sandbox bank details, never a production customer's bank account.

### Production API service

The production service must use the matching live configuration:

- `PAYSTACK_ENVIRONMENT=live`
- `PAYSTACK_SECRET_KEY=sk_live_…` (store the actual secret only in Render's encrypted environment settings)
- `PAYSTACK_LIVE_TRANSFERS_ENABLED=true` only after Paystack has enabled/approved Transfers for the FlowPay business and operational controls are confirmed

The bank directory and account-name verification need only the matching production live key and `NODE_ENV=production`. They do **not** require `PAYSTACK_LIVE_PAYMENTS_ENABLED=true`; that switch continues to govern live deposit checkout and charge-success processing. The bank payout route separately requires `PAYSTACK_LIVE_TRANSFERS_ENABLED=true`.
- `NODE_ENV=production`

The live transfer switch is separate from the general live-payment switch. A correctly configured live checkout key does not, by itself, prove that Paystack Transfers is approved or funded. Keep `PAYSTACK_LIVE_TRANSFERS_ENABLED` unset or `false` until Paystack has confirmed transfer access, the merchant balance/funding route is ready, and OTP/approval, fees, limits, failure, reversal, webhook and reconciliation procedures have been reviewed. A live bank transfer moves real money.

**Do not copy a live key into GitHub, browser code, logs, chat, or a sandbox API service.** Render's environment settings are the source of truth. If the secret is rotated, update it on the appropriate Render API service and keep `PAYSTACK_ENVIRONMENT` aligned with its prefix.

## Customer flow

1. Customer chooses a Nigerian bank from the Paystack directory, returned with the active API environment.
2. FlowPay verifies the beneficiary name with Paystack.
3. Customer reviews the beneficiary, masked account number, bank and amount.
4. Customer authorizes with the transaction PIN.
5. FlowPay re-resolves the beneficiary, creates the provider recipient in the selected domain, locks the customer's NGN wallet, checks posted balance less pending payout reservations, and creates an idempotent pending payout record. Paystack independently requires a registered business, a payout-enabled integration, valid recipient, and enough Paystack balance to cover the transfer and provider fee.
6. FlowPay submits and verifies the transfer. Only an authoritative success in the same Paystack domain posts one balanced customer-wallet debit and Paystack clearing-account credit. A final unsuccessful result fails the pending ledger transaction without debiting the wallet.
7. Pending, OTP and uncertain transfers remain reserved and can be refreshed through the status endpoint. An `otp` status is not success: Paystack requires the merchant's authorized business contact to complete its transfer approval step. The business OTP must never be requested from the customer or placed in browser code. Signed transfer webhooks are verified through the same selected secret before reconciliation.

## API routes

- `POST /customer/transfers/bank` — `accountNumber`, `bankCode`, `amountMinor`, `idempotencyKey`, and `transactionPin`.
- `GET /customer/transfers/bank/status?reference=<reference>` — authenticated owner-only status refresh.
- Existing `POST /webhooks/paystack` also handles `transfer.success`, `transfer.failed`, and `transfer.reversed` events. No second webhook URL is required.

Subscribe the matching Paystack environment's webhook to the transfer event types as well as the current charge-success event. Do not point a test webhook at a production secret or a live webhook at a test secret.

## Database prerequisite

Apply `apps/api/migrations/019_paystack_bank_transfers.sql` to the target FlowPay database only after reviewing its migration history. It adds payout tracking and indexes, relies on the Paystack NGN clearing account from migration 016 and the transaction PIN table from migration 017, and does not change existing wallet balances or ledger entries.

Do not apply migrations to production as part of this pull request. First rehearse them on a disposable Neon branch and confirm existing customer, account, deposit and ledger row counts remain unchanged.

## Verification

Run:

1. `npm run typecheck --prefix apps/api`
2. `npm run test:paystack-mode --prefix apps/api`
3. `npm run test:paystack-bank-transfers --prefix apps/api`
4. `npm run test:paystack-bank-lookup --prefix apps/api`
5. `npm run build --prefix apps/web`

Tests must verify matching key prefixes and provider domains, the closed-by-default payout switches, PIN and available-balance guards, one-time idempotency, signed webhook/status reconciliation and balanced ledger entries. Any provider integration test must use mocked responses or Paystack test credentials; CI must not initiate a live bank transfer.

## Activation boundary

Code now selects and reports the same Paystack environment throughout bank lookup and transfer handling. Bank lookup can work with a matching live key even while live deposits remain disabled. That does not prove that the Render production secret is live or that Paystack has approved/enabled live Transfers. Render's stored secrets cannot be read through this repository workflow. Verify the masked key's prefix and environment directly in the production API service's Render Environment page; only after provider approval and the operational review should an authorized operator enable `PAYSTACK_LIVE_TRANSFERS_ENABLED=true`.
