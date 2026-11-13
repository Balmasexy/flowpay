import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getPaystackBankRuntime } from "./paystack-mode.js";

type Options = {
  pool: Pool | null;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
  issuer?: string;
  audience?: string;
};
type Deposit = {
  transaction_id: string;
  user_id: string;
  account_id: string;
  reference: string;
  amount_minor: string;
  currency: string;
  status: "pending" | "posted" | "failed";
  provider_transaction_id: string | null;
  created_at: Date;
  verified_at: Date | null;
};
type VerifiedTransaction = {
  id: string;
  domain: string;
  status: string;
  reference: string;
  amount: string;
  currency: string;
};
type LedgerGroup = { account_id: string; amount_minor: string; entry_count: number };

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function isJwtError(error: unknown) {
  return error instanceof Error && [
    "JWTExpired", "JWSSignatureVerificationFailed", "JWTClaimValidationFailed", "JWSInvalid", "JWTInvalid"
  ].includes(error.name);
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function safeProviderId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^\d{1,30}$/.test(value)) return value;
  return null;
}
function safeAmount(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const raw = String(value);
  if (!/^\d{1,15}$/.test(raw) || !Number.isSafeInteger(Number(raw)) || BigInt(raw) <= 0n) return null;
  return raw;
}
function isBalancedLedger(
  rows: LedgerGroup[],
  customerAccountId: string,
  clearingAccountId: string,
  amount: string
): boolean {
  if (rows.length !== 2) return false;
  const customer = rows.find(row => row.account_id === customerAccountId);
  const clearing = rows.find(row => row.account_id === clearingAccountId);
  return Boolean(
    customer && clearing &&
    customer.entry_count === 1 && clearing.entry_count === 1 &&
    customer.amount_minor === amount &&
    clearing.amount_minor === (-BigInt(amount)).toString()
  );
}

async function settleVerifiedDeposit(
  pool: Pool,
  deposit: Deposit,
  verified: VerifiedTransaction
): Promise<void> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<Deposit>(
      `SELECT transaction_id, user_id, account_id, reference,
              amount_minor::text AS amount_minor, currency, status,
              provider_transaction_id, created_at, verified_at
         FROM public.fp_paystack_deposits
        WHERE transaction_id = $1 AND user_id = $2 AND reference = $3
        FOR UPDATE`,
      [deposit.transaction_id, deposit.user_id, deposit.reference]
    );
    if (locked.rowCount !== 1) throw new Error("PAYSTACK_DEPOSIT_NOT_FOUND");
    const saved = locked.rows[0];
    if (saved.amount_minor !== verified.amount || saved.currency.trim() !== "NGN" ||
        (saved.provider_transaction_id && saved.provider_transaction_id !== verified.id)) {
      throw new Error("PAYSTACK_DEPOSIT_VERIFICATION_MISMATCH");
    }
    const transaction = await client.query<{ status: string }>(
      "SELECT status FROM public.fp_ledger_transactions WHERE id = $1 FOR UPDATE",
      [saved.transaction_id]
    );
    if (transaction.rowCount !== 1) throw new Error("FLOWPAY_LEDGER_TRANSACTION_NOT_FOUND");
    const customerAccount = await client.query<{ id: string }>(
      `SELECT id FROM public.fp_accounts
        WHERE id = $1 AND user_id = $2 AND account_type = 'customer'
          AND currency = 'NGN' AND status = 'active'
        FOR UPDATE`,
      [saved.account_id, saved.user_id]
    );
    if (customerAccount.rowCount !== 1) throw new Error("CUSTOMER_WALLET_NOT_ACTIVE");
    const clearing = await client.query<{ id: string }>(
      `SELECT id FROM public.fp_accounts
        WHERE account_type = 'system' AND currency = 'NGN'
          AND system_account_role = 'paystack_ngn_clearing' AND status = 'active'
        FOR UPDATE`
    );
    if (clearing.rowCount !== 1) throw new Error("PAYSTACK_CLEARING_ACCOUNT_NOT_CONFIGURED");
    const clearingId = clearing.rows[0].id;

    if (transaction.rows[0].status === "posted") {
      const ledger = await client.query<LedgerGroup>(
        `SELECT account_id::text AS account_id, SUM(amount_minor)::text AS amount_minor,
                COUNT(*)::int AS entry_count
           FROM public.fp_ledger_entries
          WHERE transaction_id = $1
          GROUP BY account_id`,
        [saved.transaction_id]
      );
      if (!isBalancedLedger(ledger.rows, saved.account_id, clearingId, verified.amount)) {
        throw new Error("POSTED_LEDGER_REQUIRES_RECONCILIATION");
      }
    } else {
      if (transaction.rows[0].status !== "pending" || saved.status !== "pending") {
        throw new Error("PAYSTACK_DEPOSIT_STATE_REQUIRES_RECONCILIATION");
      }
      const existing = await client.query<{ entry_count: number }>(
        "SELECT COUNT(*)::int AS entry_count FROM public.fp_ledger_entries WHERE transaction_id = $1",
        [saved.transaction_id]
      );
      if (Number(existing.rows[0]?.entry_count ?? 0) !== 0) {
        throw new Error("PENDING_LEDGER_ENTRIES_REQUIRE_RECONCILIATION");
      }
      await client.query(
        `INSERT INTO public.fp_ledger_entries (transaction_id, account_id, amount_minor, currency)
         VALUES ($1, $2, $3, 'NGN'), ($1, $4, $5, 'NGN')`,
        [saved.transaction_id, saved.account_id, verified.amount, clearingId, (-BigInt(verified.amount)).toString()]
      );
      const posted = await client.query(
        `UPDATE public.fp_ledger_transactions
            SET status = 'posted', posted_at = NOW()
          WHERE id = $1 AND status = 'pending'`,
        [saved.transaction_id]
      );
      if (posted.rowCount !== 1) throw new Error("PAYSTACK_DEPOSIT_LEDGER_POST_FAILED");
    }
    await client.query(
      `UPDATE public.fp_paystack_deposits
          SET status = 'posted', provider_transaction_id = $2,
              verified_at = COALESCE(verified_at, NOW())
        WHERE transaction_id = $1`,
      [saved.transaction_id, verified.id]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function markVerifiedFailure(pool: Pool, deposit: Deposit, providerStatus: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ transaction_id: string; status: string }>(
      `SELECT transaction_id, status FROM public.fp_paystack_deposits
        WHERE transaction_id = $1 AND user_id = $2 AND reference = $3
        FOR UPDATE`,
      [deposit.transaction_id, deposit.user_id, deposit.reference]
    );
    if (locked.rowCount !== 1) throw new Error("PAYSTACK_DEPOSIT_NOT_FOUND");
    const transaction = await client.query<{ status: string }>(
      "SELECT status FROM public.fp_ledger_transactions WHERE id = $1 FOR UPDATE",
      [deposit.transaction_id]
    );
    if (transaction.rowCount !== 1) throw new Error("FLOWPAY_LEDGER_TRANSACTION_NOT_FOUND");
    if (transaction.rows[0].status === "posted" || locked.rows[0].status === "posted") {
      // A provider reversal/refund after posting needs a separately balanced
      // refund workflow; never relabel a credited deposit as a simple failure.
      await client.query("COMMIT");
      return;
    }
    if (transaction.rows[0].status !== "pending" || locked.rows[0].status !== "pending") {
      await client.query("COMMIT");
      return;
    }
    const entries = await client.query<{ entry_count: number }>(
      "SELECT COUNT(*)::int AS entry_count FROM public.fp_ledger_entries WHERE transaction_id = $1",
      [deposit.transaction_id]
    );
    if (Number(entries.rows[0]?.entry_count ?? 0) !== 0) {
      throw new Error("FAILED_DEPOSIT_HAS_LEDGER_ENTRIES");
    }
    await client.query(
      "UPDATE public.fp_ledger_transactions SET status = 'failed' WHERE id = $1 AND status = 'pending'",
      [deposit.transaction_id]
    );
    await client.query(
      "UPDATE public.fp_paystack_deposits SET status = 'failed' WHERE transaction_id = $1 AND status = 'pending'",
      [deposit.transaction_id]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function loadDeposit(pool: Pool, userId: string, reference: string): Promise<Deposit | null> {
  const result = await pool.query<Deposit>(
    `SELECT transaction_id, user_id, account_id, reference,
            amount_minor::text AS amount_minor, currency, status,
            provider_transaction_id, created_at, verified_at
       FROM public.fp_paystack_deposits
      WHERE user_id = $1 AND reference = $2
      LIMIT 1`,
    [userId, reference]
  );
  return result.rowCount === 1 ? result.rows[0] : null;
}

export function createPaystackDepositStatusHandler(options: Options) {
  const { pool, jwks, issuer, audience } = options;
  return async function handlePaystackDepositStatus(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" || url.pathname.replace(/\/+$/, "") !== "/customer/paystack/deposits/status") return false;
    if (!pool || !jwks || !issuer || !audience) {
      send(res, 503, { error: "PAYSTACK_STATUS_SERVICE_NOT_CONFIGURED" });
      return true;
    }
    const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if (!bearer) {
      send(res, 401, { error: "AUTHENTICATION_REQUIRED" });
      return true;
    }
    const reference = url.searchParams.get("reference")?.trim() ?? "";
    if (!/^flowpay-ps-[0-9a-f]{32}$/i.test(reference)) {
      send(res, 400, { error: "INVALID_PAYSTACK_REFERENCE" });
      return true;
    }

    try {
      const { payload } = await jwtVerify(bearer[1], jwks, { algorithms: ["EdDSA"], issuer, audience });
      if (typeof payload.sub !== "string" || !payload.sub) {
        send(res, 401, { error: "INVALID_SESSION" });
        return true;
      }
      const identity = await pool.query<{ id: string }>(
        `SELECT app_user.id
           FROM neon_auth."user" AS auth_user
           JOIN public.fp_users AS app_user ON app_user.auth_subject = auth_user.id::text
          WHERE auth_user.id::text = $1
            AND auth_user."emailVerified" = true
            AND app_user.status = 'active'
            AND app_user.role = 'customer'
          LIMIT 1`,
        [payload.sub]
      );
      if (identity.rowCount !== 1) {
        send(res, 403, { error: "ACTIVE_CUSTOMER_ACCOUNT_REQUIRED" });
        return true;
      }

      const userId = identity.rows[0].id;
      let deposit = await loadDeposit(pool, userId, reference);
      if (!deposit) {
        send(res, 404, { error: "PAYSTACK_DEPOSIT_NOT_FOUND" });
        return true;
      }

      // Status recovery uses the configured API key but not the new-deposit
      // switch: closing checkout must not strand or hide a pending payment.
      const runtime = getPaystackBankRuntime();
      let verification = "not_attempted";
      if (deposit.status === "pending" && runtime) {
        verification = "pending";
        try {
          const response = await fetch(
            "https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference),
            {
              headers: { Authorization: "Bearer " + runtime.secretKey, Accept: "application/json" },
              signal: AbortSignal.timeout(12_000)
            }
          );
          const root = record(await response.json().catch(() => null));
          const data = record(root.data);
          const amount = safeAmount(data.amount);
          const providerId = safeProviderId(data.id);
          const providerStatus = typeof data.status === "string" ? data.status.toLowerCase() : "";
          const exactMatch = response.ok && root.status === true &&
            data.domain === runtime.environment &&
            data.reference === reference &&
            amount === deposit.amount_minor &&
            data.currency === "NGN" &&
            (!deposit.provider_transaction_id || deposit.provider_transaction_id === providerId);

          if (exactMatch && providerStatus === "success" && providerId) {
            await settleVerifiedDeposit(pool, deposit, {
              id: providerId,
              domain: String(data.domain),
              status: providerStatus,
              reference: String(data.reference),
              amount: String(amount),
              currency: String(data.currency)
            });
            verification = "provider_verified";
          } else if (exactMatch && ["failed", "abandoned"].includes(providerStatus)) {
            await markVerifiedFailure(pool, deposit, providerStatus);
            verification = "provider_confirmed_failure";
          }
        } catch (error) {
          // A temporary provider/database error must not be misreported as a
          // failed payment. Keep the persisted status and allow webhook retries.
          console.error("FlowPay Paystack deposit recovery check failed:", error instanceof Error ? error.message : "verification unavailable");
          verification = "temporarily_unavailable";
        }
        deposit = await loadDeposit(pool, userId, reference) ?? deposit;
      }

      send(res, 200, {
        deposit: {
          transactionId: deposit.transaction_id,
          reference: deposit.reference,
          amountMinor: deposit.amount_minor,
          currency: String(deposit.currency).trim(),
          status: deposit.status,
          createdAt: deposit.created_at,
          verifiedAt: deposit.verified_at
        },
        environment: runtime?.environment ?? null,
        walletCredited: deposit.status === "posted",
        verification
      });
      return true;
    } catch (error) {
      if (isJwtError(error)) {
        send(res, 401, { error: "INVALID_SESSION" });
        return true;
      }
      console.error("FlowPay Paystack deposit status request failed:", error instanceof Error ? error.message : "unknown error");
      send(res, 503, { error: "PAYSTACK_STATUS_UNAVAILABLE" });
      return true;
    }
  };
}
