# FlowPay customer routes and provider readiness

FlowPay uses OPay only as a usability benchmark. FlowPay keeps its own name, visual identity, API, provider relationships, terms, and compliance obligations. It is not affiliated with OPay and does not use OPay's proprietary assets or code.

## End-to-end customer route map

| Route / area | Implemented behavior | Current availability / boundary |
|---|---|---|
| Home / dashboard | Authenticated account overview, server-derived ledger balances, account counts, and latest posted/reversed activity | Connected to the FlowPay API. A missing or failed API response is displayed as unavailable; the client does not create balances or transactions. |
| Sign-up / login | Neon Managed Auth email/password registration and sign-in, OTP email verification during registration, password recovery by email OTP | Normal sign-in is email + password. Sign-in verification OTP is disabled. Email OTP is reserved for registration verification and password recovery. |
| Profile | Read/update phone number, address, and profile photo; name/email come from the authenticated identity | Connected to the API and development database. |
| FlowPay wallet transfers | Recipient lookup by the unique 10-digit FlowPay number, transaction PIN, idempotency, and balanced sender/recipient ledger posting | Implemented and covered by API regression tests. The FlowPay number is not a bank NUBAN. |
| To Bank transfers | Current Nigerian bank directory, account-name lookup, beneficiary confirmation, PIN, payout submission, status/history, and ledger safeguards | Backend and sandbox regression tests are present. Real payouts remain blocked unless Paystack has enabled Transfers for the business and the production API has the matching live configuration and explicit payout switch. |
| Bulk Payments | Sequential submission of reviewed Nigerian bank transfers, with per-row validation/status | Implemented as individual bank-transfer requests, not as one atomic batch. Each request remains subject to the same Paystack payout gate, beneficiary verification, PIN, idempotency, and ledger controls. |
| Bulk Verification | Sequential bank-account name checks against the selected Nigerian bank | This is bank beneficiary verification, not BVN/NIN identity verification or bulk KYC. |
| Money Received / deposits | Paystack deposit checkout/status, signed webhook settlement and ledger posting; Flutterwave test deposit flow | Provider-verified settlement only. Paystack live deposits require business go-live, live key, callback/webhook configuration, and the separate live-deposit flag. Flutterwave remains test-only. |
| Money Sent / activity | Authenticated read-only transaction history derived from ledger/provider records | Connected. These pages display records; they do not create a transfer. |
| Account Number | Unique 10-digit internal FlowPay wallet number and separate Paystack dedicated bank account status | Internal number is assigned by the backend. A bank NUBAN appears only after Paystack confirms assignment. Dedicated-account assignment is environment- and approval-gated. |
| Cards | Existing issuer-linked card metadata and a clearly marked card design preview | No issuer-confirmed card creation, PAN/CVV reveal, card PIN, freeze, or card-control integration is available. Do not treat the design preview as a payment card. |
| Airtime | VTpass API adapter, catalogue, transaction PIN, idempotent reservation, purchase, status, and settlement/reversal handling | Code and regression tests are present. Sandbox requires VTpass credentials on the API. Live purchases require separate provider approval and VTPASS_LIVE_ENABLED=true. |
| Data | VTpass plan catalogue, selected bundle validation, purchase and status handling | Same VTpass credential and environment gates as airtime. Plan availability/pricing comes from the provider. |
| Electricity / NEPA | Meter verification, prepaid/postpaid selection, provider purchase, status, and settlement/reversal handling | Same VTpass credential and environment gates. Meter details must be provider-verified before purchase. |
| Cable TV / television | Customer-facing service route | Not connected to a provider in the current implementation; it is not a completed subscription or payment service. |
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
- Paystack live dedicated virtual accounts require provider approval and customer identity/bank validation. The API must not invent a NUBAN.
- VTpass live services require separate live credentials and VTPASS_LIVE_ENABLED=true.
- Flutterwave virtual-card issuance and secure reveal remain unavailable until Flutterwave provides written product approval and an approved PCI-compliant card-data delivery mechanism.
- Smile ID is sandbox-only in the current implementation.
- Keep all provider secrets exclusively in the backend's managed environment. Never expose them to the browser or Android WebView.

## Verification coverage

The GitHub Actions workflow runs API type-checking and regression suites for Smile ID result decisions, Flutterwave checkout/webhooks, Paystack deposits/mode selection/bank directory/payouts/dedicated accounts/DVA settlement, VTpass bills, Storyblok preview, internal transfers, customer notifications, customer AI, and private deposit receipts. It also runs API readiness smoke checks, dependency audits, and a production web build.

Automated tests prove the covered code paths against their test fixtures; they do not prove Paystack/VTpass/Flutterwave business approval, live credentials, or a live-money transaction. A real authenticated user journey must still be confirmed with authorized test accounts and provider sandbox credentials.

## Launch gates still requiring external approval or setup

1. Use a dedicated production Neon branch/project with approved retention, backup/restore, access controls, and data-residency settings. The current configured Neon project is named FlowPay Development.
2. Complete production SMTP/sender-domain configuration for Neon Managed Auth, then test sign-up verification and password recovery with a new test account.
3. Obtain Paystack live product approval for deposits, Transfers, and dedicated virtual accounts separately; configure the matching Render secrets and webhook endpoints only after approval.
4. Obtain VTpass live approval and configure the three backend credentials plus the live feature switch.
5. Obtain Flutterwave virtual-card issuer approval and a PCI-compliant hosted/reveal component before advertising cards as issued.
6. Complete legal/compliance review, KYC policy, customer support staffing, fraud/chargeback operations, monitoring, alerting, incident response, reconciliation, and backup restoration drills before general live-money launch.

FlowPay must continue to show unsupported features as unavailable. Do not replace provider gates with simulated successes, fake balances, placeholder NUBANs, or invented card details.
