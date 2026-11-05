# FlowPay deposit receipts

Customer receipt uploads are private evidence attached to an existing Paystack deposit reference. They are intended for support investigation, not automatic wallet funding.

## Customer routes

- `POST /customer/paystack/deposits/receipt` accepts `reference`, `fileName` and `imageDataUrl`.
- `GET /customer/paystack/deposits/receipt?reference=<reference>` returns the customer's own receipt-review state.

Only an active, email-verified FlowPay customer can use these routes. The reference must identify a Paystack deposit already owned by that customer.

Accepted images are JPEG, PNG and WebP, up to 4 MiB. Image signatures are checked, identical uploads are deduplicated, and at most three uploads are accepted for a deposit in a rolling 24-hour period.

## Administrator routes

- `GET /admin/deposit-receipts?status=pending_review` lists the private review queue.
- `GET /admin/deposit-receipts/<receipt-id>/file` streams the private image.
- `PATCH /admin/deposit-receipts/<receipt-id>/review` sets `evidence_accepted` or `rejected` with an optional review note.

These routes require a signed-in, email-verified, active FlowPay `admin` or `super_admin` role. Review changes are one-time and written to the security audit table.

## Wallet-credit boundary

Uploading a receipt, viewing it, or accepting its evidence never creates a ledger transaction and never changes a customer balance. The current verified Paystack webhook and provider-verification path remains the only automatic deposit-credit path. A receipt can prompt an investigation, but the image itself is not proof of settlement.

## Database

Migration `018_deposit_receipt_review` creates the private receipt table and indexes. It does not modify customers, wallet accounts, balances or ledger rows. Apply it only after the temporary-branch rehearsal has been reviewed and the FlowPay database owner explicitly approves applying it to the shared branch.
