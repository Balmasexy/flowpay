# FlowPay customer routes and service readiness

## Purpose

This document records the customer-facing web route map and the OPay feature benchmark used for FlowPay product completeness. OPay is a usability and feature reference only; FlowPay must retain its own name, design, APIs, terms, and compliance obligations.

## Customer route map

| Route | Customer page | Expected capability | Current release state |
|---|---|---|---|
| / | Home | Balance summary, quick services, recent activity | UI only; balance must come from authenticated ledger |
| /transfers | Transfers | FlowPay and Nigerian bank transfers, beneficiaries, limits, receipts | Not connected |
| /cards | Cards | Virtual/physical card requests, secure view, freeze, PIN, limits | Not connected |
| /activity | Transaction history | Search, filter, transaction detail, receipts, export | Not connected |
| /airtime | Airtime | MTN, Airtel, Glo, 9mobile top-up | UI only; provider and ledger APIs absent |
| /data | Data | Network-specific data plans and purchase | UI only; provider and ledger APIs absent |
| /bills | Bill payments | Electricity and supported utility providers | UI only; provider and ledger APIs absent |
| /cable-tv | Cable TV | DStv, GOtv, StarTimes subscription and verification | UI only; provider and ledger APIs absent |
| /savings | Savings | Goals, recurring/fixed savings, withdrawals, statements | Not connected |
| /profile | My profile | Customer details, account tier/status, account number | UI only; authentication/profile API absent |
| /documents | Documents | Identity, BVN/NIN evidence, address, statements, receipts | UI only; secure document storage absent |
| /security | Security | Password, passkeys, MFA, sessions, transaction PIN, recovery | Not connected |
| /support | Help & support | FAQs, complaints, disputes, issue tracking | UI only; support workflow absent |

## OPay benchmark checklist

Public OPay product information describes:
- wallet funding, transfers to other Nigerian banks, and transaction history;
- airtime and data for MTN, Airtel, Glo, and 9mobile;
- electricity, television, internet and other bill payments;
- debit/virtual card access and card controls;
- savings products;
- biometric/security features, notifications, account/card controls, and support.

FlowPay should consider equivalent customer needs, but implement each only after the relevant backend, provider contract, operational process, and compliance review exist. No OPay branding, private systems, code, or customer data should be copied.

## Critical API readiness gap

The current API implementation exposes only:
- `GET /`
- `GET /health`
- `GET /ready`

It does not currently expose customer authentication, profile, document upload, account balance, ledger history, transfers, card issuing, airtime/data vending, bill payments, savings, security settings, notifications, or support endpoints. Therefore the web routes in this release are navigation and product-surface work only. They must not imply that any money movement or provider purchase is operational.

## Required backend delivery sequence

1. Authentication and sessions: secure registration/login/logout, password recovery, passkeys, MFA, device/session revocation, role checks.
2. Customer profile and KYC: customer record, tiering, BVN/NIN verification provider, consent and audit trails. Store only necessary verification references; protect sensitive data.
3. Ledger and account services: double-entry journal, account ownership, available/ledger balance, idempotency, reversals, reconciliation, transaction limits.
4. Transfers: internal transfers first, then bank transfer provider integration, beneficiary checks, status polling/webhooks, receipts and disputes.
5. Airtime/data: provider catalogue and price lookup, recipient validation, idempotent order, asynchronous fulfilment, reversal/refund and reconciliation. Include Airtel explicitly alongside MTN, Glo and 9mobile.
6. Bills: electricity meter validation/token vending, TV smartcard validation/subscription, internet and other contracted billers.
7. Cards: issuer/processor integration, PCI scope review, tokenized card display, freeze/unfreeze, PIN and limit controls.
8. Savings: licensed partner/product contracts, clear disclosures, accrual and redemption ledger entries, statements.
9. Documents: encrypted object storage, malware/type/size validation, signed access URLs, retention and deletion policy, access audit.
10. Notifications/support: transaction alerts, email/SMS/push delivery, complaints, disputes, ticket history and SLA tracking.
11. Admin operations: separate protected staff/admin area, least-privilege RBAC, MFA, maker-checker controls and immutable audit events.

## Safety and release rules

- No fake balances, sample transactions presented as real, or invented account details.
- No customer data or balances are modified by the route/UI work.
- Payment and provider actions remain disabled until server-side verification, ledger posting, idempotency, webhooks and reconciliation tests pass.
- Flutterwave remains sandbox-only unless a separate, explicit live-launch approval and compliance gate is completed.
- Do not store BVN, NIN, card PAN, PIN, passwords, or provider secrets in browser storage or logs.
- Customer profile and documents must be fetched only after authentication and authorization.
- Build and release the web application only for this task. Do not create, build, or publish an APK.

## Acceptance checks for this web UI

- No desktop sidebar is rendered.
- Every route above can be opened directly by URL and via customer navigation.
- Airtel is visible in the dashboard network list and selectable on the airtime/data pages.
- Profile and documents have dedicated pages.
- Unsupported financial actions are clearly disabled and never report a false success.
- Existing balances, ledger records, and customer data remain untouched.
