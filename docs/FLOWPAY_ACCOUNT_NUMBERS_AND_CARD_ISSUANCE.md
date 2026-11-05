# FlowPay 10-digit account numbers, dedicated bank accounts, and cards

## FlowPay wallet-transfer number

- Every active FlowPay customer, admin, or Super Admin profile receives a unique random 10-digit internal number.
- It is used only for wallet-to-wallet transfers inside FlowPay.
- It is not a Nigerian bank NUBAN and is not a payment-card PAN.
- Migration 020 rotates old sequential 12-digit internal numbers. Completed transfer history rows continue to accept their saved 12-digit destination values.
- The allocator uses a cryptographically secure random number in the API and a uniqueness check/constraint in the database. The migration also allocates numbers to any existing active Super Admin profile; it does not promote an existing user or create a Super Admin.

## Paystack dedicated virtual bank account

- A dedicated account is a separate provider-issued 10-digit NGN bank account for receiving transfers from external banks.
- The Cards page includes a separate Virtual Bank Account panel. It displays the number, bank and account name only after Paystack confirms assignment.
- The customer must explicitly consent before FlowPay sends their registered name, email and phone number to Paystack.
- The sandbox request uses Paystack's `test-bank` provider. The API requires `PAYSTACK_ENVIRONMENT=test`, an `sk_test_` secret, `FLOWPAY_RUNTIME_ENV=development`, `NODE_ENV` other than `production`, and `PAYSTACK_DEDICATED_ACCOUNTS_ENABLED=true`.
- No sandbox switches are configured by this branch, and the guard intentionally refuses to create a simulated account in the production runtime.
- Paystack states that Dedicated Virtual Accounts are available to registered Nigerian/Ghanaian businesses that have completed go-live. Some business categories, including financial services, require customer identity validation before assignment. The flow must not bypass provider eligibility or validation. See Paystack's [Dedicated Virtual Accounts guide](https://paystack.com/docs/payments/dedicated-virtual-accounts/).
- Account numbers are stored only after the provider confirms assignment. Pending or failed responses never produce a placeholder number.

## Virtual card credentials

The existing `fp_cards` table stores provider references and non-sensitive metadata only. It intentionally does not store a full PAN, CVV/CVC, card PIN, or raw card credentials.

Flutterwave's published legacy virtual-card create/retrieve endpoints return the full card PAN, CVV and expiry, but its documentation says the virtual-card service is not publicly available and requires contacting Flutterwave support for access. There is no confirmed card issuer approval or approved secure card-details reveal channel configured for FlowPay in this branch. Consequently:

- No synthetic or randomly generated card number, CVV, expiry or card PIN is shown.
- The Cards page reports card issuance as unavailable until a provider confirms this integration.
- A card PIN is not assumed to be retrievable from the virtual-card API. A card PIN flow must be provided and authorized by the issuer.
- Do not store PAN, CVV or PIN in Postgres, logs, telemetry or browser local storage. Before adding show/hide card credentials, obtain issuer approval and use its PCI-compliant secure reveal component or hosted flow.

See Flutterwave's [Create a Virtual Card reference](https://developer.flutterwave.com/v2.0/reference/create-a-virtual-card) and [Get a Virtual Card reference](https://developer.flutterwave.com/v2.0/reference/get-a-virtual-card).

## Deployment sequence

1. Review migrations 019, 020 and 021 on a disposable Neon branch; compare customer, wallet, ledger, cards and deposit counts before and after.
2. Obtain explicit approval before applying the migrations to FlowPay Development main.
3. Deploy this branch only to an isolated development API attached to a disposable/Development database. Keep Render production on `main`.
4. Configure Paystack test credentials and dedicated-account switch only on that isolated development service.
5. Confirm a customer explicitly opts in and Paystack returns an assigned test NUBAN. Verify the account number appears on both Account Details and Cards.
6. Do not enable live payouts or live virtual-account assignment through this feature. The current implementation rejects live Paystack credentials and production runtime settings.
7. Obtain Flutterwave's written approval, a sandbox issuer account, PCI scope guidance and a supported secure card-detail reveal channel before implementing card issuance or PAN/CVV/PIN display.
