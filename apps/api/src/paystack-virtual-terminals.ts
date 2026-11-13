import { jwtVerify, type JWTVerifyGetKey } from "jose";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { getPaystackRuntime } from "./paystack-mode.js";

type Options = {
  pool: Pool | null;
  jwks: JWTVerifyGetKey | null;
  issuer?: string;
  audience?: string;
};

type JsonRecord = Record<string, unknown>;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<JsonRecord | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 16_384) return null;
    chunks.push(bytes);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonRecord : null;
  } catch {
    return null;
  }
}

function normalizeDestinations(value: unknown): Array<{ target: string; name?: string }> | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) return null;
  const output: Array<{ target: string; name?: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as JsonRecord;
    const target = typeof row.target === "string" ? row.target.replace(/[\\s()-]/g, "") : "";
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!/^\\+?[1-9]\\d{7,14}$/.test(target) || (name && (name.length > 60 || /[<>]/.test(name)))) return null;
    output.push({ target, ...(name ? { name } : {}) });
  }
  if (new Set(output.map(item => item.target)).size !== output.length) return null;
  return output;
}

function validTerminalCode(value: string): boolean {
  return /^VT_[A-Z0-9]{6,20}$/.test(value);
}

async function authorize(req: IncomingMessage, options: Options): Promise<"ok" | "unauthorized" | "unavailable"> {
  const { pool, jwks, issuer, audience } = options;
  if (!pool || !jwks || !issuer || !audience) return "unavailable";
  const match = req.headers.authorization?.match(/^Bearer\\s+(.+)$/i);
  if (!match) return "unauthorized";
  try {
    const { payload } = await jwtVerify(match[1], jwks, { algorithms: ["EdDSA"], issuer, audience });
    if (typeof payload.sub !== "string" || !payload.sub) return "unauthorized";
    const result = await pool.query(
      `SELECT 1
         FROM neon_auth."user" AS auth_user
         JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
        WHERE auth_user.id::text = $1
          AND auth_user."emailVerified" = true
          AND app_user.status = 'active'
          AND app_user.role = 'super_admin'
        LIMIT 1`,
      [payload.sub]
    );
    return result.rowCount === 1 ? "ok" : "unauthorized";
  } catch (error) {
    if (error instanceof Error && ["JWTExpired", "JWSSignatureVerificationFailed", "JWTClaimValidationFailed", "JWSInvalid", "JWTInvalid"].includes(error.name)) return "unauthorized";
    console.error("FlowPay Virtual Terminal admin authorization failed:", error instanceof Error ? error.message : "unknown error");
    return "unavailable";
  }
}

async function providerRequest(secret: string, path: string, method: "GET" | "POST" | "PUT", payload?: JsonRecord) {
  const response = await fetch("https://api.paystack.co" + path, {
    method,
    headers: {
      Authorization: "Bearer " + secret,
      Accept: "application/json",
      ...(payload ? { "Content-Type": "application/json" } : {})
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(12_000)
  });
  const body: unknown = await response.json().catch(() => null);
  const root = body && typeof body === "object" && !Array.isArray(body) ? body as JsonRecord : {};
  return { response, root };
}

export function createPaystackVirtualTerminalsHandler(options: Options) {
  return async function handlePaystackVirtualTerminals(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\\/+$/, "") || "/";
    if (!pathname.startsWith("/admin/paystack/virtual-terminals")) return false;
    if (!["GET", "POST", "PUT"].includes(req.method ?? "")) {
      send(res, 405, { error: "METHOD_NOT_ALLOWED" });
      return true;
    }

    const auth = await authorize(req, options);
    if (auth !== "ok") {
      send(res, auth === "unauthorized" ? 403 : 503, { error: auth === "unauthorized" ? "SUPER_ADMIN_ACCESS_REQUIRED" : "ADMIN_AUTH_UNAVAILABLE" });
      return true;
    }

    const runtime = getPaystackRuntime();
    if (!runtime) {
      send(res, 503, { error: "PAYSTACK_CONFIGURATION_REQUIRED", message: "Paystack live/test mode is not safely enabled on this backend." });
      return true;
    }

    const prefix = "/admin/paystack/virtual-terminals";
    const suffix = pathname.slice(prefix.length).replace(/^\\/+/, "");
    try {
      if (!suffix && req.method === "GET") {
        const url = new URL(req.url ?? "/", "http://localhost");
        const params = new URLSearchParams();
        const status = url.searchParams.get("status");
        const perPage = url.searchParams.get("perPage");
        const search = url.searchParams.get("search");
        const next = url.searchParams.get("next");
        if (status === "active" || status === "inactive") params.set("status", status);
        if (perPage && /^\\d{1,2}$/.test(perPage) && Number(perPage) >= 1 && Number(perPage) <= 50) params.set("perPage", perPage);
        if (search && search.length <= 60) params.set("search", search);
        if (next && next.length <= 300) params.set("next", next);
        const result = await providerRequest(runtime.secretKey, "/virtual_terminal" + (params.size ? "?" + params.toString() : ""), "GET");
        if (!result.response.ok || result.root.status !== true) {
          send(res, 502, { error: "PAYSTACK_TERMINAL_LIST_FAILED" });
          return true;
        }
        send(res, 200, { environment: runtime.environment, data: result.root.data ?? [], meta: result.root.meta ?? null });
        return true;
      }

      if (!suffix && req.method === "POST") {
        const body = await readJson(req);
        if (!body) { send(res, 400, { error: "INVALID_JSON_OR_PAYLOAD_TOO_LARGE" }); return true; }
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const destinations = normalizeDestinations(body.destinations);
        if (name.length < 2 || name.length > 80 || /[<>]/.test(name) || !destinations) {
          send(res, 400, { error: "INVALID_TERMINAL_INPUT", message: "Provide a 2–80 character terminal name and 1–5 valid WhatsApp phone destinations in international format." });
          return true;
        }
        const result = await providerRequest(runtime.secretKey, "/virtual_terminal", "POST", { name, destinations, currency: "NGN" });
        if (!result.response.ok || result.root.status !== true) {
          send(res, 502, { error: "PAYSTACK_TERMINAL_CREATE_FAILED", message: "Paystack could not create this terminal. Check your Virtual Terminal access and integration currency." });
          return true;
        }
        send(res, 201, { environment: runtime.environment, data: result.root.data ?? null });
        return true;
      }

      if (!validTerminalCode(suffix.split("/")[0] ?? "")) {
        send(res, 400, { error: "INVALID_TERMINAL_CODE" });
        return true;
      }
      const code = suffix.split("/")[0];
      const action = suffix.split("/").slice(1).join("/");
      if (!action && req.method === "GET") {
        const result = await providerRequest(runtime.secretKey, "/virtual_terminal/" + encodeURIComponent(code), "GET");
        if (!result.response.ok || result.root.status !== true) { send(res, 404, { error: "PAYSTACK_TERMINAL_NOT_FOUND" }); return true; }
        send(res, 200, { environment: runtime.environment, data: result.root.data ?? null });
        return true;
      }
      if (!action && req.method === "PUT") {
        const body = await readJson(req);
        const name = typeof body?.name === "string" ? body.name.trim() : "";
        if (name.length < 2 || name.length > 80 || /[<>]/.test(name)) { send(res, 400, { error: "INVALID_TERMINAL_NAME" }); return true; }
        const result = await providerRequest(runtime.secretKey, "/virtual_terminal/" + encodeURIComponent(code), "PUT", { name });
        if (!result.response.ok || result.root.status !== true) { send(res, 502, { error: "PAYSTACK_TERMINAL_UPDATE_FAILED" }); return true; }
        send(res, 200, { environment: runtime.environment, data: result.root.data ?? null });
        return true;
      }
      if (action === "deactivate" && req.method === "PUT") {
        const result = await providerRequest(runtime.secretKey, "/virtual_terminal/" + encodeURIComponent(code) + "/deactivate", "PUT");
        if (!result.response.ok || result.root.status !== true) { send(res, 502, { error: "PAYSTACK_TERMINAL_DEACTIVATE_FAILED" }); return true; }
        send(res, 200, { environment: runtime.environment, data: result.root.data ?? null, message: "Paystack confirmed terminal deactivation." });
        return true;
      }
      send(res, 405, { error: "METHOD_NOT_ALLOWED" });
      return true;
    } catch (error) {
      console.error("FlowPay Paystack Virtual Terminal request failed:", error instanceof Error ? error.message : "provider/network error");
      send(res, 503, { error: "PAYSTACK_TERMINAL_SERVICE_UNAVAILABLE" });
      return true;
    }
  };
}
