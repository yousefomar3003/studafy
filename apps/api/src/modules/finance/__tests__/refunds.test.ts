// Refund initiation, maker-checker enforcement, idempotency, and webhook processing (ST-124).
//
// Split in two on purpose:
//
//   * The unit suites need no database and always run. They cover the parts that carry the money
//     risk and are pure: the idempotency request hash, the ERPNext document shape, and the
//     credit-note payload construction.
//   * The integration suite covers the acceptance criteria that cannot be faked honestly — maker
//     and checker must be different users, duplicate Idempotency-Key must produce exactly one
//     refund request, and webhook confirmation must transition the status. It needs a real
//     PostgreSQL with the migrations applied and is gated on TEST_DATABASE_URL.

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import {
  assignRole,
  createTestDatabase,
  createSchool,
  createStudent,
  createUser,
  integrationEnabled,
  migrateDatabase,
  type TestDatabase,
} from "../../../../tests/harness";
import { CodedHttpException } from "../../../coded-http-exception";
import { ErpNextError } from "../../../erpnext/client";
import {
  approveRefund,
  applyRefundCompleted,
  buildCreditNoteEntry,
  refundSettlementOf,
  getRefund,
  hashRefundRequest,
  initiateRefund,
  listRefunds,
  reconcileStaleRefundClaims,
  refundTag,
  rejectRefund,
  type InitiateRefundParams,
  type RefundLog,
} from "../refunds/service";

import type { TxRunner } from "../../../db/tenant-tx";
import type { TenantErpNext, TenantErpNextFactory } from "../client/tenant-client";
import type { TransactionSql } from "postgres";

const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const STUDENT_ID = "22222222-2222-4222-8222-222222222222";

function makeParams(overrides: Partial<InitiateRefundParams> = {}): InitiateRefundParams {
  return {
    student_id: STUDENT_ID,
    erpnext_invoice_id: "ACC-SINV-2026-00042",
    amount: 12.345,
    currency: "JOD",
    reason_code: "overpayment",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Idempotency request hash
// ---------------------------------------------------------------------------

describe("idempotency request hash", () => {
  test("is a lowercase hex sha256, matching the column's CHECK constraint", () => {
    expect(hashRefundRequest(makeParams())).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is stable across property order, so a reserialized retry is still a retry", () => {
    const a: InitiateRefundParams = {
      student_id: STUDENT_ID,
      erpnext_invoice_id: "ACC-SINV-1",
      amount: 100,
      currency: "JOD",
      reason_code: "overpayment",
    };
    const b: InitiateRefundParams = {
      currency: "JOD",
      amount: 100,
      erpnext_invoice_id: "ACC-SINV-1",
      student_id: STUDENT_ID,
      reason_code: "overpayment",
    };
    expect(hashRefundRequest(a)).toBe(hashRefundRequest(b));
  });

  test("changes when the amount changes", () => {
    expect(hashRefundRequest(makeParams({ amount: 100 }))).not.toBe(
      hashRefundRequest(makeParams({ amount: 100.001 })),
    );
  });

  test("changes when the target invoice changes", () => {
    expect(hashRefundRequest(makeParams({ erpnext_invoice_id: "ACC-SINV-A" }))).not.toBe(
      hashRefundRequest(makeParams({ erpnext_invoice_id: "ACC-SINV-B" })),
    );
  });

  test("changes when the reason code changes", () => {
    expect(hashRefundRequest(makeParams({ reason_code: "overpayment" }))).not.toBe(
      hashRefundRequest(makeParams({ reason_code: "withdrawal" })),
    );
  });
});

// ---------------------------------------------------------------------------
// ERPNext Credit Note document shape
// ---------------------------------------------------------------------------

describe("Credit Note journal entry", () => {
  const refund = {
    id: "33333333-3333-4333-8333-333333333333",
    erpnext_invoice_id: "ACC-SINV-2026-00042",
    amount_minor: 100_000, // 100.000 JOD
    currency_minor_unit: 3,
    reason_code: "overpayment" as const,
    reason_notes: null as string | null,
  };
  interface Line {
    account: string;
    party_type?: string;
    debit_in_account_currency?: number;
    credit_in_account_currency?: number;
    reference_type?: string;
    reference_name?: string;
    party?: string;
  }
  const entry = (invoice = REFUNDABLE_INVOICE, r = refund) =>
    buildCreditNoteEntry(invoice, r, "2026-11-28") as { accounts: Line[] } & Record<
      string,
      unknown
    >;

  test("is a submitted Credit Note journal entry, tagged with the refund", () => {
    const body = entry();
    expect(body).toMatchObject({
      doctype: "Journal Entry",
      voucher_type: "Credit Note",
      company: "Test School",
      posting_date: "2026-11-28",
      docstatus: 1,
    });
    expect(String(body.user_remark)).toContain(refundTag(refund.id));
  });

  test("credits the family the refund, applied to the invoice while it owes at least that", () => {
    const credit = entry().accounts.at(-1)!;
    expect(credit).toEqual({
      account: "Debtors - TS",
      party_type: "Customer",
      party: "STU-0001",
      credit_in_account_currency: 100,
      reference_type: "Sales Invoice",
      reference_name: "ACC-SINV-2026-00042",
    });
  });

  const CASH = { account: "Cash - TS", modeOfPayment: "Cash" };
  const lines = (body: { accounts: Line[] }) =>
    body.accounts
      .slice(3) // after the three income/VAT debits
      .map((l) => [
        l.account,
        l.debit_in_account_currency ? "Dr" : "Cr",
        l.debit_in_account_currency ?? l.credit_in_account_currency,
        l.reference_name ?? null,
      ]);

  test("a paid invoice refunded in cash: credit and payout in the one entry, nothing left open", () => {
    const body = buildCreditNoteEntry(
      { ...REFUNDABLE_INVOICE, outstanding_amount: 0 },
      { ...refund, payout_mode: "cash" },
      "2026-11-28",
      CASH,
    ) as { accounts: Line[] } & Record<string, unknown>;
    expect(body.mode_of_payment).toBe("Cash");
    expect(lines(body)).toEqual([
      ["Debtors - TS", "Cr", 100, null],
      ["Debtors - TS", "Dr", 100, null],
      ["Cash - TS", "Cr", 100, null],
    ]);
  });

  test("an invoice owing part of the refund: that part credited to it, the rest paid out", () => {
    const body = buildCreditNoteEntry(
      { ...REFUNDABLE_INVOICE, outstanding_amount: 40 },
      { ...refund, payout_mode: "cash" },
      "2026-11-28",
      CASH,
    ) as { accounts: Line[] } & Record<string, unknown>;
    expect(lines(body)).toEqual([
      ["Debtors - TS", "Cr", 40, "ACC-SINV-2026-00042"],
      ["Debtors - TS", "Cr", 60, null],
      ["Debtors - TS", "Dr", 60, null],
      ["Cash - TS", "Cr", 60, null],
    ]);
  });

  test("kept as credit: the rest stays on the family's account, no cash moves", () => {
    const body = entry({ ...REFUNDABLE_INVOICE, outstanding_amount: 0 }, {
      ...refund,
      payout_mode: "credit",
    } as typeof refund);
    expect(body).not.toHaveProperty("mode_of_payment");
    expect(lines(body)).toEqual([["Debtors - TS", "Cr", 100, null]]);
  });

  test("a payout with no account to pay it from is refused", () => {
    expect(() =>
      buildCreditNoteEntry({ ...REFUNDABLE_INVOICE, outstanding_amount: 0 }, refund, "2026-11-28"),
    ).toThrow(RangeError);
  });

  test("reverses income and VAT in the invoice's proportions", () => {
    const debits = entry().accounts.slice(0, -1);
    expect(debits.map((l) => [l.account, l.debit_in_account_currency])).toEqual([
      ["Tuition - TS", 70],
      ["Transport - TS", 25],
      ["VAT - TS", 5],
    ]);
  });

  test("the debits always sum to the refund exactly; the remainder goes to the largest line", () => {
    const odd = { ...refund, amount_minor: 33_333 }; // 33.333 JOD
    const debits = entry(REFUNDABLE_INVOICE, odd).accounts.slice(0, -1);
    const sum = debits.reduce(
      (total, l) => total + Math.round(l.debit_in_account_currency! * 1000),
      0,
    );
    expect(sum).toBe(33_333);
    expect(debits[0]!.debit_in_account_currency).toBe(23.334); // 23.333 + the 0.001 remainder
  });

  test("carries the reason in the remark", () => {
    const body = entry(REFUNDABLE_INVOICE, { ...refund, reason_notes: "Parent requested refund" });
    expect(body.user_remark).toBe(`${refundTag(refund.id)} (overpayment) Parent requested refund`);
  });

  test("refuses an invoice with no income or tax lines", () => {
    expect(() => entry({ ...REFUNDABLE_INVOICE, items: [], taxes: [] })).toThrow(RangeError);
  });
});

describe("refundSettlementOf", () => {
  test("what the invoice owes is credited first; the rest goes back by the payout mode", () => {
    expect(refundSettlementOf(1000n, 100n, "cash")).toEqual({
      settlement: "invoice",
      appliedMinor: 100n,
      restMinor: 0n,
    });
    expect(refundSettlementOf(40n, 100n, "cash")).toEqual({
      settlement: "paid_out",
      appliedMinor: 40n,
      restMinor: 60n,
    });
    expect(refundSettlementOf(0n, 100n, "bank_transfer").settlement).toBe("paid_out");
    expect(refundSettlementOf(0n, 100n, "credit")).toEqual({
      settlement: "family_credit",
      appliedMinor: 0n,
      restMinor: 100n,
    });
    // An invoice already credited past zero owes nothing.
    expect(refundSettlementOf(-5n, 100n, "cash").appliedMinor).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// Integration: full refund workflow
// ---------------------------------------------------------------------------

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
});

afterAll(async () => {
  if (db?.cleanup) await db.cleanup();
});

async function withTx<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx`
      SELECT set_config('role', 'studafy_app', true),
             set_config('app.school_id', ${schoolId}, true)
    `;
    result = await fn(tx);
  });
  return result as T;
}

// Makers and checkers are real FINANCE staff: every refund mutation writes an app.audit_logs row whose
// actor_id is the acting user, and fk_audit_logs_actor requires that user to exist in the school.
async function createFinanceUser(schoolId: string): Promise<string> {
  const user = await createUser(db.sql, schoolId);
  await assignRole(db.sql, schoolId, user.id, ROLES.FINANCE);
  return user.id;
}

/** The service's short transactions, run in the test's one transaction. */
function inTx(tx: TransactionSql): TxRunner {
  return (fn) => fn(tx);
}

/** The refunded invoice, as approval reads it before posting: 950 JOD of fees + 50 VAT. */
const REFUNDABLE_INVOICE = {
  name: "ACC-SINV-FIXTURE",
  docstatus: 1,
  is_return: 0,
  company: "Test School",
  customer: "STU-0001",
  currency: "JOD",
  conversion_rate: 1,
  debit_to: "Debtors - TS",
  grand_total: 1000,
  rounded_total: 1000,
  outstanding_amount: 1000,
  items: [
    { income_account: "Tuition - TS", cost_center: "Main - TS", net_amount: 700 },
    { income_account: "Transport - TS", cost_center: "Main - TS", net_amount: 250 },
  ],
  taxes: [
    { account_head: "VAT - TS", cost_center: "Main - TS", tax_amount_after_discount_amount: 50 },
  ],
};

/** Answers the approval's read of the invoice; null for any other GET. */
function invoiceRead(path: string): Promise<unknown> | null {
  if (/^\/api\/resource\/Sales%20Invoice\/[^?]+$/.test(path)) {
    return Promise.resolve({
      data: { data: REFUNDABLE_INVOICE },
      status: 200,
      headers: new Headers(),
    });
  }
  return null;
}

function mockErpNext(creditNoteName: string): TenantErpNext {
  return {
    get: (path: string) => invoiceRead(path) ?? Promise.reject(new Error("not implemented")),
    post: () =>
      Promise.resolve({
        data: { data: { name: creditNoteName } },
        status: 201,
        headers: new Headers(),
      }),
    put: () => Promise.reject(new Error("not implemented")),
  } as unknown as TenantErpNext;
}

// ---------------------------------------------------------------------------
// Initiate refund
// ---------------------------------------------------------------------------

describeDb("initiateRefund", () => {
  test("creates a pending refund request and returns it", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);

    const result = await initiateRefund(
      db.sql,
      {
        schoolId: school.id,
        userId: await createFinanceUser(school.id),
      },
      {
        student_id: student.id,
        erpnext_invoice_id: "ACC-SINV-00001",
        amount: 50,
        currency: "JOD",
        reason_code: "overpayment",
      },
      crypto.randomUUID(),
    );

    expect(result.replayed).toBe(false);
    expect(result.row.status).toBe("pending_approval");
    expect(result.row.school_id).toBe(school.id);
    expect(result.row.student_id).toBe(student.id);
    expect(result.row.currency).toBe("JOD");
    expect(result.row.amount).toBe("50.000");
  });

  test("replays the result for the same idempotency key and body", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);
    const key = crypto.randomUUID();

    const first = await initiateRefund(
      db.sql,
      {
        schoolId: school.id,
        userId: await createFinanceUser(school.id),
      },
      {
        student_id: student.id,
        erpnext_invoice_id: "ACC-SINV-00002",
        amount: 100,
        currency: "JOD",
        reason_code: "withdrawal",
      },
      key,
    );

    const second = await initiateRefund(
      db.sql,
      {
        schoolId: school.id,
        userId: await createFinanceUser(school.id),
      },
      {
        student_id: student.id,
        erpnext_invoice_id: "ACC-SINV-00002",
        amount: 100,
        currency: "JOD",
        reason_code: "withdrawal",
      },
      key,
    );

    expect(second.replayed).toBe(true);
    expect(second.row.id).toBe(first.row.id);
  });

  test("refuses idempotency key collision with a different body", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);
    const key = crypto.randomUUID();

    await initiateRefund(
      db.sql,
      {
        schoolId: school.id,
        userId: await createFinanceUser(school.id),
      },
      {
        student_id: student.id,
        erpnext_invoice_id: "ACC-SINV-00003",
        amount: 100,
        currency: "JOD",
        reason_code: "overpayment",
      },
      key,
    );

    await expect(
      initiateRefund(
        db.sql,
        {
          schoolId: school.id,
          userId: await createFinanceUser(school.id),
        },
        {
          student_id: student.id,
          erpnext_invoice_id: "ACC-SINV-00003",
          amount: 200,
          currency: "JOD",
          reason_code: "overpayment",
        },
        key,
      ),
    ).rejects.toThrow(CodedHttpException);

    await expect(
      initiateRefund(
        db.sql,
        {
          schoolId: school.id,
          userId: await createFinanceUser(school.id),
        },
        {
          student_id: student.id,
          erpnext_invoice_id: "ACC-SINV-00003",
          amount: 200,
          currency: "JOD",
          reason_code: "overpayment",
        },
        key,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("refuses an unknown currency", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);

    await expect(
      initiateRefund(
        db.sql,
        {
          schoolId: school.id,
          userId: await createFinanceUser(school.id),
        },
        {
          student_id: student.id,
          erpnext_invoice_id: "ACC-SINV-00004",
          amount: 50,
          currency: "ZZZ",
          reason_code: "overpayment",
        },
        crypto.randomUUID(),
      ),
    ).rejects.toThrow(CodedHttpException);
  });
});

// ---------------------------------------------------------------------------
// List / Get refunds
// ---------------------------------------------------------------------------

describeDb("listRefunds / getRefund", () => {
  test("lists refunds scoped to the school", async () => {
    const schoolA = await createSchool(db.sql);
    const schoolB = await createSchool(db.sql);
    const studentA = await createStudent(db.sql, schoolA.id);
    const studentB = await createStudent(db.sql, schoolB.id);
    const userIdA = await createFinanceUser(schoolA.id);
    const userIdB = await createFinanceUser(schoolB.id);

    await initiateRefund(
      db.sql,
      { schoolId: schoolA.id, userId: userIdA },
      {
        student_id: studentA.id,
        erpnext_invoice_id: "ACC-SINV-L01",
        amount: 30,
        currency: "JOD",
        reason_code: "error_correction",
      },
      crypto.randomUUID(),
    );

    await initiateRefund(
      db.sql,
      { schoolId: schoolB.id, userId: userIdB },
      {
        student_id: studentB.id,
        erpnext_invoice_id: "ACC-SINV-L02",
        amount: 40,
        currency: "JOD",
        reason_code: "discount_adjustment",
      },
      crypto.randomUUID(),
    );

    const listA = await withTx(schoolA.id, (tx) =>
      listRefunds(tx, schoolA.id, { limit: 10, offset: 0 }),
    );
    expect(listA.total).toBe(1);
    expect(listA.rows[0].erpnext_invoice_id).toBe("ACC-SINV-L01");

    const listB = await withTx(schoolB.id, (tx) =>
      listRefunds(tx, schoolB.id, { limit: 10, offset: 0 }),
    );
    expect(listB.total).toBe(1);
    expect(listB.rows[0].erpnext_invoice_id).toBe("ACC-SINV-L02");
  });

  test("filters by status", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);
    const userId = await createFinanceUser(school.id);

    await initiateRefund(
      db.sql,
      { schoolId: school.id, userId },
      {
        student_id: student.id,
        erpnext_invoice_id: "ACC-SINV-F01",
        amount: 10,
        currency: "JOD",
        reason_code: "overpayment",
      },
      "filter-status-key-1",
    );

    await initiateRefund(
      db.sql,
      { schoolId: school.id, userId },
      {
        student_id: student.id,
        erpnext_invoice_id: "ACC-SINV-F02",
        amount: 20,
        currency: "JOD",
        reason_code: "withdrawal",
      },
      "filter-status-key-2",
    );

    const all = await withTx(school.id, (tx) =>
      listRefunds(tx, school.id, { limit: 10, offset: 0 }),
    );
    expect(all.total).toBe(2);

    const pending = await withTx(school.id, (tx) =>
      listRefunds(tx, school.id, { limit: 10, offset: 0, status: "pending_approval" }),
    );
    expect(pending.total).toBe(2);

    const completed = await withTx(school.id, (tx) =>
      listRefunds(tx, school.id, { limit: 10, offset: 0, status: "completed" }),
    );
    expect(completed.total).toBe(0);
  });

  test("retrieves a refund by id", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);

    const { row } = await initiateRefund(
      db.sql,
      {
        schoolId: school.id,
        userId: await createFinanceUser(school.id),
      },
      {
        student_id: student.id,
        erpnext_invoice_id: "ACC-SINV-G01",
        amount: 75,
        currency: "JOD",
        reason_code: "overpayment",
      },
      crypto.randomUUID(),
    );

    const fetched = await withTx(school.id, (tx) => getRefund(tx, school.id, row.id));
    expect(fetched.id).toBe(row.id);
  });

  test("throws 404 for a non-existent refund", async () => {
    const school = await createSchool(db.sql);

    await expect(
      withTx(school.id, (tx) => getRefund(tx, school.id, crypto.randomUUID())),
    ).rejects.toThrow(CodedHttpException);
  });

  test("does not cross schools when getting by id", async () => {
    const schoolA = await createSchool(db.sql);
    const schoolB = await createSchool(db.sql);
    const studentA = await createStudent(db.sql, schoolA.id);

    const { row } = await initiateRefund(
      db.sql,
      {
        schoolId: schoolA.id,
        userId: await createFinanceUser(schoolA.id),
      },
      {
        student_id: studentA.id,
        erpnext_invoice_id: "ACC-SINV-X01",
        amount: 15,
        currency: "JOD",
        reason_code: "overpayment",
      },
      crypto.randomUUID(),
    );

    await expect(withTx(schoolB.id, (tx) => getRefund(tx, schoolB.id, row.id))).rejects.toThrow(
      CodedHttpException,
    );
  });
});

// ---------------------------------------------------------------------------
// Reject refund
// ---------------------------------------------------------------------------

describeDb("rejectRefund", () => {
  test("rejects a pending refund", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);
    const makerId = await createFinanceUser(school.id);
    const checkerId = await createFinanceUser(school.id);

    const { row } = await initiateRefund(
      db.sql,
      {
        schoolId: school.id,
        userId: makerId,
      },
      {
        student_id: student.id,
        erpnext_invoice_id: "ACC-SINV-R01",
        amount: 50,
        currency: "JOD",
        reason_code: "overpayment",
      },
      crypto.randomUUID(),
    );

    const rejected = await withTx(school.id, (tx) =>
      rejectRefund(tx, school.id, checkerId, row.id, "Duplicate request"),
    );

    expect(rejected.status).toBe("rejected");
    expect(rejected.checker_id).toBe(checkerId);
  });

  test("refuses self-rejection (maker === checker)", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);
    const userId = await createFinanceUser(school.id);

    const { row } = await initiateRefund(
      db.sql,
      {
        schoolId: school.id,
        userId,
      },
      {
        student_id: student.id,
        erpnext_invoice_id: "ACC-SINV-R02",
        amount: 25,
        currency: "JOD",
        reason_code: "withdrawal",
      },
      crypto.randomUUID(),
    );

    await expect(
      withTx(school.id, (tx) => rejectRefund(tx, school.id, userId, row.id, "Changed my mind")),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("refuses to reject an already-rejected refund", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);
    const makerId = await createFinanceUser(school.id);
    const checkerId = await createFinanceUser(school.id);

    const { row } = await initiateRefund(
      db.sql,
      {
        schoolId: school.id,
        userId: makerId,
      },
      {
        student_id: student.id,
        erpnext_invoice_id: "ACC-SINV-R03",
        amount: 35,
        currency: "JOD",
        reason_code: "overpayment",
      },
      crypto.randomUUID(),
    );

    await withTx(school.id, (tx) =>
      rejectRefund(tx, school.id, checkerId, row.id, "First rejection"),
    );

    const secondCheckerId = await createFinanceUser(school.id);
    await expect(
      withTx(school.id, (tx) =>
        rejectRefund(tx, school.id, secondCheckerId, row.id, "Second rejection"),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("refuses to reject a non-existent refund", async () => {
    const school = await createSchool(db.sql);
    const checkerId = await createFinanceUser(school.id);

    await expect(
      withTx(school.id, (tx) =>
        rejectRefund(tx, school.id, checkerId, crypto.randomUUID(), "Nope"),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// Approve refund (with mock ERPNext)
// ---------------------------------------------------------------------------

describeDb("approveRefund", () => {
  test("approves a refund and completes it once its journal entry is submitted", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);
    const makerId = await createFinanceUser(school.id);
    const checkerId = await createFinanceUser(school.id);
    const creditNoteName = "ACC-CRN-2026-00001";

    const { row } = await initiateRefund(
      db.sql,
      {
        schoolId: school.id,
        userId: makerId,
      },
      {
        student_id: student.id,
        erpnext_invoice_id: "ACC-SINV-A01",
        amount: 100,
        currency: "JOD",
        reason_code: "overpayment",
      },
      crypto.randomUUID(),
    );

    const approved = await withTx(school.id, (tx) =>
      approveRefund(
        inTx(tx),
        async () => mockErpNext(creditNoteName),
        school.id,
        checkerId,
        row.id,
      ),
    );

    expect(approved.status).toBe("completed");
    expect(approved.checker_id).toBe(checkerId);
    expect(approved.erpnext_credit_note_id).toBe(creditNoteName);
    expect(approved.approved_at).not.toBeNull();
  });

  test("refuses self-approval (maker === checker)", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);
    const userId = await createFinanceUser(school.id);

    const { row } = await initiateRefund(
      db.sql,
      {
        schoolId: school.id,
        userId,
      },
      {
        student_id: student.id,
        erpnext_invoice_id: "ACC-SINV-A02",
        amount: 50,
        currency: "JOD",
        reason_code: "discount_adjustment",
      },
      crypto.randomUUID(),
    );

    await expect(
      withTx(school.id, (tx) =>
        approveRefund(inTx(tx), async () => mockErpNext("CN-1"), school.id, userId, row.id),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("refuses to approve a rejected refund", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);
    const makerId = await createFinanceUser(school.id);
    const checkerId = await createFinanceUser(school.id);

    const { row } = await initiateRefund(
      db.sql,
      {
        schoolId: school.id,
        userId: makerId,
      },
      {
        student_id: student.id,
        erpnext_invoice_id: "ACC-SINV-A03",
        amount: 60,
        currency: "JOD",
        reason_code: "error_correction",
      },
      crypto.randomUUID(),
    );

    await withTx(school.id, (tx) => rejectRefund(tx, school.id, checkerId, row.id, "Not valid"));

    const secondCheckerId = await createFinanceUser(school.id);
    await expect(
      withTx(school.id, (tx) =>
        approveRefund(
          inTx(tx),
          async () => mockErpNext("CN-2"),
          school.id,
          secondCheckerId,
          row.id,
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("refuses to approve a non-existent refund", async () => {
    const school = await createSchool(db.sql);
    const checkerId = await createFinanceUser(school.id);

    await expect(
      withTx(school.id, (tx) =>
        approveRefund(
          inTx(tx),
          async () => mockErpNext("CN-X"),
          school.id,
          checkerId,
          crypto.randomUUID(),
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// Webhook completion
// ---------------------------------------------------------------------------

describeDb("approveRefund: ERPNext is called with no transaction open", () => {
  /** Each step in its own transaction, as the route runs it. */
  const separateTxs =
    (schoolId: string): TxRunner =>
    (fn) =>
      withTx(schoolId, fn);

  async function pendingRefund(invoice: string) {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);
    const makerId = await createFinanceUser(school.id);
    const checkerId = await createFinanceUser(school.id);
    const { row } = await initiateRefund(
      db.sql,
      { schoolId: school.id, userId: makerId },
      {
        student_id: student.id,
        erpnext_invoice_id: invoice,
        amount: 25,
        currency: "JOD",
        reason_code: "overpayment",
      },
      crypto.randomUUID(),
    );
    return { schoolId: school.id, checkerId, refundId: row.id };
  }

  function erpNextAnswering(
    post: () => Promise<unknown>,
    get: (path: string) => Promise<unknown> = () => Promise.reject(new Error("not implemented")),
  ): {
    client: TenantErpNext;
    calls: () => number;
    gets: string[];
    bodies: unknown[];
  } {
    let calls = 0;
    const gets: string[] = [];
    const bodies: unknown[] = [];
    const client = {
      get: (path: string) => {
        // The invoice reads before the post are not lookups; `gets` records only lookups.
        const read = invoiceRead(path);
        if (read) return read;
        gets.push(path);
        return get(path);
      },
      post: (_path: string, body: unknown, options?: { retry?: boolean }) => {
        calls += 1;
        bodies.push(body);
        // An approval's write is never retried by the client (a retry could post twice).
        expect(options?.retry).toBe(false);
        return post();
      },
      put: () => Promise.reject(new Error("not implemented")),
    } as unknown as TenantErpNext;
    return { client, calls: () => calls, gets, bodies };
  }

  /** ERPNext's list answer for the credit-note lookup. */
  const creditNotes = (...names: string[]) =>
    Promise.resolve({
      data: { data: names.map((name) => ({ name })) },
      status: 200,
      headers: new Headers(),
    });

  const timedOut = () =>
    Promise.reject(new ErpNextError("ERPNext request timed out", 504, null, "timeout"));

  function recordingLog() {
    const errors: Record<string, unknown>[] = [];
    const log = {
      error: (fields: Record<string, unknown>) => errors.push(fields),
      warn: () => undefined,
      info: () => undefined,
    } as unknown as RefundLog;
    return { log, errors };
  }

  /** Age a claim past STALE_REFUND_CLAIM_MINUTES, as if its approval request ended long ago. */
  async function ageClaim(refundId: string) {
    await db.sql`
      UPDATE app.refund_requests SET approved_at = now() - interval '1 hour'
      WHERE id = ${refundId}::uuid
    `;
  }

  async function statusOf(schoolId: string, refundId: string) {
    const [row] = await db.sql<{ status: string; checker_id: string | null }[]>`
      SELECT status, checker_id FROM app.refund_requests WHERE id = ${refundId}::uuid
    `;
    expect(row).toBeDefined();
    return { ...row!, schoolId };
  }

  test("an ERPNext refusal hands the claim back: pending again, and approvable later", async () => {
    const { schoolId, checkerId, refundId } = await pendingRefund("ACC-SINV-F01");
    const refusing = erpNextAnswering(() =>
      Promise.reject(new ErpNextError("Return exceeds the net paid amount", 417, {})),
    );

    await expect(
      approveRefund(
        separateTxs(schoolId),
        async () => refusing.client,
        schoolId,
        checkerId,
        refundId,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(await statusOf(schoolId, refundId)).toMatchObject({
      status: "pending_approval",
      checker_id: null,
    });

    const approved = await approveRefund(
      separateTxs(schoolId),
      async () => mockErpNext("ACC-CRN-F01"),
      schoolId,
      checkerId,
      refundId,
    );
    expect(approved).toMatchObject({
      status: "completed",
      erpnext_credit_note_id: "ACC-CRN-F01",
    });
  });

  test("ERPNext accepted, named no document and cannot be asked: stays claimed, never approved twice", async () => {
    const { schoolId, checkerId, refundId } = await pendingRefund("ACC-SINV-F02");
    const nameless = erpNextAnswering(() =>
      Promise.resolve({ data: { data: {} }, status: 201, headers: new Headers() }),
    );

    await expect(
      approveRefund(
        separateTxs(schoolId),
        async () => nameless.client,
        schoolId,
        checkerId,
        refundId,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(await statusOf(schoolId, refundId)).toMatchObject({
      status: "approved",
      checker_id: checkerId,
    });

    const retry = erpNextAnswering(() => Promise.reject(new Error("must not be called")));
    await expect(
      approveRefund(separateTxs(schoolId), async () => retry.client, schoolId, checkerId, refundId),
    ).rejects.toMatchObject({ status: 409 });
    expect(retry.calls()).toBe(0);
  });

  test("the credit note carries the refund's tag in user_remark", async () => {
    const { schoolId, checkerId, refundId } = await pendingRefund("ACC-SINV-T01");
    const erpnext = erpNextAnswering(() =>
      Promise.resolve({ data: { data: { name: "CN-T01" } }, status: 201, headers: new Headers() }),
    );
    await approveRefund(
      separateTxs(schoolId),
      async () => erpnext.client,
      schoolId,
      checkerId,
      refundId,
    );
    expect(String((erpnext.bodies[0] as { user_remark?: string }).user_remark)).toContain(
      refundTag(refundId),
    );
  });

  test("ambiguous failure, credit note found in ERPNext: finalized once, never posted again", async () => {
    const { schoolId, checkerId, refundId } = await pendingRefund("ACC-SINV-A10");
    const erpnext = erpNextAnswering(timedOut, () => creditNotes("ACC-CRN-A10"));

    const approved = await approveRefund(
      separateTxs(schoolId),
      async () => erpnext.client,
      schoolId,
      checkerId,
      refundId,
    );

    expect(approved).toMatchObject({
      status: "completed",
      erpnext_credit_note_id: "ACC-CRN-A10",
      checker_id: checkerId,
    });
    expect(erpnext.calls()).toBe(1);
    // The lookup asks for a submitted Credit Note journal entry carrying the refund's tag.
    const lookup = decodeURIComponent(erpnext.gets[0]!);
    expect(lookup).toStartWith("/api/resource/Journal Entry?");
    expect(lookup).toContain('["voucher_type","=","Credit Note"]');
    expect(lookup).toContain(refundTag(refundId));
  });

  test("ambiguous failure, nothing in ERPNext: handed back, and approvable later", async () => {
    const { schoolId, checkerId, refundId } = await pendingRefund("ACC-SINV-A11");
    const erpnext = erpNextAnswering(
      () => Promise.reject(new ErpNextError("Internal Server Error", 502, null, "http")),
      () => creditNotes(),
    );

    await expect(
      approveRefund(
        separateTxs(schoolId),
        async () => erpnext.client,
        schoolId,
        checkerId,
        refundId,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(await statusOf(schoolId, refundId)).toMatchObject({
      status: "pending_approval",
      checker_id: null,
    });
  });

  test("ambiguous failure and the lookup fails: stays approved, reported, settled later", async () => {
    const { schoolId, checkerId, refundId } = await pendingRefund("ACC-SINV-A12");
    const down = erpNextAnswering(timedOut, () =>
      Promise.reject(new ErpNextError("unreachable", 503, null, "network")),
    );
    const { log, errors } = recordingLog();

    await expect(
      approveRefund(
        separateTxs(schoolId),
        async () => down.client,
        schoolId,
        checkerId,
        refundId,
        undefined,
        log,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(await statusOf(schoolId, refundId)).toMatchObject({ status: "approved" });
    expect(errors).toEqual([
      expect.objectContaining({ refund_request_id: refundId, stage: "approval" }),
    ]);

    // Still in flight: another approval is refused without touching ERPNext.
    const again = erpNextAnswering(() => Promise.reject(new Error("must not be called")));
    await expect(
      approveRefund(separateTxs(schoolId), async () => again.client, schoolId, checkerId, refundId),
    ).rejects.toMatchObject({ status: 409 });

    // Once stale, approving again settles the claim first: ERPNext had it, so it is finalized
    // without a second POST.
    await ageClaim(refundId);
    const found = erpNextAnswering(
      () => Promise.reject(new Error("must not be called")),
      () => creditNotes("ACC-CRN-A12"),
    );
    const settled = await approveRefund(
      separateTxs(schoolId),
      async () => found.client,
      schoolId,
      checkerId,
      refundId,
    );
    expect(settled).toMatchObject({
      status: "completed",
      erpnext_credit_note_id: "ACC-CRN-A12",
    });
    expect(found.calls()).toBe(0);
  });

  test("accepted without a name: recorded when the lookup finds it, kept approved when not", async () => {
    const found = await pendingRefund("ACC-SINV-N01");
    const nameless = () =>
      Promise.resolve({ data: { data: {} }, status: 201, headers: new Headers() });
    const finds = erpNextAnswering(nameless, () => creditNotes("ACC-CRN-N01"));
    const approved = await approveRefund(
      separateTxs(found.schoolId),
      async () => finds.client,
      found.schoolId,
      found.checkerId,
      found.refundId,
    );
    expect(approved.erpnext_credit_note_id).toBe("ACC-CRN-N01");

    // Accepted is not absent: an empty lookup never hands the claim back for a second post.
    const lost = await pendingRefund("ACC-SINV-N02");
    const empty = erpNextAnswering(nameless, () => creditNotes());
    await expect(
      approveRefund(
        separateTxs(lost.schoolId),
        async () => empty.client,
        lost.schoolId,
        lost.checkerId,
        lost.refundId,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect((await statusOf(lost.schoolId, lost.refundId)).status).toBe("approved");
  });

  test("two concurrent approvals call ERPNext once", async () => {
    const { schoolId, checkerId, refundId } = await pendingRefund("ACC-SINV-F03");
    const secondChecker = await createFinanceUser(schoolId);
    const slow = erpNextAnswering(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                data: { data: { name: "ACC-CRN-F03" } },
                status: 201,
                headers: new Headers(),
              }),
            50,
          ),
        ),
    );

    const outcomes = await Promise.allSettled([
      approveRefund(separateTxs(schoolId), async () => slow.client, schoolId, checkerId, refundId),
      approveRefund(
        separateTxs(schoolId),
        async () => slow.client,
        schoolId,
        secondChecker,
        refundId,
      ),
    ]);

    expect(slow.calls()).toBe(1);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409 });
    expect((await statusOf(schoolId, refundId)).status).toBe("completed");
  });
});

describeDb("reconcileStaleRefundClaims", () => {
  async function claimedRefund(schoolId: string, invoice: string, minutesAgo: number) {
    const student = await createStudent(db.sql, schoolId);
    const makerId = await createFinanceUser(schoolId);
    const checkerId = await createFinanceUser(schoolId);
    const { row } = await initiateRefund(
      db.sql,
      { schoolId, userId: makerId },
      {
        student_id: student.id,
        erpnext_invoice_id: invoice,
        amount: 10,
        currency: "JOD",
        reason_code: "overpayment",
      },
      crypto.randomUUID(),
    );
    await db.sql`
      UPDATE app.refund_requests
      SET status = 'approved', checker_id = ${checkerId}::uuid,
          approved_at = now() - make_interval(mins => ${minutesAgo})
      WHERE id = ${row.id}::uuid
    `;
    return row.id;
  }

  test("finalizes what ERPNext has, hands back what it lacks, leaves fresh claims alone", async () => {
    const school = await createSchool(db.sql);
    const posted = await claimedRefund(school.id, "ACC-SINV-R01", 60);
    const missing = await claimedRefund(school.id, "ACC-SINV-R02", 60);
    const fresh = await claimedRefund(school.id, "ACC-SINV-R03", 1);
    let posts = 0;
    const erpnext = {
      get: (path: string) =>
        Promise.resolve({
          data: {
            // The lookup finds a journal entry by the refund's tag (its id), not by the invoice.
            data: decodeURIComponent(path).includes(posted) ? [{ name: "ACC-CRN-R01" }] : [],
          },
          status: 200,
          headers: new Headers(),
        }),
      post: () => {
        posts += 1;
        return Promise.reject(new Error("the reconciler never posts"));
      },
      put: () => Promise.reject(new Error("not implemented")),
    } as unknown as TenantErpNext;

    const counts = await reconcileStaleRefundClaims(
      db.sql,
      { forSchool: async () => erpnext } as unknown as TenantErpNextFactory,
      school.id,
    );

    expect(counts).toEqual({ finalized: 1, released: 1, unknown: 0 });
    expect(posts).toBe(0);
    const rows = await db.sql<
      { id: string; status: string; erpnext_credit_note_id: string | null }[]
    >`
      SELECT id, status, erpnext_credit_note_id FROM app.refund_requests
      WHERE id IN (${posted}::uuid, ${missing}::uuid, ${fresh}::uuid)
    `;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(posted)).toMatchObject({
      status: "completed",
      erpnext_credit_note_id: "ACC-CRN-R01",
    });
    expect(byId.get(missing)!.status).toBe("pending_approval");
    expect(byId.get(fresh)!.status).toBe("approved");

    // The finalize is audited as the checker's approval.
    const [audit] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.audit_logs
      WHERE target_table = 'refund_requests' AND target_id = ${posted}
        AND new_values->>'status' = 'completed'
    `;
    expect(audit!.n).toBe(1);
  });

  test("a lookup failure leaves the claim approved and counts it as unknown", async () => {
    const school = await createSchool(db.sql);
    const stuck = await claimedRefund(school.id, "ACC-SINV-R04", 60);
    const erpnext = {
      get: () => Promise.reject(new ErpNextError("unreachable", 503, null, "network")),
      post: () => Promise.reject(new Error("the reconciler never posts")),
      put: () => Promise.reject(new Error("not implemented")),
    } as unknown as TenantErpNext;

    const counts = await reconcileStaleRefundClaims(
      db.sql,
      { forSchool: async () => erpnext } as unknown as TenantErpNextFactory,
      school.id,
    );

    expect(counts).toEqual({ finalized: 0, released: 0, unknown: 1 });
    const [row] = await db.sql<{ status: string }[]>`
      SELECT status FROM app.refund_requests WHERE id = ${stuck}::uuid
    `;
    expect(row!.status).toBe("approved");
  });

  test("a school with nothing stuck never opens an ERPNext client", async () => {
    const school = await createSchool(db.sql);
    let opened = 0;
    const counts = await reconcileStaleRefundClaims(
      db.sql,
      {
        forSchool: async () => {
          opened += 1;
          return {} as TenantErpNext;
        },
      } as unknown as TenantErpNextFactory,
      school.id,
    );
    expect(counts).toEqual({ finalized: 0, released: 0, unknown: 0 });
    expect(opened).toBe(0);
  });
});

describeDb("applyRefundCompleted", () => {
  test("completes a submitted refund via webhook", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);
    const makerId = await createFinanceUser(school.id);
    const checkerId = await createFinanceUser(school.id);
    const creditNoteName = "ACC-CRN-WH-00001";

    const { row } = await initiateRefund(
      db.sql,
      {
        schoolId: school.id,
        userId: makerId,
      },
      {
        student_id: student.id,
        erpnext_invoice_id: "ACC-SINV-W01",
        amount: 200,
        currency: "JOD",
        reason_code: "overpayment",
      },
      crypto.randomUUID(),
    );

    await withTx(school.id, (tx) =>
      approveRefund(
        inTx(tx),
        async () => mockErpNext(creditNoteName),
        school.id,
        checkerId,
        row.id,
      ),
    );

    await withTx(school.id, (tx) => applyRefundCompleted(tx, school.id, creditNoteName, {}));

    const completed = await withTx(school.id, (tx) => getRefund(tx, school.id, row.id));
    expect(completed.status).toBe("completed");
    expect(completed.completed_at).not.toBeNull();
  });

  test("ignores webhook for a pending (not submitted) refund", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);

    const { row } = await initiateRefund(
      db.sql,
      {
        schoolId: school.id,
        userId: await createFinanceUser(school.id),
      },
      {
        student_id: student.id,
        erpnext_invoice_id: "ACC-SINV-W02",
        amount: 50,
        currency: "JOD",
        reason_code: "overpayment",
      },
      crypto.randomUUID(),
    );

    await withTx(school.id, (tx) => applyRefundCompleted(tx, school.id, "ACC-CRN-WH-GHOST", {}));

    const unchanged = await withTx(school.id, (tx) => getRefund(tx, school.id, row.id));
    expect(unchanged.status).toBe("pending_approval");
  });

  test("does not error for an unknown credit note id", async () => {
    const school = await createSchool(db.sql);

    await expect(
      withTx(school.id, (tx) => applyRefundCompleted(tx, school.id, "ACC-CRN-NEVER-EXISTED", {})),
    ).resolves.toBeUndefined();
  });

  test("full maker -> checker -> webhook happy path", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);
    const makerId = await createFinanceUser(school.id);
    const checkerId = await createFinanceUser(school.id);
    const creditNoteName = "ACC-CRN-HAPPY-00001";

    // Maker initiates
    const { row: initiated } = await initiateRefund(
      db.sql,
      {
        schoolId: school.id,
        userId: makerId,
      },
      {
        student_id: student.id,
        erpnext_invoice_id: "ACC-SINV-H01",
        amount: 150,
        currency: "JOD",
        reason_code: "withdrawal",
      },
      crypto.randomUUID(),
    );

    expect(initiated.status).toBe("pending_approval");
    expect(initiated.maker_id).toBe(makerId);
    expect(initiated.checker_id).toBeNull();

    // Checker approves
    const approved = await withTx(school.id, (tx) =>
      approveRefund(
        inTx(tx),
        async () => mockErpNext(creditNoteName),
        school.id,
        checkerId,
        initiated.id,
      ),
    );

    expect(approved.status).toBe("completed");
    expect(approved.checker_id).toBe(checkerId);
    expect(approved.erpnext_credit_note_id).toBe(creditNoteName);

    // A later credit-note webhook for it changes nothing: the refund is already complete.
    await withTx(school.id, (tx) => applyRefundCompleted(tx, school.id, creditNoteName, {}));

    const completed = await withTx(school.id, (tx) => getRefund(tx, school.id, initiated.id));

    expect(completed.status).toBe("completed");
    expect(completed.erpnext_credit_note_id).toBe(creditNoteName);
    expect(completed.completed_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The credit note is built from the invoice in ERPNext
// ---------------------------------------------------------------------------

describeDb("approveRefund: the credit note is a journal entry built from the invoice", () => {
  const ok = (data: unknown) => Promise.resolve({ data, status: 200, headers: new Headers() });

  async function pendingRefund(
    invoice: string,
    amount = 25,
    schoolId?: string,
    studentId?: string,
    payout_mode?: "cash" | "bank_transfer" | "card_external" | "credit",
  ) {
    const school = schoolId ? { id: schoolId } : await createSchool(db.sql);
    const student = studentId ? { id: studentId } : await createStudent(db.sql, school.id);
    const makerId = await createFinanceUser(school.id);
    const checkerId = await createFinanceUser(school.id);
    const { row } = await initiateRefund(
      db.sql,
      { schoolId: school.id, userId: makerId },
      {
        student_id: student.id,
        erpnext_invoice_id: invoice,
        amount,
        currency: "JOD",
        reason_code: "overpayment",
        ...(payout_mode ? { payout_mode } : {}),
      },
      crypto.randomUUID(),
    );
    return { schoolId: school.id, studentId: student.id, checkerId, refundId: row.id };
  }

  const separateTxs =
    (schoolId: string): TxRunner =>
    (fn) =>
      withTx(schoolId, fn);

  async function statusOf(refundId: string) {
    const [row] = await db.sql<{ status: string; erpnext_credit_note_id: string | null }[]>`
      SELECT status, erpnext_credit_note_id FROM app.refund_requests WHERE id = ${refundId}::uuid
    `;
    return row!;
  }

  /** A fake ERPNext site: the invoice, and every write it is sent. */
  function site(
    opts: {
      invoice?: Record<string, unknown> | Error;
      name?: string;
      cashAccount?: string | null;
    } = {},
  ) {
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    const accountLookups: string[] = [];
    const client = {
      get: (path: string) => {
        if (path.includes("get_bank_cash_account")) {
          accountLookups.push(decodeURIComponent(path));
          return ok({
            message: opts.cashAccount === null ? {} : { account: opts.cashAccount ?? "Cash - TS" },
          });
        }
        if (opts.invoice instanceof Error) return Promise.reject(opts.invoice);
        return ok({ data: { ...REFUNDABLE_INVOICE, ...opts.invoice } });
      },
      post: (path: string, body: Record<string, unknown>, options?: { retry?: boolean }) => {
        expect(options?.retry).toBe(false);
        posts.push({ path, body });
        return ok({ data: { name: opts.name ?? "ACC-JV-0001" } });
      },
      put: () => Promise.reject(new Error("not implemented")),
    } as unknown as TenantErpNext;
    return { client, posts, accountLookups };
  }

  test("posts one Credit Note journal entry and completes the refund", async () => {
    const { schoolId, checkerId, refundId } = await pendingRefund("ACC-SINV-J01");
    const erpnext = site({ name: "ACC-JV-J01" });

    const approved = await approveRefund(
      separateTxs(schoolId),
      async () => erpnext.client,
      schoolId,
      checkerId,
      refundId,
    );

    expect(approved.status).toBe("completed");
    expect(approved.erpnext_credit_note_id).toBe("ACC-JV-J01");
    expect(approved.completed_at).not.toBeNull();
    expect(erpnext.posts).toHaveLength(1);
    expect(erpnext.posts[0]!.path).toBe("/api/resource/Journal%20Entry");
    expect(erpnext.posts[0]!.body).toMatchObject({ voucher_type: "Credit Note", docstatus: 1 });
  });

  test("a second partial refund of the same invoice is allowed up to what it charged", async () => {
    const first = await pendingRefund("ACC-SINV-J02", 600);
    await approveRefund(
      separateTxs(first.schoolId),
      async () => site().client,
      first.schoolId,
      first.checkerId,
      first.refundId,
    );

    const second = await pendingRefund("ACC-SINV-J02", 400, first.schoolId, first.studentId);
    const approved = await approveRefund(
      separateTxs(second.schoolId),
      async () => site({ name: "ACC-JV-J02B" }).client,
      second.schoolId,
      second.checkerId,
      second.refundId,
    );
    expect(approved.status).toBe("completed");

    // 600 + 400 is the whole 1000 charged: one more unit is refused, and nothing is posted.
    const third = await pendingRefund("ACC-SINV-J02", 1, first.schoolId, first.studentId);
    const erpnext = site();
    await expect(
      approveRefund(
        separateTxs(third.schoolId),
        async () => erpnext.client,
        third.schoolId,
        third.checkerId,
        third.refundId,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(erpnext.posts).toHaveLength(0);
    expect((await statusOf(third.refundId)).status).toBe("pending_approval");
  });

  test("a cancelled or draft invoice is refused before anything is posted", async () => {
    const { schoolId, checkerId, refundId } = await pendingRefund("ACC-SINV-J03");
    const erpnext = site({ invoice: { docstatus: 2 } });

    await expect(
      approveRefund(
        separateTxs(schoolId),
        async () => erpnext.client,
        schoolId,
        checkerId,
        refundId,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(erpnext.posts).toHaveLength(0);
    expect((await statusOf(refundId)).status).toBe("pending_approval");
  });

  test("an invoice in another currency is refused before anything is posted", async () => {
    const { schoolId, checkerId, refundId } = await pendingRefund("ACC-SINV-J04");
    const erpnext = site({ invoice: { currency: "USD" } });

    await expect(
      approveRefund(
        separateTxs(schoolId),
        async () => erpnext.client,
        schoolId,
        checkerId,
        refundId,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(erpnext.posts).toHaveLength(0);
  });

  test("an unpaid invoice: the refund is taken off it and no cash moves", async () => {
    const { schoolId, checkerId, refundId } = await pendingRefund("ACC-SINV-J10");
    const erpnext = site();

    const approved = await approveRefund(
      separateTxs(schoolId),
      async () => erpnext.client,
      schoolId,
      checkerId,
      refundId,
    );

    expect(approved).toMatchObject({
      payout_mode: "cash",
      settlement: "invoice",
      paid_out_amount_minor: 0,
    });
    expect(erpnext.accountLookups).toHaveLength(0);
  });

  test("a paid invoice refunded in cash: paid out from the Cash account, recorded as paid out", async () => {
    const { schoolId, checkerId, refundId } = await pendingRefund("ACC-SINV-J11", 25);
    const erpnext = site({ invoice: { outstanding_amount: 0 }, cashAccount: "Cash - TS" });

    const approved = await approveRefund(
      separateTxs(schoolId),
      async () => erpnext.client,
      schoolId,
      checkerId,
      refundId,
    );

    expect(approved).toMatchObject({
      status: "completed",
      payout_mode: "cash",
      settlement: "paid_out",
      paid_out_amount: "25.000",
      paid_out_amount_minor: 25_000,
    });
    expect(erpnext.accountLookups[0]).toContain("mode_of_payment=Cash");
    const accounts = erpnext.posts[0]!.body.accounts as Record<string, unknown>[];
    expect(accounts.at(-1)).toEqual({ account: "Cash - TS", credit_in_account_currency: 25 });
  });

  test("kept as credit: nothing is paid out and no cash account is needed", async () => {
    const { schoolId, checkerId, refundId } = await pendingRefund(
      "ACC-SINV-J12",
      25,
      undefined,
      undefined,
      "credit",
    );
    const erpnext = site({ invoice: { outstanding_amount: 0 }, cashAccount: null });

    const approved = await approveRefund(
      separateTxs(schoolId),
      async () => erpnext.client,
      schoolId,
      checkerId,
      refundId,
    );

    expect(approved).toMatchObject({ settlement: "family_credit", paid_out_amount_minor: 0 });
    expect(erpnext.accountLookups).toHaveLength(0);
  });

  test("no default cash account in ERPNext: refused before anything is posted, still pending", async () => {
    const { schoolId, checkerId, refundId } = await pendingRefund("ACC-SINV-J13");
    const erpnext = site({ invoice: { outstanding_amount: 0 }, cashAccount: null });

    await expect(
      approveRefund(
        separateTxs(schoolId),
        async () => erpnext.client,
        schoolId,
        checkerId,
        refundId,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(erpnext.posts).toHaveLength(0);
    const [row] = await db.sql<{ status: string; settlement: string; paid_out_minor: string }[]>`
      SELECT status, settlement, paid_out_minor::text FROM app.refund_requests WHERE id = ${refundId}::uuid
    `;
    expect(row).toEqual({ status: "pending_approval", settlement: "pending", paid_out_minor: "0" });
  });

  test("a refusal after the settlement is recorded puts it back to pending", async () => {
    const { schoolId, checkerId, refundId } = await pendingRefund("ACC-SINV-J14");
    const erpnext = site({ invoice: { outstanding_amount: 0 } });
    (erpnext.client as unknown as { post: unknown }).post = () =>
      Promise.reject(new ErpNextError("Cash account is frozen", 417, {}));

    await expect(
      approveRefund(
        separateTxs(schoolId),
        async () => erpnext.client,
        schoolId,
        checkerId,
        refundId,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const [row] = await db.sql<{ status: string; settlement: string }[]>`
      SELECT status, settlement FROM app.refund_requests WHERE id = ${refundId}::uuid
    `;
    expect(row).toEqual({ status: "pending_approval", settlement: "pending" });
  });

  test("ERPNext down while reading the invoice hands the claim back and posts nothing", async () => {
    const { schoolId, checkerId, refundId } = await pendingRefund("ACC-SINV-J05");
    const erpnext = site({ invoice: new ErpNextError("unreachable", 503, null, "network") });

    await expect(
      approveRefund(
        separateTxs(schoolId),
        async () => erpnext.client,
        schoolId,
        checkerId,
        refundId,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(erpnext.posts).toHaveLength(0);
    expect((await statusOf(refundId)).status).toBe("pending_approval");
  });
});
