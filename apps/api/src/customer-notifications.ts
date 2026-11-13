import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { createRemoteJWKSet, jwtVerify } from "jose";

type Options = {
  pool: Pool | null;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
  issuer?: string;
  audience?: string;
};
type TransferNotification = {
  userId: string;
  eventKey: string;
  transactionId: string;
  reference: string;
  transferType: "wallet" | "bank";
  direction: "sent" | "received";
  status: "success" | "failed" | "reversed";
  amountMinor: string;
  title: string;
  message: string;
};

/**
 * Insert in the caller's current DB transaction. Duplicate provider webhook
 * deliveries and status refreshes are ignored by (user_id, event_key).
 */
export async function enqueueTransferNotification(
  client: PoolClient,
  input: TransferNotification
): Promise<void> {
  await client.query(
    `INSERT INTO public.fp_customer_notifications
       (user_id, event_key, transaction_id, reference, transfer_type, direction,
        status, amount_minor, currency, title, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'NGN', $9, $10)
     ON CONFLICT (user_id, event_key) DO NOTHING`,
    [
      input.userId, input.eventKey, input.transactionId, input.reference,
      input.transferType, input.direction, input.status, input.amountMinor,
      input.title, input.message
    ]
  );
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}
function isJwtError(error: unknown) {
  return error instanceof Error && [
    "JWTExpired", "JWSSignatureVerificationFailed", "JWTClaimValidationFailed",
    "JWSInvalid", "JWTInvalid"
  ].includes(error.name);
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

export function createCustomerNotificationsHandler(options: Options) {
  const { pool, jwks, issuer, audience } = options;
  return async function handleCustomerNotifications(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const isList = req.method === "GET" && path === "/customer/notifications";
    const isRead = req.method === "POST" && path === "/customer/notifications/read";
    if (!isList && !isRead) return false;
    if (!pool || !jwks || !issuer || !audience) {
      send(res, 503, { error: "CUSTOMER_NOTIFICATIONS_NOT_CONFIGURED" });
      return true;
    }
    const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if (!bearer) { send(res, 401, { error: "AUTHENTICATION_REQUIRED" }); return true; }

    let userId: string;
    try {
      const { payload } = await jwtVerify(bearer[1], jwks, { algorithms: ["EdDSA"], issuer, audience });
      if (typeof payload.sub !== "string" || !payload.sub) {
        send(res, 401, { error: "INVALID_SESSION" }); return true;
      }
      const identity = await pool.query<{ id: string }>(
        `SELECT app_user.id
           FROM neon_auth."user" AS auth_user
           JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
          WHERE auth_user.id::text = $1
            AND auth_user."emailVerified" = true
            AND app_user.status = 'active'
            AND app_user.role IN ('customer', 'super_admin')
          LIMIT 1`,
        [payload.sub]
      );
      if (identity.rowCount !== 1) {
        send(res, 403, { error: "ACTIVE_FLOWPAY_CUSTOMER_REQUIRED" }); return true;
      }
      userId = identity.rows[0].id;
    } catch (error) {
      if (isJwtError(error)) send(res, 401, { error: "INVALID_SESSION" });
      else {
        console.error("FlowPay notifications authentication failed:", error instanceof Error ? error.message : "unknown error");
        send(res, 503, { error: "CUSTOMER_NOTIFICATIONS_AUTH_UNAVAILABLE" });
      }
      return true;
    }

    if (isList) {
      const rawLimit = Number(url.searchParams.get("limit") ?? "30");
      const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 30;
      try {
        const [items, unread] = await Promise.all([
          pool.query(
            `SELECT id, reference, transfer_type, direction, status, amount_minor::text AS amount_minor,
                    currency, title, message, created_at, read_at
               FROM public.fp_customer_notifications
              WHERE user_id = $1
              ORDER BY created_at DESC, id DESC
              LIMIT $2`,
            [userId, limit]
          ),
          pool.query<{ unread_count: string }>(
            `SELECT COUNT(*)::text AS unread_count
               FROM public.fp_customer_notifications
              WHERE user_id = $1 AND read_at IS NULL`,
            [userId]
          )
        ]);
        send(res, 200, {
          notifications: items.rows.map(row => ({
            id: row.id,
            reference: row.reference,
            transferType: row.transfer_type,
            direction: row.direction,
            status: row.status,
            amountMinor: row.amount_minor,
            currency: String(row.currency).trim(),
            title: row.title,
            message: row.message,
            createdAt: row.created_at,
            readAt: row.read_at
          })),
          unreadCount: Number(unread.rows[0]?.unread_count ?? "0")
        });
      } catch (error) {
        console.error("FlowPay customer notifications read failed:", error instanceof Error ? error.message : "database error");
        send(res, 503, { error: "CUSTOMER_NOTIFICATIONS_UNAVAILABLE" });
      }
      return true;
    }

    let input: Record<string, unknown>;
    try { input = await readJson(req); }
    catch (error) {
      const message = error instanceof Error ? error.message : "INVALID_PAYLOAD";
      send(res, message === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: message });
      return true;
    }
    if (Object.keys(input).some(key => !["ids", "all"].includes(key))) {
      send(res, 400, { error: "UNSUPPORTED_NOTIFICATION_READ_FIELD" }); return true;
    }
    const markAll = input.all === true;
    const ids = input.ids;
    if (!markAll && (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 ||
        ids.some(id => typeof id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)))) {
      send(res, 400, { error: "VALID_NOTIFICATION_IDS_REQUIRED" }); return true;
    }
    try {
      const result = markAll
        ? await pool.query(
            `UPDATE public.fp_customer_notifications
                SET read_at = COALESCE(read_at, NOW())
              WHERE user_id = $1 AND read_at IS NULL`,
            [userId]
          )
        : await pool.query(
            `UPDATE public.fp_customer_notifications
                SET read_at = COALESCE(read_at, NOW())
              WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL`,
            [userId, ids]
          );
      send(res, 200, { markedRead: result.rowCount ?? 0 });
    } catch (error) {
      console.error("FlowPay customer notifications update failed:", error instanceof Error ? error.message : "database error");
      send(res, 503, { error: "CUSTOMER_NOTIFICATIONS_UPDATE_UNAVAILABLE" });
    }
    return true;
  };
}
