import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { jwtVerify, type JWTVerifyGetKey } from "jose";
import { Signature, WebApi } from "smile-identity-core";

type Dependencies = {
  pool: Pool | null;
  jwks: JWTVerifyGetKey | null;
  issuer: string | undefined;
  audience: string | undefined;
};
type CapturedImage = { image_type_id: number; image: string };
type CallbackPayload = {
  timestamp?: string | number;
  signature?: string;
  PartnerParams?: Record<string, unknown>;
  ResultCode?: string | number;
  ResultText?: string;
  SmileJobID?: string;
  Actions?: Record<string, unknown>;
};

const CAMERA_SDK_VERSION = "11.0.1";
const MAX_CAPTURE_BYTES = 12 * 1024 * 1024;
const MAX_CALLBACK_BYTES = 256 * 1024;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new RangeError("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getSmileConfig() {
  const partnerId = process.env.SMILE_ID_PARTNER_ID?.trim() ?? "";
  const apiKey = process.env.SMILE_ID_API_KEY?.trim() ?? "";
  const callbackUrl = process.env.SMILE_ID_CALLBACK_URL?.trim() ?? "";
  if (process.env.SMILE_ID_ENVIRONMENT !== "sandbox" || !partnerId || !apiKey || !callbackUrl) return null;
  try {
    const callback = new URL(callbackUrl);
    if (callback.protocol !== "https:" || callback.pathname.replace(/\/+$/, "") !== "/face-verification/callback") return null;
  } catch {
    return null;
  }
  return { partnerId, apiKey, callbackUrl };
}

async function authenticateCustomer(req: IncomingMessage, deps: Dependencies): Promise<{ userId: string } | { status: number; error: string }> {
  const { pool, jwks, issuer, audience } = deps;
  if (!pool || !jwks || !issuer || !audience) return { status: 503, error: "FACE_VERIFICATION_AUTH_NOT_CONFIGURED" };
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return { status: 401, error: "AUTHENTICATION_REQUIRED" };
  try {
    const { payload } = await jwtVerify(token, jwks, { algorithms: ["EdDSA"], issuer, audience });
    if (typeof payload.sub !== "string" || !payload.sub) return { status: 401, error: "INVALID_SESSION" };
    const identity = await pool.query(
      'SELECT app_user.id FROM neon_auth."user" AS auth_user JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text WHERE auth_user.id::text = $1 AND auth_user."emailVerified" = true AND app_user.status = \'active\' LIMIT 1',
      [payload.sub]
    );
    if (identity.rowCount !== 1) return { status: 403, error: "ACTIVE_CUSTOMER_ACCOUNT_REQUIRED" };
    return { userId: String(identity.rows[0].id) };
  } catch (error) {
    if (error instanceof Error && ["JWTExpired", "JWSSignatureVerificationFailed", "JWTClaimValidationFailed", "JWSInvalid", "JWTInvalid"].includes(error.name)) {
      return { status: 401, error: "INVALID_SESSION" };
    }
    throw error;
  }
}

function normalizeImage(input: unknown): CapturedImage | null {
  if (!isRecord(input)) return null;
  const imageType = Number(input.image_type_id);
  if (imageType !== 2 && imageType !== 6) return null;
  if (typeof input.image !== "string") return null;
  let image = input.image.trim().replace(/^data:image\/(?:jpeg|jpg|png|webp);base64,/i, "");
  image = image.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image)) return null;
  const decoded = Buffer.from(image, "base64");
  if (!decoded.length || decoded.length > 1_500_000) return null;
  if (decoded.toString("base64").replace(/=+$/, "") !== image.replace(/=+$/, "")) return null;
  return { image_type_id: imageType, image };
}

function actionText(actions: Record<string, unknown>, name: string): string | null {
  const value = actions[name];
  return typeof value === "string" ? value.trim().slice(0, 40) : null;
}

function deriveVerificationStatus(resultCode: string, actions: Record<string, unknown>) {
  const liveness = actionText(actions, "Liveness_Check");
  const selfie = actionText(actions, "Selfie_Check");
  const provided = actionText(actions, "Selfie_Provided");
  const register = actionText(actions, "Register_Selfie");
  const humanLiveness = actionText(actions, "Human_Review_Liveness_Check");
  const humanSelfie = actionText(actions, "Human_Review_Selfie_Check");

  // Any explicit failed check is a failed identity result.
  if (
    ["0841", "0941", "0942", "1241", "1242"].includes(resultCode) ||
    [liveness, selfie, provided, register, humanLiveness, humanSelfie].includes("Failed") ||
    register === "Rejected"
  ) return "rejected";

  // A possible spoof or inconclusive human review is never approved.
  if (
    ["0844", "0846"].includes(resultCode) ||
    register === "Provisionally Approved" ||
    [humanLiveness, humanSelfie, liveness, selfie].some(value =>
      value === "Under Review" || value === "Unable To Determine"
    )
  ) return "under_review";

  // The documented registration result and its registration action must both pass.
  if (
    ["0840", "1240"].includes(resultCode) &&
    register === "Approved" &&
    liveness === "Passed" &&
    selfie === "Passed" &&
    provided === "Passed"
  ) return "verified";

  // Provider request/processing errors are not identity rejections.
  if (/^(22|23|24)\d{2}$/.test(resultCode) || resultCode === "0001") return "failed";
  return "pending";
}
function safeResultText(value: unknown) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240) : null;
}

export function createFaceVerificationHandler(deps: Dependencies) {
  return async function handleFaceVerification(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
    const { pool } = deps;

    if (pathname === "/face-verification/status" && req.method === "GET") {
      let schemaReady = false;
      if (pool) {
        try {
          const schema = await pool.query("SELECT to_regclass('public.fp_face_verification_jobs') AS table_name");
          schemaReady = Boolean(schema.rows[0]?.table_name);
        } catch {
          schemaReady = false;
        }
      }
      const configured = Boolean(getSmileConfig());
      const authReady = Boolean(pool && deps.jwks && deps.issuer && deps.audience);
      send(res, 200, {
        provider: "smile_id",
        environment: "sandbox",
        configured,
        schemaReady,
        verificationEnabled: configured && schemaReady && authReady,
        productionEnabled: false,
        cameraSdkVersion: CAMERA_SDK_VERSION,
        message: !configured
          ? "Smile ID sandbox secrets and the HTTPS callback URL are not configured."
          : !schemaReady
            ? "Apply the additive face-verification migration before enabling capture."
            : !authReady
              ? "Customer authentication is not configured on the API."
              : "Smile ID sandbox face and liveness capture is available for authenticated customers."
      });
      return true;
    }

    if (pathname === "/face-verification/callback" && req.method === "POST") {
      const config = getSmileConfig();
      if (!pool || !config) {
        send(res, 503, { error: "FACE_VERIFICATION_CALLBACK_NOT_CONFIGURED" });
        return true;
      }
      let body: unknown;
      try {
        body = await readJson(req, MAX_CALLBACK_BYTES);
      } catch (error) {
        send(res, error instanceof RangeError ? 413 : 400, { error: "INVALID_CALLBACK_PAYLOAD" });
        return true;
      }
      if (!isRecord(body)) {
        send(res, 400, { error: "INVALID_CALLBACK_PAYLOAD" });
        return true;
      }
      const callback = body as CallbackPayload;
      if ((typeof callback.timestamp !== "string" && typeof callback.timestamp !== "number") || typeof callback.signature !== "string") {
        send(res, 401, { error: "CALLBACK_SIGNATURE_REQUIRED" });
        return true;
      }
      try {
        if (!new Signature(config.partnerId, config.apiKey).confirm_signature(callback.timestamp, callback.signature)) {
          send(res, 401, { error: "INVALID_CALLBACK_SIGNATURE" });
          return true;
        }
      } catch {
        send(res, 401, { error: "INVALID_CALLBACK_SIGNATURE" });
        return true;
      }

      const partnerParams = callback.PartnerParams;
      const jobId = typeof partnerParams?.job_id === "string" ? partnerParams.job_id : "";
      const smileUserId = typeof partnerParams?.user_id === "string" ? partnerParams.user_id : "";
      if (!jobId || !smileUserId || Number(partnerParams?.job_type) !== 4) {
        send(res, 400, { error: "INVALID_CALLBACK_JOB" });
        return true;
      }
      const resultCode = String(callback.ResultCode ?? "").trim().slice(0, 20);
      const actions = isRecord(callback.Actions) ? callback.Actions : {};
      const status = deriveVerificationStatus(resultCode, actions);
      try {
        const updated = await pool.query(
          "UPDATE public.fp_face_verification_jobs SET smile_job_id = COALESCE(NULLIF($3, ''), smile_job_id), status = CASE WHEN status IN ('verified', 'rejected', 'failed') THEN status WHEN $4 = 'pending' AND status = 'under_review' THEN 'under_review' ELSE $4 END, result_code = NULLIF($5, ''), result_text = $6, liveness_check = $7, selfie_check = $8, selfie_provided = $9, register_selfie = $10, human_review_liveness_check = $11, human_review_selfie_check = $12, verified_at = CASE WHEN $4 = 'verified' THEN COALESCE(verified_at, NOW()) ELSE verified_at END, updated_at = NOW() WHERE job_id = $1 AND smile_user_id = $2 RETURNING id",
          [
            jobId,
            smileUserId,
            typeof callback.SmileJobID === "string" ? callback.SmileJobID.slice(0, 80) : "",
            status,
            resultCode,
            safeResultText(callback.ResultText),
            actionText(actions, "Liveness_Check"),
            actionText(actions, "Selfie_Check"),
            actionText(actions, "Selfie_Provided"),
            actionText(actions, "Register_Selfie"),
            actionText(actions, "Human_Review_Liveness_Check"),
            actionText(actions, "Human_Review_Selfie_Check")
          ]
        );
        send(res, 200, { received: true, matched: updated.rowCount === 1 });
      } catch (error) {
        console.error("FlowPay face verification callback persistence failed:", error instanceof Error ? error.message : "unknown database error");
        send(res, 503, { error: "CALLBACK_PERSISTENCE_UNAVAILABLE" });
      }
      return true;
    }

    if (pathname !== "/customer/face-verification" || (req.method !== "GET" && req.method !== "POST")) return false;
    const identity = await authenticateCustomer(req, deps);
    if ("status" in identity) {
      send(res, identity.status, { error: identity.error });
      return true;
    }
    if (!pool) {
      send(res, 503, { error: "FACE_VERIFICATION_DATABASE_NOT_CONFIGURED" });
      return true;
    }

    try {
      if (req.method === "GET") {
        const result = await pool.query(
          "SELECT status, result_code, result_text, liveness_check, selfie_check, selfie_provided, register_selfie, human_review_liveness_check, human_review_selfie_check, created_at, updated_at, verified_at FROM public.fp_face_verification_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
          [identity.userId]
        );
        const row = result.rows[0];
        const config = getSmileConfig();
        send(res, 200, {
          provider: "smile_id",
          environment: "sandbox",
          configured: Boolean(config),
          verificationEnabled: Boolean(config),
          productionEnabled: false,
          status: row?.status ?? "not_started",
          resultCode: row?.result_code ?? null,
          resultText: row?.result_text ?? null,
          checks: {
            liveness: row?.liveness_check ?? null,
            selfie: row?.selfie_check ?? null,
            selfieProvided: row?.selfie_provided ?? null,
            registerSelfie: row?.register_selfie ?? null,
            humanReviewLiveness: row?.human_review_liveness_check ?? null,
            humanReviewSelfie: row?.human_review_selfie_check ?? null
          },
          createdAt: row?.created_at ?? null,
          updatedAt: row?.updated_at ?? null,
          verifiedAt: row?.verified_at ?? null
        });
        return true;
      }

      const config = getSmileConfig();
      if (!config) {
        send(res, 503, { error: "SMILE_ID_SANDBOX_NOT_CONFIGURED", message: "Face verification is unavailable until the Smile ID sandbox secrets and HTTPS callback URL are configured on the API service." });
        return true;
      }
      let body: unknown;
      try {
        body = await readJson(req, MAX_CAPTURE_BYTES);
      } catch (error) {
        send(res, error instanceof RangeError ? 413 : 400, { error: "INVALID_CAPTURE_PAYLOAD" });
        return true;
      }
      if (!isRecord(body) || body.consentGiven !== true || !Array.isArray(body.images)) {
        send(res, 400, { error: "EXPLICIT_CONSENT_AND_CAPTURE_REQUIRED" });
        return true;
      }
      const normalizedImages = body.images.map(normalizeImage);
      if (normalizedImages.length < 2 || normalizedImages.length > 12 || normalizedImages.some((image) => image === null)) {
        send(res, 400, { error: "INVALID_LIVENESS_CAPTURE", message: "The official camera capture must include a selfie and liveness frames." });
        return true;
      }
      const images = normalizedImages as CapturedImage[];
      if (!images.some((image) => image.image_type_id === 2) || !images.some((image) => image.image_type_id === 6)) {
        send(res, 400, { error: "SELFIE_AND_LIVENESS_FRAMES_REQUIRED" });
        return true;
      }
      const totalBytes = images.reduce((sum, image) => sum + Buffer.from(image.image, "base64").length, 0);
      if (totalBytes > 9 * 1024 * 1024) {
        send(res, 413, { error: "CAPTURE_PAYLOAD_TOO_LARGE" });
        return true;
      }

      const latest = await pool.query(
        "SELECT status FROM public.fp_face_verification_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
        [identity.userId]
      );
      if (latest.rows[0]?.status === "verified") {
        send(res, 409, { error: "FACE_ALREADY_VERIFIED", status: "verified" });
        return true;
      }
      if (["pending", "under_review"].includes(latest.rows[0]?.status ?? "")) {
        send(res, 409, { error: "FACE_VERIFICATION_ALREADY_IN_PROGRESS", status: latest.rows[0].status });
        return true;
      }

      const jobId = "fp-job-" + randomUUID();
      const smileUserId = "fp-user-" + randomUUID();
      const partnerParams = isRecord(body.partner_params) ? body.partner_params : {};
      const libraryVersionInput = partnerParams.libraryVersion;
      const libraryVersion = typeof libraryVersionInput === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(libraryVersionInput)
        ? libraryVersionInput
        : CAMERA_SDK_VERSION;

      await pool.query(
        "INSERT INTO public.fp_face_verification_jobs (user_id, smile_user_id, job_id, status, consented_at) VALUES ($1, $2, $3, 'pending', NOW())",
        [identity.userId, smileUserId, jobId]
      );
      try {
        const connection = new WebApi(config.partnerId, config.callbackUrl, config.apiKey, 0);
        const result = await connection.submit_job(
          { user_id: smileUserId, job_id: jobId, job_type: 4, libraryVersion },
          images,
          {},
          { return_job_status: false, return_images: false, return_history: false }
        ) as Record<string, unknown>;
        const smileJobId = typeof result.smile_job_id === "string" ? result.smile_job_id.slice(0, 80) : "";
        await pool.query(
          "UPDATE public.fp_face_verification_jobs SET smile_job_id = NULLIF($2, ''), updated_at = NOW() WHERE job_id = $1",
          [jobId, smileJobId]
        );
        send(res, 202, { accepted: true, status: "pending", message: "Your capture was submitted to Smile ID sandbox. Final status appears after provider checks and callback verification." });
      } catch (error) {
        await pool.query(
          "UPDATE public.fp_face_verification_jobs SET status = 'failed', result_text = 'Provider submission failed', updated_at = NOW() WHERE job_id = $1 AND status NOT IN ('verified', 'rejected')",
          [jobId]
        );
        console.error("FlowPay Smile ID sandbox submission failed:", error instanceof Error ? error.message : "unknown provider error");
        send(res, 502, { error: "FACE_VERIFICATION_SUBMISSION_FAILED", message: "Smile ID could not accept this capture. Check your connection and try again." });
      }
      return true;
    } catch (error) {
      console.error("FlowPay face verification request failed:", error instanceof Error ? error.message : "unknown error");
      send(res, 503, { error: "FACE_VERIFICATION_SERVICE_UNAVAILABLE" });
      return true;
    }
  };
}