# Paystack bank transfers — sandbox setup

## What this feature adds

The customer **To Bank** screen can submit a Nigerian NGN test transfer after the customer confirms the resolved beneficiary and enters the existing six-digit FlowPay transaction PIN. The API creates a Paystack transfer recipient, submits a uniquely referenced transfer, verifies the provider result, reconciles transfer webhooks, and includes payout records in customer transfer history.

The API re-resolves the bank account before creating a recipient. It stores only the final four account digits and a keyed HMAC fingerprint for idempotency; it does not store the full beneficiary account number. The full account number is passed to Paystack only from the authenticated request and is not returned in a provider URL.

## Sandbox only

This integration is deliberately limited to Paystack test credentials:

- `PAYSTACK_ENVIRONMENT=test`
- `PAYSTACK_SECRET_KEY` must be an `sk_test_` key, stored only in Render's encrypted environment settings.
- `PAYSTACK_TRANSFERS_ENABLED=true` is an explicit feature switch for the sandbox payout submission route.
- `PAYSTACK_TRANSFERS_ENABLED` is not set by this branch, and no Render environment setting is changed by this feature.

The API rejects live Paystack credentials for these routes. Responses identify the environment as `test` and report `livePayoutsEnabled=false`.

**A Paystack test-mode success is simulated; it does not move real money to a bank account.** Do not use a production customer's bank account to test this feature. Use only Paystack's published sandbox beneficiary details.

## Customer flow

1. Customer chooses a Nigerian bank from the Paystack directory.
2. FlowPay calls Paystack account resolution and displays the verified name.
3. Customer enters an amount and previews the destination.
4. Customer sets or enters their FlowPay transaction PIN.
5. FlowPay re-resolves the beneficiary, creates a test NUBAN recipient, locks the customer's NGN wallet, checks the posted balance less pending payout reservations, and creates an idempotent pending payout record.
6. FlowPay submits the transfer and verifies the returned reference. A verified success posts one balanced customer-wallet debit and Paystack clearing-account credit. A final unsuccessful status fails the pending ledger transaction without debiting the wallet.
7. Pending/OTP/uncertain transfers remain reserved and can be refreshed through the status endpoint. Transfer webhooks are independently verified with Paystack before reconciliation.

## API routes

- `POST /customer/transfers/bank` — `accountNumber`, `bankCode`, `amountMinor`, `idempotencyKey`, and `transactionPin`.
- `GET /customer/transfers/bank/status?reference=<reference>` — authenticated owner-only status refresh.
- Existing `POST /webhooks/paystack` also handles `transfer.success`, `transfer.failed`, and `transfer.reversed` events. No second webhook URL is required.

Subscribe the existing Paystack **test-mode** webhook to the transfer event types as well as the current charge-success event. The API verifies each transfer against Paystack before posting ledger entries.

## Database prerequisite

Apply `apps/api/migrations/019_paystack_bank_transfers.sql` to the target FlowPay database only after reviewing its current migration history. It adds a new payout record table and indexes. It does not edit existing customer rows, account balances, deposit records, or ledger entries. It relies on the existing Paystack NGN clearing account from migration 016 and the transaction PIN table from migration 017.

Do not apply the migration to production as part of this pull request. First rehearse it on a disposable Neon branch and confirm existing customer, account, deposit, and ledger row counts remain unchanged.

## Test plan

1. Keep Paystack in test mode and use Paystack's official test bank details only.
2. Rehearse migration 019 on a disposable Neon branch.
3. Run `npm run typecheck --prefix apps/api`.
4. Run `npm run test:paystack-bank-transfers --prefix apps/api`.
5. Confirm a verified test success posts exactly two equal-and-opposite ledger entries.
6. Confirm insufficient balance and invalid PIN do not call the transfer endpoint or post ledger entries.
7. Confirm duplicate idempotency requests do not initiate a second transfer.
8. Confirm transfer webhooks and status refresh reconcile only after an authoritative provider verification.
9. Confirm pending and uncertain payouts remain reserved until a final provider result is known.

Only after sandbox tests and the provider configuration are verified should a separate approval be made to merge, deploy, and set the sandbox feature switch in Render.

## Live payouts are out of scope

Live payouts remain disabled. They need a separate risk, compliance, business eligibility, provider-balance, fees, OTP/approval, and reconciliation review. The sandbox implementation is not evidence of a live bank payout capability.
