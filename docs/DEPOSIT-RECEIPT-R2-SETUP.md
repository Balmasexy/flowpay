# FlowPay private deposit receipt storage

This feature stores customer receipt files in a **private Cloudflare R2 bucket**. Receipt metadata and review audit events stay in FlowPay Postgres. The web app receives only short-lived presigned object URLs; R2 access keys remain on the API service.

## 1. Create the R2 bucket

In the Cloudflare dashboard, open **R2 Object Storage** and create this bucket:

- Bucket: `flowpay-private-receipts`
- Public access: **disabled**
- Do not enable an `r2.dev` public URL or attach a public custom domain.

Create an R2 S3 API token with Object Read and Object Write permissions scoped to this bucket only. Store its Access Key ID and Secret Access Key directly in Render. Never commit them to Git or send them in chat.

## 2. Configure Render API environment

Set these variables on the FlowPay **backend** Render service:

| Variable | Value |
| --- | --- |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | Bucket-scoped R2 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | Bucket-scoped R2 Secret Access Key |
| `R2_BUCKET_NAME` | `flowpay-private-receipts` |
| `R2_REGION` | `auto` |
| `R2_ENDPOINT` | Optional; otherwise derived from `R2_ACCOUNT_ID` |

The service constructs `https://<account-id>.r2.cloudflarestorage.com` when `R2_ENDPOINT` is omitted. Use the account's S3-compatible endpoint only. Keep the bucket private.

## 3. Configure bucket CORS

Configure the bucket CORS policy to allow only the FlowPay web origin and the methods/headers needed for direct uploads. Example:

```json
[
  {
    "AllowedOrigins": [
      "https://flowpay-web-jx7i.onrender.com"
    ],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Add a development origin only when needed and remove it before production. Do not use `*` for allowed origins. R2 presigned links expire quickly (upload: 5 minutes; view: 2–3 minutes).

## 4. Apply the database migration

After review and when the correct target database is confirmed, apply:

`apps/api/migrations/018_deposit_receipt_submissions.sql`

The migration is additive. It creates receipt metadata and audit tables, adds a dedicated NGN manual-receipt clearing account, and permits the `super_admin` role already enforced by the server. It does not promote any existing user, rewrite customer account numbers, modify customer balances, or post ledger entries.

Do not apply this migration to production until the intended database and current migration state have been verified. Keep the migration file and `schema_migrations` record in sync.

A designated, already verified administrator must be granted `role='super_admin'` through the organisation's approved database-access process. The migration deliberately does not select or promote an administrator automatically.

## 5. Customer and reviewer flow

1. Customer enters the NGN amount, optional bank reference/note, and uploads a JPG, PNG, WEBP, or PDF receipt (up to 5 MB).
2. The API creates a user-owned pending receipt record and returns a short-lived PUT URL for a server-generated object key.
3. The API confirms the uploaded object's size and MIME metadata, downloads it privately, checks the file signature, stores a SHA-256 digest and moves it to `pending_review`.
4. An authenticated `super_admin` reviews it under `/admin`, compares the exact amount/reference against the receiving bank/provider statement, and enters the bank transaction reference.
5. Approval is allowed only when the reviewer explicitly attests that the funds were independently received. The server posts one balanced, idempotent ledger transaction against the manual-receipt clearing account. A rejection creates no wallet credit.

A screenshot, receipt upload, or customer-supplied reference is **not** proof of settlement. Never approve based only on the file. Reviewers should use dual control for material amounts according to FlowPay's operations policy.

## 6. API routes

- `GET /customer/deposit-receipts` — own receipt submission history.
- `POST /customer/deposit-receipts` — create a pending upload and get a presigned PUT URL.
- `POST /customer/deposit-receipts/:id/complete` — verify the private object and enqueue review.
- `GET /customer/deposit-receipts/:id/file` — short-lived view URL for own receipt.
- `GET /admin/session` — verifies the authenticated `super_admin` role.
- `GET /admin/deposit-receipts` — pending review queue.
- `GET /admin/deposit-receipts/:id/file` — short-lived reviewer URL.
- `POST /admin/deposit-receipts/:id/review` — approve or reject with an audit trail.

The receipt handler fails closed when R2 or authentication configuration is missing. The feature does not alter existing Paystack hosted checkout or provider webhooks.

## 7. Verification checklist

- Run `npm ci --prefix apps/api`.
- Run `npm run typecheck --prefix apps/api`.
- Run `npm run test:deposit-receipts --prefix apps/api`.
- Run the existing API tests and the web build.
- After the R2 bucket, CORS and migration are configured, perform a small sandbox upload and verify: pending review does not change the wallet; rejection does not post a ledger entry; approval after independent settlement verification creates exactly two equal-and-opposite ledger entries; a repeated review cannot credit twice.
- Verify the object is not accessible without an unexpired signed URL.

## Current setup limitation

The connected Neon Development project is hosted in `aws-eu-west-2`, a region where Neon Object Storage is not available. This implementation therefore targets Cloudflare R2, but Cloudflare account provisioning is not connected to this workspace. No R2 bucket or key was created, no database migration was applied, and no Render secrets were configured by this change.
