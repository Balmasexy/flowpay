# BALMZ AI in FlowPay

## Access pattern

The customer-facing BALMZ AI assistant is mounted in the authenticated FlowPay customer app as a floating chat widget. It sends the customer's question to:

`POST /customer-ai/chat`

The API verifies the Neon Auth JWT, then requires an active customer whose email is verified. It sends only the customer's display name and the current question to the OpenAI Responses API. It does not read wallet balances, ledger entries, bank details, card records or transaction history.

## Server configuration

Set these variables on the FlowPay backend service in Render:

- `FLOWPAY_BALMZ_AI_API_KEY`: a dedicated OpenAI API key for FlowPay, stored only in Render.
- `FLOWPAY_BALMZ_AI_MODEL`: optional model override. Defaults to `gpt-6-luna`.

Never copy a key from PWFB Microfinance or place an API key in the web app, APK, source control or chat.

## Guardrails

- Customer JWT, active status, customer role and verified email are checked before model access.
- Request messages are limited to 2,000 characters and 12 requests per customer per minute.
- Provider requests use a 20-second timeout, a 500-token output limit and `store: false`.
- BALMZ AI is guidance only. It cannot initiate, approve, reverse or settle payments, change balances, or modify customer records.
- It must not claim to have checked a personal balance or transaction status. Customers are directed to the authenticated FlowPay screens for account-specific information.
- The chat does not persist message history in the FlowPay database.
- The assistant warns customers never to share PINs, passwords or OTPs.

## Verification

Run the API test with:

```sh
npm run test:customer-ai --prefix apps/api
```
