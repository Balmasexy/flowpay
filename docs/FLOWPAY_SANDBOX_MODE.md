# FlowPay Sandbox Mode

## Safety boundary

Sandbox operations are enabled only when the backend environment variable
`FLOWPAY_SANDBOX_ENABLED=true` is explicitly set. When absent or false, every
`/v1/sandbox/*` route returns 404. All operations require a verified FlowPay
Bearer access token and an active linked FlowPay customer profile.

Sandbox accounts, transactions, and entries live only in
`fp_sandbox_accounts`, `fp_sandbox_transactions`, and `fp_sandbox_entries`.
They are deliberately separate from `fp_accounts`, `fp_ledger_transactions`,
and `fp_ledger_entries`. Sandbox actions never call Flutterwave, a bank, OPay,
a POS provider, or any other external payment provider. They do not create
production ledger entries or change real balances.

## API

All amounts are positive integer strings in NGN kobo. Supply a unique
`Idempotency-Key` header for every POST.

| Method | Route | Behaviour |
|---|---|---|
| GET | `/v1/sandbox/account` | Create/retrieve the caller's isolated NGN test account and balance |
| GET | `/v1/sandbox/transactions` | Return the caller's latest 100 sandbox transactions |
| POST | `/v1/sandbox/deposits` | Add simulated test funds, balanced against sandbox clearing |
| POST | `/v1/sandbox/withdrawals` | Debit test funds, balanced against sandbox clearing |
| POST | `/v1/sandbox/payments` | Simulate a merchant payment from test funds |
| POST | `/v1/sandbox/transfers` | Transfer test funds to another sandbox account ID |

Example deposit body:

```json
{ "amountMinor": "2500000" }
```

Example transfer body:

```json
{ "amountMinor": "125000", "destinationSandboxAccountId": "sandbox-account-uuid" }
```

The account ID used for a transfer must be a sandbox customer account. It is
not a real bank account number. Withdrawals and payments fail when the sandbox
balance is insufficient. Duplicate idempotency keys replay the original
operation only when the operation parameters match; mismatches return HTTP 409.

## Activation checklist

1. Review and merge this change after CI and API tests pass.
2. Apply migration `008_sandbox_mode` to the intended FlowPay database using
   the approved migration process. Do not run it automatically on production.
3. Set `FLOWPAY_SANDBOX_ENABLED=true` on the FlowPay backend only after the
   migration is confirmed. This flag exposes isolated test workflows, not live
   payment processing.
4. Add the customer-facing Sandbox page and bulk batch simulator. These are
   separate UI tasks; the current bulk pages remain validation/review only.
5. Verify the sandbox balance and production balance independently before
   release. Production ledger tables must remain unchanged after every test.

## Not included

This foundation does not perform real bank account-name verification, real
withdrawals, real deposits, live card processing, provider settlement, or live
POS transactions. Bulk payments remain non-submitting until a dedicated
sandbox batch workflow and approval controls are implemented. Never interpret a
sandbox success as a real payment confirmation.
