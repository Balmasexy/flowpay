import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { createRemoteJWKSet, jwtVerify } from "jose";

type Options = {
  pool: Pool | null;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
  issuer?: string;
  audience?: string;
};
type Identity = { id: string; name: string | null; email: string | null };
type SessionResult =
  | { ok: true; identity: Identity }
  | { ok: false; status: number; error: string };

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const REFERENCE_PATTERN = /^flowpay-ps-[0-9a-f]{32}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function isJwtError(error: unknown) {
  return error instanceof Error && [
    "JWTExpired", "JWSSignatureVerificationFailed", "JWTClaimValidationFailed", "JWSInvalid", "JWTInvalid"
  ].includes(error.name);
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(buffer);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new Error("INVALID_JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PAYLOAD");
  return value as Record<string, unknown>;
}
function safeFileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().replace(/[\\/]/g, "_").replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 120);
  return clean && clean !== "." && clean !== ".." ? clean : null;
}
function imageMatchesMime(bytes: Buffer, mime: string): boolean {
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if (mime === "image/webp") return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return false;
}

export function createDepositReceiptHandler(options: Options) {
  const { pool, jwks, issuer, audience } = options;

  async function authenticate(req: IncomingMessage, admin: boolean): Promise<SessionResult> {
    if (!pool || !jwks || !issuer || !audience) {
      return { ok: false, status: 503, error: admin ? "ADMIN_RECEIPT_SERVICE_NOT_CONFIGURED" : "DEPOSIT_RECEIPT_SERVICE_NOT_CONFIGURED" };
    }
    const authorization = req.headers.authorization ?? "";
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!bearer) return { ok: false, status: 401, error: "AUTHENTICATION_REQUIRED" };
    try {
      const { payload } = await jwtVerify(bearer[1], jwks, { algorithms: ["EdDSA"], issuer, audience });
      if (typeof payload.sub !== "string" || !payload.sub) {
        return { ok: false, status: 401, error: "INVALID_SESSION" };
      }
      const result = admin
        ? await pool.query<Identity>(
            `SELECT app_user.id, auth_user.name, auth_user.email
               FROM neon_auth."user" AS auth_user
               JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
              WHERE auth_user.id::text = $1 AND auth_user."emailVerified" = true
                AND app_user.status = 'active' AND app_user.role = 'super_admin'
              LIMIT 1`,
            [payload.sub]
          )
        : await pool.query<Identity>(
            `SELECT app_user.id, auth_user.name, auth_user.email
               FROM neon_auth."user" AS auth_user
               JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
              WHERE auth_user.id::text = $1 AND auth_user."emailVerified" = true
                AND app_user.status = 'active' AND app_user.role = 'customer'
              LIMIT 1`,
            [payload.sub]
          );
      if (result.rowCount !== 1 || !result.rows[0]) {
        return { ok: false, status: 403, error: admin ? "SUPER_ADMIN_ACCESS_REQUIRED" : "ACTIVE_VERIFIED_CUSTOMER_REQUIRED" };
      }
      return { ok: true, identity: result.rows[0] };
    } catch (error) {
      if (isJwtError(error)) return { ok: false, status: 401, error: "INVALID_SESSION" };
      console.error("FlowPay deposit receipt authentication failed:", error instanceof Error ? error.message : "unknown error");
      return { ok: false, status: 503, error: "DEPOSIT_RECEIPT_AUTH_UNAVAILABLE" };
    }
  }

  return async function handleDepositReceipt(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const segments = pathname.split("/").filter(Boolean);
    const customerReceiptPath = "/customer/paystack/deposits/receipt";
    const adminCollectionPath = "/admin/deposit-receipts";
    const adminFileId = segments.length === 4 && segments[0] === "admin" && segments[1] === "deposit-receipts" && segments[3] === "file" ? segments[2] : null;
    const adminReviewId = segments.length === 4 && segments[0] === "admin" && segments[1] === "deposit-receipts" && segments[3] === "review" ? segments[2] : null;
    const isCustomerRoute = pathname === customerReceiptPath && (req.method === "POST" || req.method === "GET");
    const isAdminRoute = pathname === adminCollectionPath && req.method === "GET";
    const isAdminFileRoute = Boolean(adminFileId) && req.method === "GET";
    const isAdminReviewRoute = Boolean(adminReviewId) && req.method === "PATCH";
    const adminFileMatch = /^\\/admin\\/deposit-receipts\\/([0-9a-f-]{36})\\/file$/i.exec(pathname);
    const adminReviewMatch = /^\\/admin\\/deposit-receipts\\/([0-9a-f-]{36})\\/review$/i.exec(pathname);
    const isCustomerRoute = pathname === customerReceiptPath && (req.method === "POST" || req.method === "GET");
    const isAdminRoute = pathname === adminCollectionPath && req.method === "GET";
    if (!isCustomerRoute && !isAdminRoute && !isAdminFileRoute && !isAdminReviewRoute) {
      return false;
    }
    if (!pool) {
      json(res, 503, { error: "DATABASE_UNAVAILABLE" });
      return true;
    }

    const admin = isAdminRoute || isAdminFileRoute || isAdminReviewRoute;
    const session = await authenticate(req, admin);
    if (!session.ok) {
      json(res, session.status, { error: session.error });
      return true;
    }

    if (isCustomerRoute && req.method === "GET") {
      const reference = url.searchParams.get("reference")?.trim() ?? "";
      if (!REFERENCE_PATTERN.test(reference)) {
        json(res, 400, { error: "INVALID_PAYSTACK_REFERENCE" });
        return true;
      }
      try {
        const result = await pool.query<{
          id: string; reference: string; review_status: string; file_name: string;
          mime_type: string; file_size: number; created_at: Date; reviewed_at: Date | null;
          review_note: string | null;
        }>(
          `SELECT r.id, d.reference, r.review_status, r.file_name, r.mime_type,
                  r.file_size, r.created_at, r.reviewed_at, r.review_note
             FROM public.fp_deposit_receipts AS r
             JOIN public.fp_paystack_deposits AS d ON d.transaction_id = r.transaction_id
            WHERE r.user_id = $1 AND d.reference = $2
            ORDER BY r.created_at DESC LIMIT 5`,
          [session.identity.id, reference]
        );
        json(res, 200, {
          receipts: result.rows.map(row => ({
            id: row.id, reference: row.reference, reviewStatus: row.review_status,
            fileName: row.file_name, mimeType: row.mime_type, fileSize: row.file_size,
            createdAt: row.created_at, reviewedAt: row.reviewed_at, reviewNote: row.review_note
          })),
          walletCreditedByReceipt: false
        });
      } catch (error) {
        console.error("FlowPay customer receipt status failed:", error instanceof Error ? error.message : "database error");
        json(res, 503, { error: "DEPOSIT_RECEIPT_STATUS_UNAVAILABLE" });
      }
      return true;
    }

    if (isCustomerRoute && req.method === "POST") {
      let input: Record<string, unknown>;
      try { input = await readJson(req); }
      catch (error) {
        const reason = error instanceof Error ? error.message : "INVALID_PAYLOAD";
        json(res, reason === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: reason });
        return true;
      }
      if (Object.keys(input).some(key => !["reference", "fileName", "imageDataUrl"].includes(key))) {
        json(res, 400, { error: "UNSUPPORTED_RECEIPT_FIELD" });
        return true;
      }
      const reference = typeof input.reference === "string" ? input.reference.trim() : "";
      const fileName = safeFileName(input.fileName);
      if (!REFERENCE_PATTERN.test(reference)) {
        json(res, 400, { error: "INVALID_PAYSTACK_REFERENCE" });
        return true;
      }
      if (!fileName || typeof input.imageDataUrl !== "string") {
        json(res, 400, { error: "RECEIPT_IMAGE_REQUIRED" });
        return true;
      }
      const imagePrefix = "data:image/";
      const marker = ";base64,";
      const splitAt = input.imageDataUrl.indexOf(marker);
      const header = splitAt > 0 ? input.imageDataUrl.slice(0, splitAt) : "";
      const mimeType = header === "data:image/jpeg" ? "image/jpeg" : header === "data:image/png" ? "image/png" : header === "data:image/webp" ? "image/webp" : "";
      const encoded = splitAt > 0 ? input.imageDataUrl.slice(splitAt + marker.length) : "";
      const fileData = encoded && /^[A-Za-z0-9+/]+=*$/.test(encoded) ? Buffer.from(encoded, "base64") : Buffer.alloc(0);
      const canonical = fileData.toString("base64").replace(/=+$/, "");
      if (!mimeType || !encoded || !canonical || canonical !== encoded.replace(/=+$/, "")) { json(res, 400, { error: "INVALID_RECEIPT_IMAGE" }); return true; }
      if (!fileData.length || fileData.length > MAX_FILE_BYTES) {
        json(res, 413, { error: "RECEIPT_IMAGE_TOO_LARGE", maximumBytes: MAX_FILE_BYTES });
        return true;
      }
      if (!imageMatchesMime(fileData, mimeType)) {
        json(res, 400, { error: "RECEIPT_IMAGE_CONTENT_MISMATCH" });
        return true;
      }
      const fileSha256 = createHash("sha256").update(fileData).digest("hex");
      const client = await pool.connect().catch(() => null);
      if (!client) {
        json(res, 503, { error: "DEPOSIT_RECEIPT_DATABASE_UNAVAILABLE" });
        return true;
      }
      try {
        await client.query("BEGIN");
        const deposit = await client.query<{ transaction_id: string; status: string }>(
          `SELECT transaction_id, status FROM public.fp_paystack_deposits
            WHERE user_id = $1 AND reference = $2 FOR SHARE`,
          [session.identity.id, reference]
        );
        if (deposit.rowCount !== 1 || !deposit.rows[0]) {
          await client.query("ROLLBACK");
          json(res, 404, { error: "OWN_PAYSTACK_DEPOSIT_NOT_FOUND" });
          return true;
        }
        const count = await client.query<{ receipt_count: number }>(
          `SELECT COUNT(*)::int AS receipt_count FROM public.fp_deposit_receipts
            WHERE transaction_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
          [deposit.rows[0].transaction_id]
        );
        if (Number(count.rows[0]?.receipt_count ?? 0) >= 3) {
          await client.query("ROLLBACK");
          json(res, 429, { error: "RECEIPT_UPLOAD_LIMIT_REACHED", maximumPerDepositPerDay: 3 });
          return true;
        }
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO public.fp_deposit_receipts
             (transaction_id, user_id, file_name, mime_type, file_data, file_size, file_sha256)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (transaction_id, file_sha256) DO NOTHING
           RETURNING id`,
          [deposit.rows[0].transaction_id, session.identity.id, fileName, mimeType, fileData, fileData.length, fileSha256]
        );
        if (inserted.rowCount !== 1 || !inserted.rows[0]) {
          const duplicate = await client.query<{ id: string; review_status: string }>(
            `SELECT id, review_status FROM public.fp_deposit_receipts
              WHERE transaction_id = $1 AND file_sha256 = $2 LIMIT 1`,
            [deposit.rows[0].transaction_id, fileSha256]
          );
          await client.query("COMMIT");
          json(res, 200, {
            receiptId: duplicate.rows[0]?.id ?? null,
            reviewStatus: duplicate.rows[0]?.review_status ?? "pending_review",
            duplicate: true,
            walletCredited: false
          });
          return true;
        }
        await client.query("COMMIT");
        json(res, 201, {
          receiptId: inserted.rows[0].id,
          reference,
          reviewStatus: "pending_review",
          message: "Receipt uploaded for administrator review. This does not confirm payment or credit your wallet.",
          walletCredited: false
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        console.error("FlowPay receipt upload failed:", error instanceof Error ? error.message : "database error");
        json(res, 503, { error: "DEPOSIT_RECEIPT_UPLOAD_UNAVAILABLE" });
      } finally {
        client.release();
      }
      return true;
    }

    if (isAdminRoute && req.method === "GET") {
      try {
        const status = url.searchParams.get("status")?.trim() || "pending_review";
        if (!["pending_review", "evidence_accepted", "rejected", "all"].includes(status)) {
          json(res, 400, { error: "INVALID_REVIEW_STATUS_FILTER" });
          return true;
        }
        const result = await pool.query<{
          id: string; transaction_id: string; user_id: string; reference: string;
          amount_minor: string; currency: string; deposit_status: string;
          file_name: string; mime_type: string; file_size: number; review_status: string;
          review_note: string | null; created_at: Date; reviewed_at: Date | null;
          customer_name: string | null; customer_email: string | null;
        }>(
          `SELECT r.id, r.transaction_id, r.user_id, d.reference, d.amount_minor::text AS amount_minor,
                  d.currency, d.status AS deposit_status, r.file_name, r.mime_type,
                  r.file_size, r.review_status, r.review_note, r.created_at, r.reviewed_at,
                  auth_user.name AS customer_name, auth_user.email AS customer_email
             FROM public.fp_deposit_receipts AS r
             JOIN public.fp_paystack_deposits AS d ON d.transaction_id = r.transaction_id
             JOIN public.fp_users AS app_user ON app_user.id = r.user_id
             LEFT JOIN neon_auth."user" AS auth_user ON auth_user.id::text = app_user.auth_subject
            WHERE ($1 = 'all' OR r.review_status = $1)
            ORDER BY CASE WHEN r.review_status = 'pending_review' THEN 0 ELSE 1 END,
                     r.created_at ASC
            LIMIT 100`,
          [status]
        );
        json(res, 200, {
          receipts: result.rows.map(row => ({
            id: row.id, transactionId: row.transaction_id, customerId: row.user_id,
            customerName: row.customer_name ?? "FlowPay customer",
            customerEmail: row.customer_email ?? "",
            reference: row.reference, amountMinor: row.amount_minor,
            currency: String(row.currency).trim(), depositStatus: row.deposit_status,
            fileName: row.file_name, mimeType: row.mime_type, fileSize: row.file_size,
            reviewStatus: row.review_status, reviewNote: row.review_note,
            createdAt: row.created_at, reviewedAt: row.reviewed_at
          })),
          reviewCanCreditWallet: false
        });
      } catch (error) {
        console.error("FlowPay admin receipt queue failed:", error instanceof Error ? error.message : "database error");
        json(res, 503, { error: "ADMIN_RECEIPT_QUEUE_UNAVAILABLE" });
      }
      return true;
    }

    if (isAdminFileRoute && adminFileId) {
      if (!UUID_PATTERN.test(adminFileId)) {
        json(res, 400, { error: "INVALID_RECEIPT_ID" });
        return true;
      }
      try {
        const result = await pool.query<{ file_data: Buffer; mime_type: string; file_name: string }>(
          `SELECT file_data, mime_type, file_name
             FROM public.fp_deposit_receipts WHERE id = $1 LIMIT 1`,
          [adminFileId]
        );
        if (result.rowCount !== 1 || !result.rows[0]) {
          json(res, 404, { error: "DEPOSIT_RECEIPT_NOT_FOUND" });
          return true;
        }
        const { file_data, mime_type, file_name } = result.rows[0];
        const attachmentName = file_name.replaceAll('"', "_").replaceAll(String.fromCharCode(13), "_").replaceAll(String.fromCharCode(10), "_");
        res.writeHead(200, {
          "Content-Type": mime_type,
          "Content-Length": file_data.length,
          "Content-Disposition": `inline; filename="${attachmentName}"`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store"
        });
        res.end(file_data);
      } catch (error) {
        console.error("FlowPay administrator receipt file request failed:", error instanceof Error ? error.message : "database error");
        json(res, 503, { error: "ADMIN_RECEIPT_FILE_UNAVAILABLE" });
      }
      return true;
    }

    if (isAdminReviewRoute && adminReviewId) {
      if (!UUID_PATTERN.test(adminReviewId)) {
        json(res, 400, { error: "INVALID_RECEIPT_ID" });
        return true;
      }
      let input: Record<string, unknown>;
      try { input = await readJson(req); }
      catch (error) {
        const reason = error instanceof Error ? error.message : "INVALID_PAYLOAD";
        json(res, reason === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: reason });
        return true;
      }
      if (Object.keys(input).some(key => !["reviewStatus", "reviewNote"].includes(key))) {
        json(res, 400, { error: "UNSUPPORTED_REVIEW_FIELD" });
        return true;
      }
      const reviewStatus = input.reviewStatus;
      const reviewNote = typeof input.reviewNote === "string" ? input.reviewNote.trim() : "";
      if (reviewStatus !== "evidence_accepted" && reviewStatus !== "rejected") {
        json(res, 400, { error: "INVALID_RECEIPT_REVIEW_STATUS" });
        return true;
      }
      if (reviewNote.length > 500) {
        json(res, 400, { error: "REVIEW_NOTE_TOO_LONG" });
        return true;
      }
      if (reviewStatus === "rejected" && reviewNote.length < 3) {
        json(res, 400, { error: "REJECTION_REASON_REQUIRED" });
        return true;
      }
      let client: PoolClient;
      try { client = await pool.connect(); }
      catch {
        json(res, 503, { error: "ADMIN_RECEIPT_DATABASE_UNAVAILABLE" });
        return true;
      }
      try {
        await client.query("BEGIN");
        const changed = await client.query<{ id: string; user_id: string }>(
          `UPDATE public.fp_deposit_receipts
              SET review_status = $2, reviewer_user_id = $3,
                  review_note = NULLIF($4, ''), reviewed_at = NOW()
            WHERE id = $1 AND review_status = 'pending_review'
            RETURNING id, user_id`,
          [adminReviewId, reviewStatus, session.identity.id, reviewNote]
        );
        if (changed.rowCount !== 1 || !changed.rows[0]) {
          const existing = await client.query<{ review_status: string }>(
            "SELECT review_status FROM public.fp_deposit_receipts WHERE id = $1 LIMIT 1",
            [adminReviewId]
          );
          await client.query("ROLLBACK");
          json(res, existing.rowCount === 1 ? 409 : 404, {
            error: existing.rowCount === 1 ? "RECEIPT_ALREADY_REVIEWED" : "DEPOSIT_RECEIPT_NOT_FOUND",
            currentStatus: existing.rows[0]?.review_status ?? null
          });
          return true;
        }
        await client.query(
          `INSERT INTO public.fp_security_audit_events (user_id, event_type, outcome, details)
           VALUES ($1, 'deposit_receipt_review', $2, $3::jsonb)`,
          [session.identity.id, reviewStatus === "rejected" ? "rejected" : "succeeded",
            JSON.stringify({ receiptId: changed.rows[0].id, customerId: changed.rows[0].user_id, reviewStatus })]
        );
        await client.query("COMMIT");
        json(res, 200, {
          receiptId: changed.rows[0].id,
          reviewStatus,
          walletCredited: false,
          message: "Receipt evidence review saved. Wallet credits still require verified provider settlement and the existing ledger posting flow."
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        console.error("FlowPay administrator receipt review failed:", error instanceof Error ? error.message : "database error");
        json(res, 503, { error: "ADMIN_RECEIPT_REVIEW_UNAVAILABLE" });
      } finally {
        client.release();
      }
      return true;
    }

    return true;
  };
}
