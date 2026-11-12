# FlowPay VTpass airtime and electricity prerequisites

FlowPay currently has service-page previews only. There is no VTpass server integration or provider-backed bill ledger in the repository yet. Do not display airtime or NEPA bills as paid until the provider confirms fulfilment.

## Create provider accounts

1. Create a VTpass Sandbox account: https://sandbox.vtpass.com/register
2. Open the sandbox profile's API Keys tab.
3. Generate and securely store the sandbox static API key, public key, and secret key.
4. Request/confirm access to the needed services (airtime, data, and electricity).
5. After sandbox tests pass, request a separate VTpass Live account and live credentials.

VTpass credentials are different for sandbox and live. Never paste credentials into chat, frontend source, GitHub, or a public issue.

## Environment variables for the backend

Sandbox API service:
- `VTPASS_ENVIRONMENT=sandbox`
- `VTPASS_API_KEY`
- `VTPASS_PUBLIC_KEY`
- `VTPASS_SECRET_KEY`

Live API service, only after VTpass live approval:
- `VTPASS_ENVIRONMENT=live`
- `VTPASS_API_KEY`
- `VTPASS_PUBLIC_KEY`
- `VTPASS_SECRET_KEY`

GET requests use the API key and public key headers. POST requests use the API key and secret key headers. Keep these credentials only on the backend.

## Provider flow that must be implemented and tested

### Airtime
1. Load the current VTpass airtime service catalogue.
2. Validate carrier, Nigerian phone number and amount.
3. Create a unique VTpass request ID using Africa/Lagos time.
4. Create a pending FlowPay ledger transaction and reserve the customer debit atomically.
5. Call VTpass purchase endpoint.
6. Requery any pending/uncertain response.
7. Mark delivered only when VTpass confirms delivery; release or reverse the reservation on final failure.
8. Enforce idempotency so retries cannot buy airtime twice.

### NEPA / electricity
1. Select the correct distribution company and meter type (prepaid/postpaid).
2. Verify the meter through `/api/merchant-verify`.
3. Show the provider-confirmed customer name and meter details for customer confirmation.
4. Create a pending ledger reservation and submit the payment to `/api/pay`.
5. Requery pending or uncertain transactions using `/api/requery`.
6. For prepaid meters, show the actual provider-issued token only after successful delivery. For postpaid, show the confirmed payment receipt.
7. Never credit or mark a bill paid from a client-side success screen alone.

### VTpass request ID format

VTpass requires a unique request ID with at least 12 characters. The first 12 characters must be the current Africa/Lagos date/time in `YYYYMMDDHHII` format; append a random alphanumeric suffix to avoid collisions.

## Sandbox examples

For Ikeja Electric (IKEDC) and Eko Electric (EKEDC), the published sandbox meter examples include:
- Prepaid success: `1111111111111`
- Postpaid success: `1010101010101`
- Pending: `201000000000`
- Unexpected response: `500000000000`
- No response: `400000000000`
- Timeout: `300000000000`

These are provider test fixtures only; do not use them as real customer meter numbers.

## Release gates

Before live airtime or electricity is enabled, FlowPay needs:
- VTpass sandbox credentials and a successful sandbox purchase/requery test suite.
- A provider transaction table with unique request IDs and provider transaction IDs.
- A balanced, idempotent customer ledger reservation/settlement/reversal flow.
- Callback/requery reconciliation for uncertain outcomes.
- Admin reporting and customer receipts.
- Separate live credentials and explicit live feature flags.
- A successful low-value provider-approved live test before enabling customers.
