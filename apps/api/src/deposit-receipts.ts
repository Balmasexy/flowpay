import { createHash, createHmac, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { jwtVerify, type JWTVerifyGetKey } from "jose";

type Dependencies = {
  pool: Pool | null;
  jwks: JWTVerifyGetKey | null;
  issuer?: string;
  audience?: string;
};
type ReceiptStatus = "pending_upload" | "pending_review" | "approved" | "rejected";
type Identity = { id: string; role: string };
type Receipt = {
  id: string;
  user_id: string;
  amount_minor: string;
  currency: string;
  reference_text: string | null;
  customer_note: string | null;
  object_key: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  status: ReceiptStatus;
  created_at: Date;
  reviewed_at: Date | null;
  review_note: string | null;
  review_bank_reference: string | null;
  ledger_transaction_id: string | null;
};

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const JWT_ERRORS = new Set(["JWTExpired", "JWSSignatureVerificationFailed", "JWTClaimValidationFailed", "JWSInvalid", "JWTInvalid"]);

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > 16_384) throw Object.assign(new Error("REQUEST_TOO_LARGE"), { statusCode: 413 });
    chunks.push(part);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("INVALID_JSON"), { statusCode: 400 }); }
  if (!isRecord(parsed)) throw Object.assign(new Error("INVALID_PAYLOAD"), { statusCode: 400 });
  return parsed;
}
function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function amountMinor(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value);
  if (!/^\d{1,15}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? raw : null;
}
function safeFilename(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/[\\/\u0000-\u001f\u007f]/g, "_").replace(/[^a-zA-Z0-9._ -]/g, "_").slice(-100);
  return name && name !== "." && name !== ".." ? name : null;
}
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, ch => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
}
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}
function signingKey(secret: string, date: string, region: string): Buffer {
  const dateKey = hmac("AWS4" + secret, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}
function amzDate(now = new Date()): { short: string; full: string } {
  const full = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { short: full.slice(0, 8), full };
}
function canonicalObjectPath(bucket: string, key: string): string {
  return "/" + encodeRfc3986(bucket) + "/" + key.split("/").map(encodeRfc3986).join("/");
}
function canonicalQuery(values: Array<[string, string]>): string {
  return values
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
    .map(([key, value]) => key + "=" + value)
    .join("&");
}
type StorageConfig = { endpoint: URL; bucket: string; accessKeyId: string; secretAccessKey: string; region: string };
function storageConfig(): StorageConfig | null {
  const endpointText = process.env.R2_ENDPOINT?.trim() ||
    (process.env.R2_ACCOUNT_ID?.trim() ? "https://" + process.env.R2_ACCOUNT_ID.trim() + ".r2.cloudflarestorage.com" : "");
  const bucket = process.env.R2_BUCKET_NAME?.trim() || "";
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim() || "";
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim() || "";
  const region = process.env.R2_REGION?.trim() || "auto";
  try {
    const endpoint = new URL(endpointText);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search ||
        endpoint.hash || (endpoint.pathname !== "" && endpoint.pathname !== "/") ||
        !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !accessKeyId || !secretAccessKey) return null;
    return { endpoint, bucket, accessKeyId, secretAccessKey, region };
  } catch { return null; }
}
function presignedUrl(config: StorageConfig, method: "PUT" | "GET", key: string, contentType?: string, expires = 300): string {
  const date = amzDate();
  const scope = date.short + "/" + config.region + "/s3/aws4_request";
  const uri = canonicalObjectPath(config.bucket, key);
  const signedHeaders = method === "PUT" ? "content-type;host" : "host";
  const query = canonicalQuery([
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD"],
    ["X-Amz-Credential", config.accessKeyId + "/" + scope],
    ["X-Amz-Date", date.full],
    ["X-Amz-Expires", String(expires)],
    ["X-Amz-SignedHeaders", signedHeaders]
  ]);
  const headers = method === "PUT"
    ? "content-type:" + (contentType ?? "") + "\nhost:" + config.endpoint.host + "\n"
    : "host:" + config.endpoint.host + "\n";
  const payload = "UNSIGNED-PAYLOAD";
  const request = method + "\n" + uri + "\n" + query + "\n" + headers + "\n" + signedHeaders + "\n" + payload;
  const toSign = "AWS4-HMAC-SHA256\n" + date.full + "\n" + scope + "\n" + sha256(request);
  const signature = createHmac("sha256", signingKey(config.secretAccessKey, date.short, config.region))
    .update(toSign, "utf8").digest("hex");
  return config.endpoint.origin + uri + "?" + query + "&X-Amz-Signature=" + signature;
}
async function signedHead(config: StorageConfig, key: string): Promise<Response> {
  const date = amzDate();
  const uri = canonicalObjectPath(config.bucket, key);
  const payload = "UNSIGNED-PAYLOAD";
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders =
    "host:" + config.endpoint.host + "\n" +
    "x-amz-content-sha256:" + payload + "\n" +
    "x-amz-date:" + date.full + "\n";
  const request = "HEAD\n" + uri + "\n\n" + canonicalHeaders + "\n" + signedHeaders + "\n" + payload;
  const scope = date.short + "/" + config.region + "/s3/aws4_request";
  const toSign = "AWS4-HMAC-SHA256\n" + date.full + "\n" + scope + "\n" + sha256(request);
  const signature = createHmac("sha256", signingKey(config.secretAccessKey, date.short, config.region))
    .update(toSign, "utf8").digest("hex");
  const authorization = "AWS4-HMAC-SHA256 Credential=" + config.accessKeyId + "/" + scope +
    ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;
  return fetch(config.endpoint.origin + uri, {
    method: "HEAD",
    headers: {
      Authorization: authorization,
      "x-amz-content-sha256": payload,
      "x-amz-date": date.full
    },
    signal: AbortSignal.timeout(12_000)
  });
}
function hasExpectedMagic(bytes: Buffer, mime: string): boolean {
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mime === "image/webp") return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (mime === "application/pdf") return bytes.length >= 5 && bytes.toString("ascii", 0, 5) === "%PDF-";
  return false;
}
async function authenticate(
  req: IncomingMessage,
  pool: Pool,
  jwks: JWTVerifyGetKey,
  issuer: string,
  audience: string,
  admin = false
): Promise<Identity | null> {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  const { payload } = await jwtVerify(token, jwks, { algorithms: ["EdDSA"], issuer, audience });
  if (typeof payload.sub !== "string" || !payload.sub) return null;
  const result = await pool.query<Identity>(
    `SELECT app_user.id, app_user.role
       FROM neon_auth."user" AS auth_user
       JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
      WHERE auth_user.id::text = $1 AND auth_user."emailVerified" = true
        AND app_user.status = 'active' ${admin ? "AND app_user.role = 'super_admin'" : "AND app_user.role = 'customer'"} LIMIT 1`,
    [payload.sub]
  );
  return result.rowCount === 1 ? result.rows[0] : null;
}
function audit(client: PoolClient, receiptId: string, actorId: string, actorRole: string, action: string, details: Record<string, unknown> = {}) {
  return client.query(
    `INSERT INTO public.fp_deposit_receipt_audit_events
       (receipt_id, actor_user_id, actor_role, action, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [receiptId, actorId, actorRole, action, JSON.stringify(details)]
  );
}

export function createDepositReceiptsHandler(deps: Dependencies) {
  return async function handleDepositReceipts(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
    const customerRoot = "/customer/deposit-receipts";
    const adminRoot = "/admin/deposit-receipts";
    const customerMatch = pathname.match(/^\/customer\/deposit-receipts\/([0-9a-f-]{36})\/file$/i);
    const adminMatch = pathname.match(/^\/admin\/deposit-receipts(?:\/([0-9a-f-]{36})\/(review|file))?$/i);
    if (!(pathname === customerRoot || pathname.startsWith(customerRoot + "/") || pathname === adminRoot || pathname.startsWith(adminRoot + "/"))) return false;
    const { pool, jwks, issuer, audience } = deps;
    if (!pool || !jwks || !issuer || !audience) {
      send(res, 503, { error: "DEPOSIT_RECEIPT_SERVICE_NOT_CONFIGURED" });
      return true;
    }
    const config = storageConfig();
    if (!config) {
      send(res, 503, { error: "RECEIPT_STORAGE_NOT_CONFIGURED", message: "Private receipt storage is not configured on the FlowPay API." });
      return true;
    }
    const isAdmin = pathname === adminRoot || pathname.startsWith(adminRoot + "/");
    let identity: Identity;
    try {
      const result = await authenticate(req, pool, jwks, issuer, audience, isAdmin);
      if (!result) {
        send(res, req.headers.authorization ? 403 : 401, { error: isAdmin ? "ACTIVE_SUPER_ADMIN_REQUIRED" : "ACTIVE_CUSTOMER_REQUIRED" });
        return true;
      }
      identity = result;
    } catch (error) {
      if (error instanceof Error && JWT_ERRORS.has(error.name)) { send(res, 401, { error: "INVALID_SESSION" }); return true; }
      console.error("FlowPay receipt authentication failed:", error instanceof Error ? error.message : "unknown error");
      send(res, 503, { error: "RECEIPT_AUTH_UNAVAILABLE" });
      return true;
    }

    try {
      if (req.method === "GET" && pathname === customerRoot) {
        const result = await pool.query<Receipt>(
          `SELECT id, user_id, amount_minor::text, currency, reference_text, customer_note,
                  object_key, file_name, content_type, size_bytes, status, created_at,
                  reviewed_at, review_note, review_bank_reference, ledger_transaction_id
             FROM public.fp_deposit_receipts
            WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
          [identity.id]
        );
        send(res, 200, { receipts: result.rows.map(row => ({
          id: row.id, amountMinor: row.amount_minor, currency: row.currency.trim(),
          reference: row.reference_text, note: row.customer_note, fileName: row.file_name,
          status: row.status, createdAt: row.created_at, reviewedAt: row.reviewed_at,
          reviewNote: row.status === "rejected" ? row.review_note : null,
          transactionId: row.status === "approved" ? row.ledger_transaction_id : null
        })) });
        return true;
      }

      if (req.method === "POST" && pathname === customerRoot) {
        let input: Record<string, unknown>;
        try { input = await readJson(req); }
        catch (error) {
          const status = error && typeof error === "object" && "statusCode" in error ? Number((error as {statusCode:unknown}).statusCode) : 400;
          send(res, status, { error: error instanceof Error ? error.message : "INVALID_PAYLOAD" }); return true;
        }
        if (Object.keys(input).some(key => !["clientRequestId","amountMinor","reference","note","fileName","contentType","sizeBytes"].includes(key))) {
          send(res, 400, { error: "UNSUPPORTED_RECEIPT_FIELD" }); return true;
        }
        if (!isUuid(input.clientRequestId)) { send(res, 400, { error: "VALID_CLIENT_REQUEST_ID_REQUIRED" }); return true; }
        const amount = amountMinor(input.amountMinor);
        const fileName = safeFilename(input.fileName);
        const contentType = typeof input.contentType === "string" ? input.contentType.trim().toLowerCase() : "";
        const sizeBytes = typeof input.sizeBytes === "number" ? input.sizeBytes : Number.NaN;
        const reference = input.reference === undefined || input.reference === null ? null :
          typeof input.reference === "string" ? input.reference.trim() : undefined;
        const note = input.note === undefined || input.note === null ? null :
          typeof input.note === "string" ? input.note.trim() : undefined;
        if (!amount) { send(res, 400, { error: "INVALID_AMOUNT_MINOR" }); return true; }
        if (!fileName || !ALLOWED_TYPES.has(contentType) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_FILE_BYTES) {
          send(res, 400, { error: "INVALID_RECEIPT_FILE", maxBytes: MAX_FILE_BYTES, allowedTypes: Array.from(ALLOWED_TYPES) }); return true;
        }
        if (reference === undefined || (reference !== null && reference.length > 100) ||
            note === undefined || (note !== null && note.length > 500)) {
          send(res, 400, { error: "INVALID_RECEIPT_DETAILS" }); return true;
        }
        const rate = await pool.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM public.fp_deposit_receipts
            WHERE user_id=$1 AND created_at > NOW() - INTERVAL '1 hour'`, [identity.id]);
        if (Number(rate.rows[0]?.count ?? 0) >= 5) { send(res, 429, { error: "RECEIPT_SUBMISSION_RATE_LIMIT" }); return true; }

        const id = randomUUID();
        const extension = contentType === "image/jpeg" ? "jpg" :
          contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "pdf";
        const objectKey = "receipts/" + identity.id + "/" + id + "." + extension;
        const inserted = await pool.query<Receipt>(
          `INSERT INTO public.fp_deposit_receipts
             (id, user_id, client_request_id, amount_minor, currency, reference_text, customer_note,
              object_key, file_name, content_type, size_bytes, status)
           VALUES ($1,$2,$3,$4,'NGN',$5,$6,$7,$8,$9,$10,'pending_upload')
           ON CONFLICT (user_id, client_request_id) DO NOTHING
           RETURNING id, user_id, amount_minor::text, currency, reference_text, customer_note,
                     object_key, file_name, content_type, size_bytes, status, created_at,
                     reviewed_at, review_note, review_bank_reference, ledger_transaction_id`,
          [id, identity.id, input.clientRequestId, amount, reference, note, objectKey, fileName, contentType, sizeBytes]
        );
        let receipt = inserted.rows[0];
        if (!receipt) {
          const prior = await pool.query<Receipt>(
            `SELECT id, user_id, amount_minor::text, currency, reference_text, customer_note,
                    object_key, file_name, content_type, size_bytes, status, created_at,
                    reviewed_at, review_note, review_bank_reference, ledger_transaction_id
               FROM public.fp_deposit_receipts WHERE user_id=$1 AND client_request_id=$2 LIMIT 1`,
            [identity.id, input.clientRequestId]
          );
          receipt = prior.rows[0];
          if (!receipt || receipt.status !== "pending_upload" ||
              receipt.amount_minor !== amount || receipt.content_type !== contentType ||
              receipt.size_bytes !== sizeBytes || receipt.file_name !== fileName || receipt.reference_text !== reference || receipt.customer_note !== note) {
            send(res, 409, { error: "RECEIPT_REQUEST_ALREADY_EXISTS" }); return true;
          }
        } else {
          await pool.query(
            `INSERT INTO public.fp_deposit_receipt_audit_events
               (receipt_id, actor_user_id, actor_role, action, details)
             VALUES ($1,$2,'customer','submitted',$3::jsonb)`,
            [receipt.id, identity.id, JSON.stringify({ sizeBytes, contentType })]
          );
        }
        send(res, inserted.rowCount === 1 ? 201 : 200, {
          receiptId: receipt.id, status: receipt.status,
          uploadPath: "/customer/deposit-receipts/" + receipt.id + "/file",
          uploadMethod: "PUT", maxBytes: MAX_FILE_BYTES
        });
        return true;
      }

      if (customerMatch && req.method === "PUT") {
        const receiptId = customerMatch[1];
        const found = await pool.query<Receipt>(
          `SELECT id, user_id, amount_minor::text, currency, reference_text, customer_note,
                  object_key, file_name, content_type, size_bytes, status, created_at,
                  reviewed_at, review_note, review_bank_reference, ledger_transaction_id
             FROM public.fp_deposit_receipts WHERE id=$1 AND user_id=$2 LIMIT 1`,
          [receiptId, identity.id]
        );
        if (found.rowCount !== 1) { send(res, 404, { error: "RECEIPT_NOT_FOUND" }); return true; }
        const receipt = found.rows[0];
        if (receipt.status === "pending_review") { send(res, 200, { uploaded: true, status: "pending_review" }); return true; }
        if (receipt.status !== "pending_upload") { send(res, 409, { error: "RECEIPT_NOT_AWAITING_UPLOAD" }); return true; }
        const suppliedType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (suppliedType !== receipt.content_type) { send(res, 400, { error: "RECEIPT_CONTENT_TYPE_MISMATCH" }); return true; }
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        for await (const chunk of req) {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += part.length;
          if (totalBytes > MAX_FILE_BYTES || totalBytes > receipt.size_bytes) {
            send(res, 413, { error: "RECEIPT_FILE_TOO_LARGE", maxBytes: MAX_FILE_BYTES });
            return true;
          }
          chunks.push(part);
        }
        const fileBytes = Buffer.concat(chunks);
        if (fileBytes.length !== receipt.size_bytes || !hasExpectedMagic(fileBytes, receipt.content_type)) {
          send(res, 400, { error: "RECEIPT_FILE_CONTENT_INVALID_OR_SIZE_MISMATCH" });
          return true;
        }
        const uploadUrl = presignedUrl(config, "PUT", receipt.object_key, receipt.content_type, 120);
        let objectResponse: Response;
        try {
          objectResponse = await fetch(uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": receipt.content_type },
            body: new Uint8Array(fileBytes),
            signal: AbortSignal.timeout(15_000)
          });
        } catch (error) {
          console.error("FlowPay private receipt storage upload failed:", error instanceof Error ? error.message : "network error");
          send(res, 503, { error: "RECEIPT_STORAGE_UPLOAD_UNAVAILABLE" });
          return true;
        }
        if (!objectResponse.ok) {
          console.error("FlowPay private receipt storage returned HTTP", objectResponse.status);
          send(res, 503, { error: "RECEIPT_STORAGE_UPLOAD_FAILED" });
          return true;
        }
        const digest = createHash("sha256").update(fileBytes).digest("hex");
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const changed = await client.query(
            `UPDATE public.fp_deposit_receipts
                SET status='pending_review', content_sha256=$2, uploaded_at=NOW(), updated_at=NOW()
              WHERE id=$1 AND user_id=$3 AND status='pending_upload'
              RETURNING id`,
            [receipt.id, digest, identity.id]
          );
          if (changed.rowCount !== 1) {
            const current = await client.query<{ status: string }>(
              "SELECT status FROM public.fp_deposit_receipts WHERE id=$1 AND user_id=$2",
              [receipt.id, identity.id]
            );
            await client.query("ROLLBACK");
            if (current.rows[0]?.status === "pending_review") {
              send(res, 200, { uploaded: true, status: "pending_review" });
              return true;
            }
            send(res, 409, { error: "RECEIPT_STATUS_CHANGED" });
            return true;
          }
          await client.query(
            `INSERT INTO public.fp_deposit_receipt_audit_events
               (receipt_id, actor_user_id, actor_role, action, details)
             VALUES ($1,$2,'customer','uploaded',$3::jsonb)`,
            [receipt.id, identity.id, JSON.stringify({ sizeBytes: fileBytes.length, sha256: digest })]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
        send(res, 200, { uploaded: true, status: "pending_review", message: "Receipt uploaded and queued for review. No wallet credit is created until an authorised reviewer independently verifies the funds." });
        return true;
      }

            if (customerMatch && req.method === "GET") {
        const result = await pool.query<{ object_key: string; file_name: string; content_type: string }>(
          `SELECT object_key,file_name,content_type FROM public.fp_deposit_receipts
            WHERE id=$1 AND user_id=$2 AND status IN ('pending_review','approved','rejected') LIMIT 1`,
          [customerMatch[1], identity.id]
        );
        if (result.rowCount !== 1) { send(res, 404, { error: "RECEIPT_FILE_NOT_FOUND" }); return true; }
        const url = presignedUrl(config, "GET", result.rows[0].object_key, undefined, 120);
        send(res, 200, { fileUrl: url, fileName: result.rows[0].file_name, contentType: result.rows[0].content_type, expiresInSeconds: 120 });
        return true;
      }

      if (req.method === "GET" && pathname === adminRoot) {
        const result = await pool.query<Receipt>(
          `SELECT r.id, r.user_id, r.amount_minor::text, r.currency, r.reference_text, r.customer_note,
                  r.object_key, r.file_name, r.content_type, r.size_bytes, r.status, r.created_at,
                  r.reviewed_at, r.review_note, r.review_bank_reference, r.ledger_transaction_id,
                  u.email
             FROM public.fp_deposit_receipts r
             JOIN public.fp_users u ON u.id=r.user_id
            WHERE r.status IN ('pending_upload','pending_review')
            ORDER BY r.created_at ASC LIMIT 100`
        );
        send(res, 200, { receipts: result.rows.map(row => ({
          id: row.id, customerId: row.user_id, customerEmail: (row as Receipt & { email?: string }).email ?? null,
          amountMinor: row.amount_minor, currency: row.currency.trim(), reference: row.reference_text,
          note: row.customer_note, fileName: row.file_name, contentType: row.content_type,
          sizeBytes: row.size_bytes, status: row.status, createdAt: row.created_at,
          fileUrl: row.status === "pending_review" ? presignedUrl(config, "GET", row.object_key, undefined, 180) : null
        })) });
        return true;
      }

      if (adminMatch?.[1] && adminMatch[2] === "file" && req.method === "GET") {
        const result = await pool.query<{ object_key: string; file_name: string; content_type: string }>(
          `SELECT object_key,file_name,content_type FROM public.fp_deposit_receipts
            WHERE id=$1 AND status='pending_review' LIMIT 1`,
          [adminMatch[1]]
        );
        if (result.rowCount !== 1) { send(res, 404, { error: "PENDING_RECEIPT_FILE_NOT_FOUND" }); return true; }
        send(res, 200, { fileUrl: presignedUrl(config, "GET", result.rows[0].object_key, undefined, 180), fileName: result.rows[0].file_name, contentType: result.rows[0].content_type, expiresInSeconds: 180 });
        return true;
      }

      if (adminMatch?.[1] && adminMatch[2] === "review" && req.method === "POST") {
        let input: Record<string, unknown>;
        try { input = await readJson(req); }
        catch (error) {
          const status = error && typeof error === "object" && "statusCode" in error ? Number((error as {statusCode:unknown}).statusCode) : 400;
          send(res, status, { error: error instanceof Error ? error.message : "INVALID_PAYLOAD" }); return true;
        }
        if (Object.keys(input).some(key => !["decision","reviewNote","bankTransactionReference","fundsVerified"].includes(key))) {
          send(res, 400, { error: "UNSUPPORTED_REVIEW_FIELD" }); return true;
        }
        const decision = input.decision;
        const note = typeof input.reviewNote === "string" ? input.reviewNote.trim() : "";
        const bankReference = typeof input.bankTransactionReference === "string" ? input.bankTransactionReference.trim() : "";
        if ((decision !== "approve" && decision !== "reject") || note.length < 10 || note.length > 500) {
          send(res, 400, { error: "INVALID_REVIEW_DECISION_OR_NOTE" }); return true;
        }
        if (decision === "approve" && (input.fundsVerified !== true || bankReference.length < 5 || bankReference.length > 100)) {
          send(res, 400, { error: "INDEPENDENT_FUNDS_VERIFICATION_REQUIRED" }); return true;
        }
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const found = await client.query<Receipt>(
            `SELECT id, user_id, amount_minor::text, currency, reference_text, customer_note,
                    object_key, file_name, content_type, size_bytes, status, created_at,
                    reviewed_at, review_note, review_bank_reference, ledger_transaction_id
               FROM public.fp_deposit_receipts WHERE id=$1 FOR UPDATE`,
            [adminMatch[1]]
          );
          if (found.rowCount !== 1) { await client.query("ROLLBACK"); send(res,404,{error:"RECEIPT_NOT_FOUND"}); return true; }
          const receipt = found.rows[0];
          if (receipt.status !== "pending_review") { await client.query("ROLLBACK"); send(res,409,{error:"RECEIPT_NOT_PENDING_REVIEW",status:receipt.status}); return true; }
          let transactionId: string | null = null;
          if (decision === "approve") {
            const wallet = await client.query<{ id: string }>(
              `SELECT id FROM public.fp_accounts
                WHERE user_id=$1 AND account_type='customer'
                  AND currency='NGN' AND status='active'
                FOR UPDATE`,
              [receipt.user_id]
            );
            if (wallet.rowCount !== 1) { await client.query("ROLLBACK"); send(res,409,{error:"CUSTOMER_NGN_WALLET_NOT_UNIQUE_OR_ACTIVE"}); return true; }
            const clearing = await client.query<{ id: string }>(
              `SELECT id FROM public.fp_accounts WHERE account_type='system' AND currency='NGN'
                AND system_account_role='manual_receipt_ngn_clearing' AND status='active' FOR UPDATE`
            );
            if (clearing.rowCount !== 1) { await client.query("ROLLBACK"); send(res,503,{error:"RECEIPT_CLEARING_ACCOUNT_NOT_CONFIGURED"}); return true; }
            const inserted = await client.query<{ id: string }>(
              `INSERT INTO public.fp_ledger_transactions
                 (idempotency_key,transaction_type,status,description)
               VALUES ($1,'manual_receipt_deposit','pending','Manually verified bank deposit receipt')
               ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
              ["manual-receipt:" + receipt.id]
            );
            if (inserted.rowCount === 1) transactionId = inserted.rows[0].id;
            else {
              const prior = await client.query<{ id: string; status: string }>(
                `SELECT id,status FROM public.fp_ledger_transactions WHERE idempotency_key=$1 FOR UPDATE`,
                ["manual-receipt:" + receipt.id]
              );
              if (prior.rowCount !== 1 || prior.rows[0].status !== "posted") {
                await client.query("ROLLBACK"); send(res,503,{error:"EXISTING_RECEIPT_LEDGER_REQUIRES_RECONCILIATION"}); return true;
              }
              transactionId = prior.rows[0].id;
            }
            const entryCount = await client.query<{ count: number }>(
              "SELECT COUNT(*)::int AS count FROM public.fp_ledger_entries WHERE transaction_id=$1",
              [transactionId]
            );
            if (Number(entryCount.rows[0]?.count ?? 0) !== 0) {
              await client.query("ROLLBACK"); send(res,503,{error:"RECEIPT_LEDGER_ENTRIES_REQUIRE_RECONCILIATION"}); return true;
            }
            const amount = BigInt(receipt.amount_minor);
            await client.query(
              `INSERT INTO public.fp_ledger_entries (transaction_id,account_id,amount_minor,currency)
               VALUES ($1,$2,$3,'NGN'),($1,$4,$5,'NGN')`,
              [transactionId, wallet.rows[0].id, amount.toString(), clearing.rows[0].id, (-amount).toString()]
            );
            await client.query(
              "UPDATE public.fp_ledger_transactions SET status='posted',posted_at=NOW() WHERE id=$1 AND status='pending'",
              [transactionId]
            );
          }
          await client.query(
            `UPDATE public.fp_deposit_receipts
                SET status=$2, reviewed_by=$3, reviewed_at=NOW(), review_note=$4,
                    review_bank_reference=$5, ledger_transaction_id=$6, updated_at=NOW()
              WHERE id=$1 AND status='pending_review'`,
            [receipt.id, decision === "approve" ? "approved" : "rejected", identity.id, note,
              decision === "approve" ? bankReference : null, transactionId]
          );
          await audit(client, receipt.id, identity.id, "super_admin", decision === "approve" ? "approved" : "rejected", {
            bankTransactionReference: decision === "approve" ? bankReference : null,
            fundsVerified: decision === "approve" ? true : false,
            amountMinor: receipt.amount_minor,
            ledgerTransactionId: transactionId
          });
          await client.query("COMMIT");
          send(res, 200, {
            reviewed: true, status: decision === "approve" ? "approved" : "rejected",
            walletCredited: decision === "approve", transactionId,
            message: decision === "approve" ? "Funds were attested as independently verified and the balanced wallet credit was posted." : "Receipt rejected. No wallet credit was posted."
          });
          return true;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          if (error && typeof error === "object" && "code" in error && (error as {code:unknown}).code === "23505") {
            send(res,409,{error:"BANK_REFERENCE_ALREADY_USED"}); return true;
          }
          console.error("FlowPay receipt review failed:", error instanceof Error ? error.message : "database error");
          send(res,503,{error:"RECEIPT_REVIEW_UNAVAILABLE"});
          return true;
        } finally { client.release(); }
      }

      send(res, 405, { error: "METHOD_NOT_ALLOWED" });
      return true;
    } catch (error) {
      console.error("FlowPay receipt request failed:", error instanceof Error ? error.message : "unknown error");
      send(res, 503, { error: "RECEIPT_SERVICE_UNAVAILABLE" });
      return true;
    }
  };
}
