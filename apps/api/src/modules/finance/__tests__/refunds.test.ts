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

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import {
  createTestDatabase,
  createSchool,
  createStudent,
  integrationEnabled,
  migrateDatabase,
  type TestDatabase,
} from "../../../../tests/harness";
import { CodedHttpException } from "../../../coded-http-exception";
import {
  approveRefund,
  applyRefundCompleted,
  buildCreditNotePayload,
  getRefund,
  hashRefundRequest,
  initiateRefund,
  listRefunds,
  rejectRefund,
  type InitiateRefundParams,
} from "../refunds/service";

import type { TenantErpNext } from "../client/tenant-client";
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

describe("Credit Note payload", () => {
  test("submits rather than saving a draft", () => {
    expect(buildCreditNotePayload(makeParams(), SCHOOL_ID).docstatus).toBe(1);
  });

  test("is marked as a return against the original invoice", () => {
    const payload = buildCreditNotePayload(
      makeParams({ erpnext_invoice_id: "ACC-SINV-2026-00042" }),
      SCHOOL_ID,
    );
    expect(payload.is_return).toBe(1);
    expect(payload.return_against).toBe("ACC-SINV-2026-00042");
  });

  test("carries the school and student so the webhook can route back", () => {
    const payload = buildCreditNotePayload(makeParams(), SCHOOL_ID);
    expect(payload.custom_school_id).toBe(SCHOOL_ID);
    expect(payload.custom_student_id).toBe(STUDENT_ID);
  });

  test("amounts are negative for a return", () => {
    const payload = buildCreditNotePayload(makeParams({ amount: 50 }), SCHOOL_ID);
    expect(payload.total).toBe(-50);
    expect(payload.grand_total).toBe(-50);
    expect(payload.outstanding_amount).toBe(-50);
  });

  test("carries the reason code as a custom field", () => {
    const payload = buildCreditNotePayload(makeParams({ reason_code: "withdrawal" }), SCHOOL_ID);
    expect(payload.custom_reason_code).toBe("withdrawal");
  });

  test("omits reason_notes when absent", () => {
    const payload = buildCreditNotePayload(makeParams(), SCHOOL_ID);
    expect(payload).not.toHaveProperty("custom_reason_notes");
  });

  test("includes reason_notes when provided", () => {
    const payload = buildCreditNotePayload(
      makeParams({ reason_notes: "Parent requested refund" }),
      SCHOOL_ID,
    );
    expect(payload.custom_reason_notes).toBe("Parent requested refund");
  });

  test("does not update stock for a credit note", () => {
    const payload = buildCreditNotePayload(makeParams(), SCHOOL_ID);
    expect(payload.update_stock).toBe(0);
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

function mockErpNext(creditNoteName: string): TenantErpNext {
  return {
    get: () => Promise.reject(new Error("not implemented")),
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
        userId: crypto.randomUUID(),
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
        userId: crypto.randomUUID(),
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
        userId: crypto.randomUUID(),
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
        userId: crypto.randomUUID(),
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
          userId: crypto.randomUUID(),
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
          userId: crypto.randomUUID(),
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
          userId: crypto.randomUUID(),
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
    const userIdA = crypto.randomUUID();
    const userIdB = crypto.randomUUID();

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
    const userId = crypto.randomUUID();

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
        userId: crypto.randomUUID(),
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
        userId: crypto.randomUUID(),
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
    const makerId = crypto.randomUUID();
    const checkerId = crypto.randomUUID();

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
    const userId = crypto.randomUUID();

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
    const makerId = crypto.randomUUID();
    const checkerId = crypto.randomUUID();

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

    await expect(
      withTx(school.id, (tx) =>
        rejectRefund(tx, school.id, crypto.randomUUID(), row.id, "Second rejection"),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("refuses to reject a non-existent refund", async () => {
    const school = await createSchool(db.sql);

    await expect(
      withTx(school.id, (tx) =>
        rejectRefund(tx, school.id, crypto.randomUUID(), crypto.randomUUID(), "Nope"),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// Approve refund (with mock ERPNext)
// ---------------------------------------------------------------------------

describeDb("approveRefund", () => {
  test("approves a refund and marks it as submitted_to_erpnext", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);
    const makerId = crypto.randomUUID();
    const checkerId = crypto.randomUUID();
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
      approveRefund(tx, mockErpNext(creditNoteName), school.id, checkerId, row.id),
    );

    expect(approved.status).toBe("submitted_to_erpnext");
    expect(approved.checker_id).toBe(checkerId);
    expect(approved.erpnext_credit_note_id).toBe(creditNoteName);
    expect(approved.approved_at).not.toBeNull();
  });

  test("refuses self-approval (maker === checker)", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);
    const userId = crypto.randomUUID();

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
      withTx(school.id, (tx) => approveRefund(tx, mockErpNext("CN-1"), school.id, userId, row.id)),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("refuses to approve a rejected refund", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);
    const makerId = crypto.randomUUID();
    const checkerId = crypto.randomUUID();

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

    await expect(
      withTx(school.id, (tx) =>
        approveRefund(tx, mockErpNext("CN-2"), school.id, crypto.randomUUID(), row.id),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("refuses to approve a non-existent refund", async () => {
    const school = await createSchool(db.sql);

    await expect(
      withTx(school.id, (tx) =>
        approveRefund(tx, mockErpNext("CN-X"), school.id, crypto.randomUUID(), crypto.randomUUID()),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// Webhook completion
// ---------------------------------------------------------------------------

describeDb("applyRefundCompleted", () => {
  test("completes a submitted refund via webhook", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);
    const makerId = crypto.randomUUID();
    const checkerId = crypto.randomUUID();
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
      approveRefund(tx, mockErpNext(creditNoteName), school.id, checkerId, row.id),
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
        userId: crypto.randomUUID(),
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
    const makerId = crypto.randomUUID();
    const checkerId = crypto.randomUUID();
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
      approveRefund(tx, mockErpNext(creditNoteName), school.id, checkerId, initiated.id),
    );

    expect(approved.status).toBe("submitted_to_erpnext");
    expect(approved.checker_id).toBe(checkerId);
    expect(approved.erpnext_credit_note_id).toBe(creditNoteName);

    // ERPNext sends webhook confirmation
    await withTx(school.id, (tx) => applyRefundCompleted(tx, school.id, creditNoteName, {}));

    const completed = await withTx(school.id, (tx) => getRefund(tx, school.id, initiated.id));

    expect(completed.status).toBe("completed");
    expect(completed.erpnext_credit_note_id).toBe(creditNoteName);
    expect(completed.completed_at).not.toBeNull();
  });
});
