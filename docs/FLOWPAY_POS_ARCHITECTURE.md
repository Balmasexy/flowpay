# FlowPay POS: multi-provider integration architecture

## Scope and release safety

This is an integration foundation for the existing FlowPay platform. It covers:
- FlowPay Merchant Android app (including supported Android phones).
- Existing Android POS terminals and other terminal families through provider-approved SDKs/APIs.
- A provider adapter boundary so one provider's protocol does not leak into merchant UI or ledger code.

**Release state: sandbox/development only.** No live payment provider is enabled, no live credentials are stored, and no payment is submitted by this foundation. Existing customer, account, card, and ledger tables are not altered. Migration `007_pos_integration_foundation` adds POS-specific tables only.

A normal Android phone is not automatically a certified card terminal. NFC card acceptance requires a supported Tap-to-Phone/Tap-to-Pay provider, device/OS eligibility, security controls, certification and provider onboarding. QR or payment-request flows may be available separately. FlowPay must not collect card PINs, track data, full PAN, CVV, or other sensitive authentication data.

## System boundaries

1. **Merchant clients**: web dashboard and Android application. They create payment intents and display provider-confirmed states; they never declare a payment successful.
2. **FlowPay API**: authenticates the merchant, checks ownership and permissions, validates amount/currency/terminal state, applies idempotency, and records audit events.
3. **POS integration gateway**: provider-neutral interfaces with isolated adapters for provider APIs, terminal SDKs, terminal-push flows and QR flows.
4. **Provider/terminal**: collects card/PIN interaction on the certified device and returns an authenticated result.
5. **Reconciliation and ledger boundary**: only a server-verified, final provider event may enter a separately reviewed ledger-posting workflow. A timeout, client redirect, terminal screen or unverified webhook is not proof of payment.

## Adapter contract

Implement each provider behind a common contract with operations equivalent to:
- `capabilities()`: supported terminal models, currencies, payment methods, SDK/API mode and sandbox support.
- `registerTerminal()` / `getTerminalStatus()`: provider-authorized device registration and status.
- `createPaymentIntent()`: request a payment using FlowPay's stable intent ID and idempotency key.
- `getPaymentStatus()`: server-side status lookup for pending/ambiguous outcomes.
- `verifyWebhook()`: provider-specific signature, timestamp and event authenticity verification.
- `normalizeEvent()`: map provider payloads to a small internal event vocabulary without retaining cardholder secrets.

The TypeScript contract lives in `apps/api/src/pos/provider.ts`; `PosProviderRegistry` is an explicit allow-list and starts empty, so an unconfigured provider cannot be called. An adapter must fail closed when credentials, provider approval, terminal capability, signature verification or environment configuration is absent. Provider secrets belong in Render environment secrets or another secret manager, never in app bundles, database metadata, logs or Git.

## Provider onboarding matrix

Provider support is capability-based, not a promise that every terminal can be controlled:
- **Moniepoint**: candidate for the first terminal-push/custom-app adapter after commercial onboarding and access to its current SDK/API documentation, test credentials and approved test device.
- **PAX / Sunmi / Newland / Ingenico**: separate adapters only where the acquiring/payment partner and manufacturer provide the relevant approved SDK/API, keys, firmware support and certification path.
- **Other bank/fintech POS fleets (including OPay)**: integrate only through a documented partner API or approved terminal application. A merchant's ordinary POS login is not API authorization.
- **Android phone acceptance**: separate Tap-to-Phone provider adapter; otherwise offer QR/payment request only. Do not emulate a card reader using generic NFC APIs.

The provider registry should expose `not_configured`, `sandbox_pending`, `sandbox_ready`, `approval_pending`, `approved`, `suspended` and `revoked` states. Only an explicitly approved provider integration can be considered for production review.

## API contract to implement

All merchant routes require a valid authenticated session and merchant ownership checks:
- `GET /v1/pos/providers` — list configured providers and their verified capabilities.
- `GET /v1/pos/terminals` — list the authenticated merchant's terminals.
- `POST /v1/pos/terminals` — register/link a terminal; require provider-specific proof/registration.
- `GET /v1/pos/terminals/:id` — inspect terminal status.
- `POST /v1/pos/payment-intents` — create an intent with amount, currency, terminal and Idempotency-Key.
- `GET /v1/pos/payment-intents/:id` — retrieve only the merchant's intent.
- `POST /v1/pos/payment-intents/:id/cancel` — request cancellation where provider supports it.
- `POST /v1/pos/webhooks/:provider` — verify exact raw request bytes and provider signature before accepting an event.
- `GET /v1/pos/reports/summary` — aggregate only persisted, verified records.

Never expose provider credentials or accept client-supplied `succeeded` status. For repeated idempotency keys, return the original intent only if the request parameters match; otherwise return conflict. Pending and timeout outcomes must be reconciled before retrying or presenting success.

## Data model introduced by migration 007

- `fp_pos_provider_connections`: merchant/provider/mode and approval state; `credential_ref` is only a secret-manager reference, not a secret.
- `fp_pos_terminals`: merchant-owned terminal metadata and connection state; no card data.
- `fp_pos_payment_intents`: amount in minor units, currency, idempotency key and provider-confirmed lifecycle.
- `fp_pos_webhook_events`: provider event deduplication and payload digest; raw payload is deliberately not stored.
- `fp_pos_audit_events`: actor and action trail.

The migration defaults provider live access off and constrains `live_enabled` to false. It does not write to `fp_accounts`, `fp_ledger_transactions` or `fp_ledger_entries`.

## Required tests before sandbox sign-off

- Merchant A cannot read or operate Merchant B's terminals or intents.
- Duplicate idempotency request returns the original intent; changed parameters conflict.
- Invalid/missing webhook signature is rejected; duplicate event IDs are deduplicated.
- Out-of-order, delayed, replayed and unknown events do not create success.
- Provider timeout stays pending until status reconciliation resolves it.
- No adapter credentials or card data appear in API responses, app assets, logs or database metadata.
- Terminal offline, suspended, unpaired and unsupported-model cases fail closed.
- Android phone Tap-to-Phone is hidden unless a provider explicitly confirms device and merchant eligibility.
- No POS flow posts a ledger transaction in this foundation.

## Production gate (not authorized)

Live processing remains disabled until provider contract/onboarding, terminal certification, Nigerian legal/compliance review, security review, webhook and reconciliation tests, incident/refund/reversal operations, production secret provisioning and explicit owner approval are complete. The existence of an adapter or a green build is not approval to process real money.

## Bulk payments and bulk beneficiary verification

The merchant workspace includes two separate preparation pages:
- **Bulk Payments** accepts the documented CSV template (`beneficiary_name,account_number,bank_code,amount,currency,reference`), performs local format checks, and presents a review table. Its submit action is deliberately disabled; it does not call a bank, create payment intents, debit funds or post ledger entries.
- **Bulk Verification** accepts `beneficiary_name,account_number,bank_code` and performs local format checks only. An account number passing these checks is not bank-verified. Actual account-name enquiry and account status checks require an approved provider verification endpoint and authenticated server-side response.

The current UI reads the uploaded CSV in the browser and does not persist the file or beneficiary rows. It does not accept XLSX directly; spreadsheet users can export to CSV using the supplied template. Do not put customer data or account details in browser logs, analytics, or support screenshots.

Before enabling server-side batch persistence, establish merchant roles/permissions and a data-protection design. Full account numbers and beneficiary identity data must be encrypted with managed keys (or tokenized by the provider), never stored as plaintext in generic metadata. Batch creation must have a maker/checker approval workflow, per-row idempotency, batch-level totals and limits, immutable audit history, provider status reconciliation, duplicate-beneficiary detection, and a controlled cancellation/reversal process. Verification results must record provider, timestamp, request reference and normalized outcome without retaining unnecessary sensitive payloads.

Suggested future endpoints (not implemented by the current UI):
- `POST /v1/merchant/bulk-verifications` — submit a verification batch to an approved verification provider.
- `GET /v1/merchant/bulk-verifications/:id` — read per-beneficiary verification outcomes.
- `POST /v1/merchant/bulk-payment-batches` — create a draft batch only.
- `POST /v1/merchant/bulk-payment-batches/:id/approve` — maker/checker approval; still blocked unless a provider is explicitly production-approved.
- `POST /v1/merchant/bulk-payment-batches/:id/execute` — unavailable while live payments are disabled.
