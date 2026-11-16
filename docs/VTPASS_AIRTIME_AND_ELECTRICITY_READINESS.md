# FlowPay VTpass airtime, data, and electricity readiness

FlowPay includes a backend VTpass adapter for the services listed here. The customer UI calls the authenticated API; provider secrets remain on the backend. A service is not available merely because the page renders: the adapter returns a not-configured response until the matching environment and provider credentials are present.

## Implemented service categories

- Airtime: MTN, Airtel, Glo, and 9mobile.
- Data: MTN, Airtel, Glo, and 9mobile; plan/variation and price are obtained from VTpass.
- Electricity: supported distribution companies in the server catalogue (including IKEDC, EKEDC, AEDC, IBEDC, KEDCO, PHED, Jos, and Kaduna), with prepaid/postpaid meter verification.

Cable TV / DStv / GOtv / StarTimes are not part of the current VTpass catalog implementation and must not be represented as provider-connected.

## Backend routes

- GET /customer/bills/catalog — retrieves the configured service catalogue and available data variations.
- POST /customer/bills/validate — verifies electricity meter details before purchase.
- POST /customer/bills/purchase — validates customer/account ownership, transaction PIN, amount/variation, idempotency, wallet funds, and provider service; reserves funds and submits the provider request.
- GET /customer/bills/status?requestId=... — checks the customer's own request status and re-queries provider state where supported.

The adapter stores request/provider references and status. Confirmed success is posted through the VTpass clearing account and balanced ledger transaction. Confirmed failure or reversal follows the reversal path. Uncertain provider outcomes remain pending/unknown and must be re-queried; they are not displayed as completed and must not be blindly retried.

## API environment configuration

Sandbox API service (non-production runtime only):
- VTPASS_ENVIRONMENT=sandbox
- VTPASS_API_KEY
- VTPASS_PUBLIC_KEY
- VTPASS_SECRET_KEY

Live API service, only after separate VTpass approval:
- VTPASS_ENVIRONMENT=live
- VTPASS_API_KEY
- VTPASS_PUBLIC_KEY
- VTPASS_SECRET_KEY
- VTPASS_LIVE_ENABLED=true
- NODE_ENV=production

GET requests use the API key and public key headers. POST requests use the API key and secret key headers. Store values only in Render's backend environment; never in GitHub, chat, frontend variables, browser storage, or the Android wrapper.

## Operational requirements

- Validate Nigerian phone numbers and provider service IDs.
- Electricity meter validation must return provider-confirmed customer details before a debit is submitted.
- Data bundle code and amount must match a current provider catalogue response.
- Generate a unique VTpass request ID using Africa/Lagos time in YYYYMMDDHHII format plus a random suffix.
- Require the separate FlowPay transaction PIN and idempotency key for purchases.
- Reserve the customer's funds before provider submission; settle, release, or reverse only after verified provider status.
- Re-query uncertain responses and preserve the reservation until the provider returns a final status.
- Reconcile the VTpass clearing account and customer ledger before live rollout.

## Automated verification

The API CI workflow runs test:vtpass-bills and includes the API type-check, readiness smoke test, and dependency audit. This validates the guarded adapter and its fixture-based transaction state handling. It does not substitute for credentials, a live VTpass account, product activation, or a real sandbox purchase.

## Sandbox examples

For supported electricity test services, VTpass publishes sample meter numbers for success, pending, unexpected, no-response, and timeout cases. These are provider fixtures only; never present them as real customer meters or use them for live payments.

## Release gate

Do not activate VTpass live purchases until the business has VTpass approval, credentials have been placed on the production API, the /ready response confirms the provider path is configured, sandbox purchase/status/reversal has been completed, and operations can reconcile provider records with the FlowPay ledger.
