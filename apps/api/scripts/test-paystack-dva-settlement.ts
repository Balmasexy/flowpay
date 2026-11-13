import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import { test } from "node:test";
import { settleVerifiedPaystackDvaCharge } from "../src/paystack-dva-settlement.js";

const userId = "00000000-0000-4000-8000-000000000001";
const walletId = "00000000-0000-4000-8000-000000000002";
const clearingId = "00000000-0000-4000-8000-000000000003";
const transactionId = "00000000-0000-4000-8000-000000000004";
const reference = "flowpay-ps-00000000000000000000000000000001";
const accountNumber = "9930000902";
const customerCode = "CUS_live123";
const amount = "750000";

function verified(overrides: Record<string, unknown> = {}) {
  return {
    id: 987654321,
    domain: "live",
    status: "success",
    reference,
    amount: Number(amount),
    currency: "NGN",
    channel: "dedicated_nuban",
    authorization: {
      channel: "dedicated_nuban",
      receiver_bank_account_number: accountNumber,
      receiver_bank: "Wema Bank",
      sender_name: "Test Sender"
    },
    customer: { customer_code: customerCode },
    ...overrides
  };
}

function setup(options: { assigned?: boolean; savedCustomerCode?: string | null } = {}) {
  const statements: { sql: string; values?: unknown[] }[] = [];
  const ledgerValues: unknown[][] = [];
  const eventValues: unknown[][] = [];
  let depositCreated = false;
  let ledgerStatus = "pending";
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes("FROM public.fp_paystack_dedicated_accounts_v2")) {
        return options.assigned === false
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{
              user_id: userId,
              paystack_customer_code: options.savedCustomerCode === undefined ? customerCode : options.savedCustomerCode,
              account_number: accountNumber,
              status: "assigned"
            }] };
      }
      if (sql.includes("FROM public.fp_accounts") && sql.includes("WHERE user_id = $1")) {
        return { rowCount: 1, rows: [{ id: walletId }] };
      }
      if (sql.includes("FROM public.fp_paystack_deposits") && sql.includes("FOR UPDATE")) {
        return depositCreated
          ? { rowCount: 1, rows: [{
              transaction_id: transactionId, user_id: userId, account_id: walletId,
              reference, provider_transaction_id: "987654321",
              amount_minor: amount, currency: "NGN", status: "pending"
            }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes("INSERT INTO public.fp_ledger_transactions")) {
        return { rowCount: 1, rows: [{ id: transactionId }] };
      }
      if (sql.includes("INSERT INTO public.fp_paystack_deposits")) {
        depositCreated = true;
        return { rowCount: 1, rows: [{
          transaction_id: transactionId, user_id: userId, account_id: walletId,
          reference, provider_transaction_id: "987654321",
          amount_minor: amount, currency: "NGN", status: "pending"
        }] };
      }
      if (sql.includes("SELECT status FROM public.fp_ledger_transactions")) {
        return { rowCount: 1, rows: [{ status: ledgerStatus }] };
      }
      if (sql.includes("system_account_role = 'paystack_ngn_clearing'")) {
        return { rowCount: 1, rows: [{ id: clearingId }] };
      }
      if (sql.includes("SELECT COUNT(*)::int AS entry_count")) {
        return { rowCount: 1, rows: [{ entry_count: 0 }] };
      }
      if (sql.includes("INSERT INTO public.fp_payment_events")) {
        eventValues.push(values ?? []);
        return { rowCount: 1, rows: [{ provider_event_id: reference }] };
      }
      if (sql.includes("INSERT INTO public.fp_ledger_entries")) {
        ledgerValues.push(values ?? []);
        return { rowCount: 2, rows: [] };
      }
      if (sql.includes("UPDATE public.fp_ledger_transactions") && sql.includes("status = 'posted'")) {
        ledgerStatus = "posted";
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE public.fp_paystack_deposits") && sql.includes("status = 'posted'")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE public.fp_payment_events")) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error("Unexpected database query: " + sql);
    },
    release: () => undefined
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, statements, ledgerValues, eventValues };
}

test("credits a verified Paystack dedicated NUBAN transfer to its assigned customer wallet", async () => {
  const context = setup();
  const result = await settleVerifiedPaystackDvaCharge(
    context.pool, "live", verified(), "a".repeat(64)
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.walletCredited, true);
  assert.equal(result.body.channel, "dedicated_nuban");
  assert.equal(context.ledgerValues.length, 1);
  assert.deepEqual(context.ledgerValues[0], [
    transactionId, walletId, amount, clearingId, "-750000"
  ]);
  assert.equal(context.eventValues.length, 1);
  assert.ok(context.statements.some(item => item.sql.includes("status = 'posted'")));
});

test("recognizes dedicated_nuban when Paystack places the channel under authorization", async () => {
  const context = setup();
  const charge = verified({ channel: undefined });
  const result = await settleVerifiedPaystackDvaCharge(
    context.pool, "live", charge, "e".repeat(64)
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.walletCredited, true);
  assert.equal(context.ledgerValues.length, 1);
});

test("does not credit a DVA charge when the verified Paystack customer code does not match", async () => {
  const context = setup();
  const result = await settleVerifiedPaystackDvaCharge(
    context.pool, "live", verified({ customer: { customer_code: "CUS_someone_else" } }), "b".repeat(64)
  );
  assert.equal(result.status, 202);
  assert.equal(result.body.reason, "DEDICATED_ACCOUNT_CUSTOMER_MISMATCH");
  assert.equal(context.ledgerValues.length, 0);
});

test("does not credit a charge to an account that is not currently assigned in FlowPay", async () => {
  const context = setup({ assigned: false });
  const result = await settleVerifiedPaystackDvaCharge(
    context.pool, "live", verified(), "c".repeat(64)
  );
  assert.equal(result.status, 202);
  assert.equal(result.body.reason, "ASSIGNED_DEDICATED_ACCOUNT_NOT_FOUND");
  assert.equal(context.ledgerValues.length, 0);
});

test("ignores non-dedicated transfer channels and malformed provider data", async () => {
  const context = setup();
  const result = await settleVerifiedPaystackDvaCharge(
    context.pool, "live", verified({ channel: "card" }), "d".repeat(64)
  );
  assert.equal(result.status, 202);
  assert.equal(result.body.reason, "INVALID_DEDICATED_ACCOUNT_CHARGE");
  assert.equal(context.ledgerValues.length, 0);
});
