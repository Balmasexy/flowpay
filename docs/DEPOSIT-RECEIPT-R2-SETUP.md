# FlowPay private deposit receipt uploads

## What this adds

- Customers can submit a manual NGN bank-transfer receipt from **Deposit / Add Money**.
- Customers upload to an authenticated FlowPay API `PUT` route. The API enforces the 5 MiB limit, content type and file signature, then forwards the validated bytes to a private Cloudflare R2 bucket using a short-lived presigned PUT request. R2 credentials and signed upload URLs are never sent to the browser.
- Accepted files: JPEG, PNG, WEBP and PDF, maximum 5 MiB.
- The API verifies the stored object's length, MIME type and file signature before moving it to the review queue.
- Customer receipt history is private to the authenticated customer.
- The Super Admin queue requires an authenticated, email-verified active user with `fp_users.role = 'super_admin'`.
- Approving a receipt requires a reviewer note, a bank-statement transaction reference and an explicit attestation that the exact funds have reached FlowPay's receiving account. Approval posts one balanced NGN ledger transaction to a dedicated manual-receipt clearing account. Duplicate review requests cannot post a second credit.
- Rejection records the reviewer note and does not create a wallet credit.
- A screenshot or uploaded file alone never credits a wallet.

## Storage configuration

Create a Cloudflare R2 bucket named `flowpay-private-receipts` (or use another bucket name and set the matching variable). Keep the bucket **private**. Do not enable public bucket access, a public custom domain, or public object listing.

Create an R2 API token/access key scoped only to this bucket with Object Read and Object Write permissions. Do not paste the secret into GitHub, this chat, or a source file.

Set these variables on the **FlowPay API service in Render** after the bucket exists:

| Variable | Value |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare account ID (or set `R2_ENDPOINT` to the full endpoint below) |
| `R2_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `R2_BUCKET_NAME` | `flowpay-private-receipts` |
| `R2_ACCESS_KEY_ID` | The bucket-scoped R2 access key ID |
| `R2_SECRET_ACCESS_KEY` | The bucket-scoped R2 secret access key |
| `R2_REGION` | `auto` |

The server accepts either `R2_ENDPOINT` or `R2_ACCOUNT_ID`; the other four values are required. Restart/redeploy the API after saving the variables. Keep the credentials only in Render's encrypted environment-variable settings.

## Upload transport and CORS

The browser sends the receipt file to the authenticated FlowPay API, not directly to R2. The backend enforces the exact declared file size (maximum 5 MiB), checks the MIME type and file signature, then signs and performs the R2 `PUT` server-to-server. Consequently, **no browser-to-R2 CORS policy is required**. The FlowPay API's own CORS allowlist must include the deployed web origin and allow `PUT`, `Authorization` and `Content-Type` headers. Keep the R2 bucket private and do not enable public access or a public custom domain.

## Database migration

Apply `apps/api/migrations/018_deposit_receipt_submissions.sql` through the normal reviewed Neon migration process. It is additive: it creates receipt metadata/audit tables and one zero-opening-balance system clearing account, and expands the allowed role values to include `super_admin` without promoting any existing account. It does not update customer balances or ledger history.

Do not apply this migration to production before the branch review, successful CI, backup/restore readiness and explicit deployment decision. Apply first to the FlowPay Development database and verify the resulting tables/indexes and unchanged customer/ledger counts.

## API routes

Customer:
- `GET /customer/deposit-receipts`
- `POST /customer/deposit-receipts` — create a pending upload and return a customer-owned API upload path
- `PUT /customer/deposit-receipts/:id/file` — upload bytes to FlowPay; the API validates and forwards them to R2, then submits the receipt for review
- `GET /customer/deposit-receipts/:id/file` — return a short-lived private file URL for the owning customer

Super Admin:
- `GET /admin/deposit-receipts` — list the review queue and short-lived file links
- `GET /admin/deposit-receipts/:id/file` — refresh a pending receipt's private file link
- `POST /admin/deposit-receipts/:id/review` — approve or reject with audit record

All routes require the existing Neon Auth JWT configuration. Admin routes additionally require `super_admin`. The review API deliberately does not call a bank payout or payment provider. The reviewer must verify funds using FlowPay's receiving bank statement/provider records before approval.

## Checks before enabling

1. Confirm `/health` and `/ready` on the target API.
2. Apply migration 018 to Development and confirm there are no customer, wallet or ledger row-count changes.
3. Configure the private R2 bucket, scoped key and Render environment variables; verify the FlowPay API CORS allowlist includes the web app origin and `PUT`.
4. Run API typecheck and `npm run test:deposit-receipts --prefix apps/api`, then the full CI workflow.
5. Test customer upload, wrong-file rejection, missing-object rejection, ownership checks, customer history, Super Admin review, replayed approval, bank-reference uniqueness and balanced ledger entries.
6. Verify uploaded objects are not publicly reachable and signed links expire.
7. Only then decide whether to merge and deploy. No migration is applied and no live wallet credit or payout is enabled by this feature branch.

## Operational note

The feature fails closed when R2 configuration is absent. The current FlowPay Development Neon project is in `aws-eu-west-2`, a region that does not support Neon branchable object storage; this implementation therefore targets Cloudflare R2 and does not change the existing Neon project's region or create another paid database project.
