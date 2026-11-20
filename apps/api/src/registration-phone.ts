import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";

type Options = {
  pool: Pool | null;
  apiKey?: string;
  senderId?: string;
  baseUrl?: string;
  otpSecret?: string;
  channel?: string;
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(raw, "utf8") > 8_192) throw new Error("PAYLOAD_TOO_LARGE");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw || "{}"); } catch { throw new Error("INVALID_JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_PAYLOAD");
  return parsed as Record<string, unknown>;
}

export function normalizeNigerianPhone(value: unknown): { e164: string; termii: string } | null {
  if (typeof value !== "string") return null;
  const digits = value.trim().replace(/[\\s().-]/g, "").replace(/^\\+/, "");
  let international = digits;
  if (/^0[789][0-9]{9}$/.test(digits)) international = "234" + digits.slice(1);
  if (!/^234[789][0-9]{9}$/.test(international)) return null;
  return { e164: "+" + international, termii: international };
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(email) ? email : null;
}

function otpHash(secret: string, email: string, phone: string, code: string): string {
  return createHmac("sha256", secret).update(email + "|" + phone + "|" + code).digest("hex");
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function validTermiiBase(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\\/+$/, "");
  } catch {
    return null;
  }
}

export function createRegistrationPhoneHandler(options: Options) {
  const pool = options.pool;
  const apiKey = options.apiKey?.trim() ?? "";
  const senderId = options.senderId?.trim() ?? "";
  const baseUrl = validTermiiBase(options.baseUrl?.trim() || "https://api.ng.termii.com");
  const otpSecret = options.otpSecret?.trim() ?? "";
  const channel = options.channel?.trim() || "dnd";

  async function handleSend(req: IncomingMessage, res: ServerResponse) {
    let input: Record<string, unknown>;
    try { input = await readJson(req); }
    catch (error) {
      const message = error instanceof Error ? error.message : "INVALID_PAYLOAD";
      send(res, message === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: message });
      return;
    }
    if (Object.keys(input).some(key => !["email", "phoneNumber"].includes(key))) {
      send(res, 400, { error: "UNSUPPORTED_PHONE_REGISTRATION_FIELD" });
      return;
    }
    const email = normalizeEmail(input.email);
    const phone = normalizeNigerianPhone(input.phoneNumber);
    if (!email || !phone) {
      send(res, 400, { error: "VALID_EMAIL_AND_NIGERIAN_MOBILE_REQUIRED" });
      return;
    }
    if (!pool || !apiKey || !senderId || !baseUrl || Buffer.byteLength(otpSecret, "utf8") < 32 ||
        !["dnd", "generic"].includes(channel)) {
      send(res, 503, { error: "PHONE_VERIFICATION_NOT_CONFIGURED" });
      return;
    }

    try {
      const existingAlias = await pool.query(
        "SELECT 1 FROM public.fp_customer_phone_aliases WHERE phone_e164 = $1 LIMIT 1",
        [phone.e164]
      );
      // Avoid revealing whether a phone number already belongs to another customer.
      if (existingAlias.rowCount === 1) {
        send(res, 202, { sent: true, message: "If the number is eligible, a verification code will be sent." });
        return;
      }

      const code = String(randomInt(100_000, 1_000_000));
      const hash = otpHash(otpSecret, email, phone.e164, code);
      const reservation = await pool.query(
        `INSERT INTO public.fp_registration_phone_challenges
           (email, phone_e164, otp_hash, expires_at, attempts, window_started_at, send_count, last_sent_at, verified_at, consumed_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '5 minutes', 0, NOW(), 1, NOW(), NULL, NULL)
         ON CONFLICT (email) DO UPDATE
           SET phone_e164 = EXCLUDED.phone_e164,
               otp_hash = EXCLUDED.otp_hash,
               expires_at = EXCLUDED.expires_at,
               attempts = 0,
               window_started_at = CASE
                 WHEN fp_registration_phone_challenges.window_started_at < NOW() - INTERVAL '1 hour'
                 THEN NOW() ELSE fp_registration_phone_challenges.window_started_at END,
               send_count = CASE
                 WHEN fp_registration_phone_challenges.window_started_at < NOW() - INTERVAL '1 hour'
                 THEN 1 ELSE fp_registration_phone_challenges.send_count + 1 END,
               last_sent_at = NOW(),
               verified_at = NULL,
               consumed_at = NULL
         WHERE fp_registration_phone_challenges.last_sent_at < NOW() - INTERVAL '60 seconds'
           AND (fp_registration_phone_challenges.window_started_at < NOW() - INTERVAL '1 hour'
                OR fp_registration_phone_challenges.send_count < 5)
         RETURNING send_count`,
        [email, phone.e164, hash]
      );
      if (reservation.rowCount !== 1) {
        send(res, 429, { error: "PHONE_OTP_RATE_LIMITED", message: "Wait before requesting another verification code. A maximum of five codes can be requested per hour." });
        return;
      }

      const sms = "Your FlowPay registration code is " + code + ". It expires in 5 minutes. Do not share this code with anyone.";
      let providerResponse: Response;
      try {
        providerResponse = await fetch(baseUrl + "/api/sms/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            to: phone.termii,
            from: senderId,
            sms,
            type: "plain",
            channel
          }),
          signal: AbortSignal.timeout(10_000)
        });
      } catch {
        await pool.query(
          "UPDATE public.fp_registration_phone_challenges SET expires_at = NOW() WHERE email = $1 AND otp_hash = $2",
          [email, hash]
        );
        send(res, 502, { error: "PHONE_OTP_DELIVERY_UNAVAILABLE" });
        return;
      }
      const providerBody = await providerResponse.json().catch(() => ({})) as Record<string, unknown>;
      const providerAccepted = providerResponse.ok &&
        (typeof providerBody.message_id === "string" || /successfully sent/i.test(String(providerBody.message ?? "")));
      if (!providerAccepted) {
        await pool.query(
          "UPDATE public.fp_registration_phone_challenges SET expires_at = NOW() WHERE email = $1 AND otp_hash = $2",
          [email, hash]
        );
        send(res, 502, { error: "PHONE_OTP_DELIVERY_REJECTED" });
        return;
      }
      send(res, 202, { sent: true, message: "If the number is eligible, a verification code will be sent." });
    } catch (error) {
      console.error("FlowPay phone OTP send failed:", error instanceof Error ? error.message : "database or provider error");
      send(res, 503, { error: "PHONE_OTP_SERVICE_UNAVAILABLE" });
    }
  }

  async function handleVerify(req: IncomingMessage, res: ServerResponse) {
    let input: Record<string, unknown>;
    try { input = await readJson(req); }
    catch (error) {
      const message = error instanceof Error ? error.message : "INVALID_PAYLOAD";
      send(res, message === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: message });
      return;
    }
    if (Object.keys(input).some(key => !["email", "phoneNumber", "code"].includes(key))) {
      send(res, 400, { error: "UNSUPPORTED_PHONE_REGISTRATION_FIELD" });
      return;
    }
    const email = normalizeEmail(input.email);
    const phone = normalizeNigerianPhone(input.phoneNumber);
    const code = typeof input.code === "string" ? input.code.trim() : "";
    if (!email || !phone || !/^\\d{6}$/.test(code)) {
      send(res, 400, { error: "INVALID_PHONE_VERIFICATION_DETAILS" });
      return;
    }
    if (!pool || Buffer.byteLength(otpSecret, "utf8") < 32) {
      send(res, 503, { error: "PHONE_VERIFICATION_NOT_CONFIGURED" });
      return;
    }

    let client: PoolClient;
    try { client = await pool.connect(); }
    catch {
      send(res, 503, { error: "PHONE_VERIFICATION_DATABASE_UNAVAILABLE" });
      return;
    }
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        otp_hash: string; phone_e164: string; expires_at: Date;
        attempts: number; verified_at: Date | null; consumed_at: Date | null;
      }>(
        `SELECT otp_hash, phone_e164, expires_at, attempts, verified_at, consumed_at
           FROM public.fp_registration_phone_challenges
          WHERE email = $1
          FOR UPDATE`,
        [email]
      );
      if (result.rowCount !== 1 || result.rows[0].phone_e164 !== phone.e164 ||
          result.rows[0].consumed_at || new Date(result.rows[0].expires_at).getTime() <= Date.now() ||
          Number(result.rows[0].attempts) >= 5) {
        await client.query("ROLLBACK");
        send(res, 400, { error: "PHONE_VERIFICATION_CODE_INVALID_OR_EXPIRED" });
        return;
      }
      const challenge = result.rows[0];
      if (challenge.verified_at) {
        await client.query("COMMIT");
        send(res, 200, { verified: true, phoneNumber: phone.e164 });
        return;
      }
      const expected = otpHash(otpSecret, email, phone.e164, code);
      if (!safeEqualHex(challenge.otp_hash, expected)) {
        const attempts = Number(challenge.attempts) + 1;
        await client.query(
          `UPDATE public.fp_registration_phone_challenges
              SET attempts = $2,
                  expires_at = CASE WHEN $2 >= 5 THEN NOW() ELSE expires_at END
            WHERE email = $1`,
          [email, attempts]
        );
        await client.query("COMMIT");
        send(res, 400, { error: attempts >= 5 ? "PHONE_VERIFICATION_ATTEMPTS_EXCEEDED" : "PHONE_VERIFICATION_CODE_INVALID" });
        return;
      }
      await client.query(
        `UPDATE public.fp_registration_phone_challenges
            SET verified_at = NOW(), expires_at = NOW() + INTERVAL '24 hours'
          WHERE email = $1`,
        [email]
      );
      await client.query("COMMIT");
      send(res, 200, { verified: true, phoneNumber: phone.e164 });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("FlowPay phone OTP verification failed:", error instanceof Error ? error.message : "database error");
      send(res, 503, { error: "PHONE_VERIFICATION_UNAVAILABLE" });
    } finally {
      client.release();
    }
  }

  return async function handleRegistrationPhone(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\\/+$/, "") || "/";
    if (req.method === "POST" && path === "/auth/registration/phone/send") {
      await handleSend(req, res);
      return true;
    }
    if (req.method === "POST" && path === "/auth/registration/phone/verify") {
      await handleVerify(req, res);
      return true;
    }
    return false;
  };
}
