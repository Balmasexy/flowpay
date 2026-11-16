import type { Pool } from "pg";

/**
 * Production money movement is allowed only after a verified production
 * SmartSelfie result. Sandbox approvals never satisfy this check.
 */
export async function hasProductionFaceVerification(pool: Pool, userId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
       FROM public.fp_face_verification_jobs
      WHERE user_id = $1
        AND environment = 'production'
        AND status = 'verified'
      ORDER BY verified_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [userId]
  );
  return result.rowCount === 1;
}

export async function productionFaceVerificationAllowed(pool: Pool, userId: string): Promise<boolean> {
  if (process.env.FLOWPAY_REQUIRE_FACE_VERIFICATION !== "true") return true;
  return hasProductionFaceVerification(pool, userId);
}
