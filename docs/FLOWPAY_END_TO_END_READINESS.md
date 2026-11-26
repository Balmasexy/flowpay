# FlowPay end-to-end readiness

FlowPay uses OPay only as a usability benchmark. FlowPay keeps its own name, visual identity, API, provider relationships, terms, and compliance obligations. It is not affiliated with OPay and does not use OPay's proprietary assets or code.

## End-to-end customer route map

| Route / area | Implemented behavior | Current availability / boundary |
|---|---|---|
| Home / dashboard | Authenticated account overview, server-derived ledger balances, account counts, and latest posted/reversed activity | Connected to the FlowPay API. A missing or failed API response is displayed as unavailable; the client does not create balances or transactions. |
| Sign-up / login | Neon Managed Auth email/password registration and sign-in, OTP email verification during registration, password recovery by email OTP | Normal sign-in is email + password. Sign-in verification OTP is disabled. Email OTP is reserved for registration verification and password recovery. Neon is configured to revoke existing sessions after a successful password reset. |
| Profile | Read/update phone number, address, and profile photo; name/email come from the authenticated identity | Connected to the API and development database. |
| FlowPay wallet transfers | Recipient lookup by the unique 10-digit FlowPay number, transaction PIN, idempotency, and balanced sender/recipient ledger posting | Implemented and covered by API regression tests. The FlowPay number is not a bank NUBAN. |
| To Bank transfers | Current Nigerian bank directory, account-name lookup, beneficiary confirmation, PIN, payout submission, status/history, and ledger safeguards | Backend and sandbox regression tests are present. Real payouts remain blocked unless Paystack has enabled Transfers for the business and the production API has the matching live configuration and explicit payout switch. |
| Bulk Payments | Sequential submission of reviewed Nigerian bank transfers, with per-row validation/status | Implemented as individual bank-transfer requests, not as one atomic batch. Each request remains subject to the same Paystack payout gate, beneficiary verification, PIN, idempotency, and ledger controls. |
| Bulk Verification | Sequential bank-account name checks against the selected Nigerian bank | This is bank beneficiary verification, not BVN/NIN identity verification or bulk KYC. |
| Money Received / deposits | Paystack deposit checkout/status, signed webhook settlement and ledger posting; Flutterwave test deposit flow | Provider-verified settlement only. Paystack live deposits require business go-live, live key, callback/webhook configuration, and the separate live-deposit flag. Flutterwave remains test-only. |
| Money Sent / activity | Authenticated read-only transaction history derived from ledger/provider records | Connected. These pages display records; they do not create a transfer. |
| Account Number | Unique 10-digit internal FlowPay wallet number and separate Paystack dedicated bank account status | The internal number is for FlowPay-to-FlowPay transfers only. An active Paystack DVA NUBAN can receive NGN from other Nigerian bank apps; its number and bank-visible name appear only after provider confirmation. FlowPay's requested `FlowPay / customer name` format requires Paystack custom-naming approval and is never fabricated locally. |
| Cards | Existing issuer-linked card metadata and a clearly marked card design preview | No issuer-confirmed card creation, PAN/CVV reveal, card PIN, freeze, or card-control integration is available. Do not treat the design preview as a payment card. |
| Airtime | VTpass API adapter, catalogue, transaction PIN, idempotent reservation, purchase, status, and settlement/reversal handling | Code and regression tests are present. Sandbox requires VTpass credentials on the API. Live purchases require separate provider approval and VTPASS_LIVE_ENABLED=true. |
| Data | VTpass plan catalogue, selected bundle validation, purchase and status handling | Same VTpass credential and environment gates as airtime. Plan availability/pricing comes from the provider. |
| Electricity / NEPA | Flutterwave utility-bill categories, electricity billers and item catalogue; meter validation; prepaid/postpaid selection; customer-wallet reservation; provider status requery; balanced ledger posting after confirmed delivery; prepaid token display | Uses Flutterwave's Nigerian Utility Bills category and electricity billers. Requires migration `023_flutterwave_utility_bills.sql`, `FLW_BILLS_ENVIRONMENT`, a matching server-only `FLW_SECRET_KEY`, and a funded/approved Flutterwave source balance. Live execution additionally requires `FLW_BILLS_LIVE_ENABLED=true` and the provider's merchant/IP approval. Pending or unconfirmed outcomes remain reserved. |
| Cable TV / television | VTpass DStv, GOtv and StarTimes catalogue, server-side smartcard verification, provider-priced bouquet selection, transaction-PIN authorization, idempotent wallet reservation, provider status requery and balanced ledger settlement/reversal | Implemented in the current completion PR using the existing VTpass billing ledger. Requires reviewed additive migration `029_vtpass_cable_tv.sql` and the same backend-only VTpass credentials as airtime/data. Live purchases remain disabled until VTpass live approval and `VTPASS_LIVE_ENABLED=true`. |
| Savings / fixed savings / spend-save | Planning and goal previews | No savings account, investment product, recurring debit, interest accrual, or withdrawal is connected. |
| Betting | Local funding-detail preview | No operator validation or provider-backed funding; it cannot debit a wallet. |
| Documents | Customer document checklist and read-only status messaging | Secure document upload, object storage, malware scanning, retention, and staff review are not connected. Do not upload identity documents here. |
| Security | Read-only recorded passkey/security events and capability state; separate transaction PIN status/setup used by protected financial actions | Password changes, passkey enrollment, MFA, trusted-device management, and session revocation are not available through the customer Security page. |
| Face verification | Smile ID callback verification and liveness decision logic | Sandbox-only. It requires the configured Smile ID sandbox credentials and HTTPS callback. It is not production KYC approval. |
| Notifications | Authenticated customer notifications and read controls | Connected and covered by API regression tests. |
| Help & support | Authenticated support-ticket submission and request history | Connected to the support API. It does not replace a staffed dispute-resolution and regulatory complaints process. |
| Deposit receipts / admin | Private receipt upload and protected admin review/approval controls | API and regression coverage are present. A reviewer must independently confirm funds reached the bank before approval/credit. |
| BALMZ AI assistant | Authenticated customer assistant endpoint | Connected to the API; availability depends on its configured server-side AI credentials and service access. |
| Admin | Super Admin session check and protected receipt/DVA operations | Access is server-authorized. A separate production admin MFA and maker-checker operations programme is still required. |
| Invitations / referrals | Navigation and introductory UI | A production referral/reward service is not connected. |

## Financial safety and provider gates

- Ledger state is authoritative. Do not display a client-side success as a settled payment.
- A provider checkout URL or initiated transfer is not proof of settlement. Verify the provider status and post one balanced ledger transaction only.
- Paystack live deposits, live bank payouts, and live dedicated virtual-account assignment have separate settings. Do not enable one by enabling another.
- Live Paystack payouts require Paystack business Transfers approval, a matching sk_live key, PAYSTACK_ENVIRONMENT=live, production runtime, and PAYSTACK_LIVE_TRANSFERS_ENABLED=true.
- Paystack live deposits require their own live checkout flag, verified webhook, callback URL, and settlement/reconciliation configuration.
- Paystack live dedicated virtual accounts require provider approval, express customer consent and customer identity/bank validation. An assigned Paystack DVA accepts external NGN bank transfers, with wallet credit only after signed webhook, transaction-verification and balanced-ledger checks. Paystack controls bank-side account-name enquiry; FlowPay's desired `FlowPay / customer name` label requires its custom DVA naming feature to be enabled by Paystack. The API must not invent a NUBAN or rename the bank record locally.
- VTpass live airtime/data services require separate live credentials and VTPASS_LIVE_ENABLED=true.
- Flutterwave utility bills require `FLW_BILLS_ENVIRONMENT=test` with a `FLWSECK_TEST-` key for sandbox, or `FLW_BILLS_ENVIRONMENT=live`, `FLWSECK_LIVE-`, production runtime, and `FLW_BILLS_LIVE_ENABLED=true` for live. Complete merchant KYC, fund the Flutterwave source balance, and allowlist the Render outbound IP before live use.
- Flutterwave virtual-card issuance and secure reveal remain unavailable until Flutterwave provides written product approval and an approved PCI-compliant card-data delivery mechanism.
- Smile ID is sandbox-only in the current implementation.
- Keep all provider secrets exclusively in the backend's managed environment. Never expose them to the browser or Android WebView.

## Verification coverage

The GitHub Actions workflow runs API type-checking and regression suites for Smile ID result decisions, Flutterwave checkout/webhooks/utility bills, Paystack deposits/mode selection/bank directory/payouts/dedicated accounts/DVA settlement, VTpass bills, Storyblok preview, internal transfers, customer notifications, customer AI, and private deposit receipts. It also runs API readiness smoke checks, dependency audits, and a production web build.

Automated tests prove the covered code paths against their test fixtures; they do not prove Paystack/VTpass/Flutterwave business approval, live credentials, or a live-money transaction. A real authenticated user journey must still be confirmed with authorized test accounts and provider sandbox credentials.

## Launch gates still requiring external approval or setup

1. Use a dedicated production Neon branch/project with approved retention, backup/restore, access controls, and data-residency settings. The current configured Neon project is named FlowPay Development.
2. Complete production SMTP/sender-domain configuration for Neon Managed Auth, then test sign-up verification and password recovery with a new test account.
3. Obtain Paystack live product approval for deposits, Transfers, and dedicated virtual accounts separately; configure the matching Render secrets and webhook endpoints only after approval.
4. Obtain VTpass live approval and configure the three backend credentials plus the live feature switch. Flutterwave Utility Bills requires a funded source balance, bill-payment product activation, and Render outbound IP allowlisting.
5. Obtain Flutterwave virtual-card issuer approval and a PCI-compliant hosted/reveal component before advertising cards as issued.
6. Complete legal/compliance review, KYC policy, customer support staffing, fraud/chargeback operations, monitoring, alerting, incident response, reconciliation, and backup restoration drills before general live-money launch.

FlowPay must continue to show unsupported features as unavailable. Do not replace provider gates with simulated successes, fake balances, placeholder NUBANs, or invented card details.



## Customer UI completion pass

- Shared customer UI now defines the previously missing savings-planner form grid, stacked field labels, inputs, preview cards, and mobile single-column layout. This fixes the unstyled/horizontally compressed savings form on narrow screens.
- Shared customer panels, headings, field focus states, validation text, empty states, and compact service cards use consistent FlowPay orange/charcoal styling.
- The More services hub uses responsive cards and its descriptions distinguish the internal FlowPay ID from an externally assigned bank account.
- The legacy TV route is labelled Cable TV and carries the same VTpass DStv/GOtv/StarTimes flow and readiness message as the current Cable TV route.
- Savings and Spend & Save clearly state that the calculations are not persisted and do not move money. Their preview updates are announced to assistive technology.
- The BALMZ AI launcher and chat panel are constrained to the mobile viewport and respect phone safe areas.
- Customer navigation retains the desktop sidebar, mobile All services sheet, and bottom navigation. Reduced-motion and keyboard-focus styles are included.
- Provider-dependent pages remain visibly gated; UI styling does not imply an issuer/provider is connected or a payment is live.
