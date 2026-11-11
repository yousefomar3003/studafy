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
  buildCreditNotePayload,
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
  test("approves a refund and marks it as submitted_to_erpnext", async () => {
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

    expect(approved.status).toBe("submitted_to_erpnext");
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
      status: "submitted_to_erpnext",
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

  test("the credit note carries the refund's tag in remarks", async () => {
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
    expect(erpnext.bodies[0]).toMatchObject({ remarks: refundTag(refundId) });
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
      status: "submitted_to_erpnext",
      erpnext_credit_note_id: "ACC-CRN-A10",
      checker_id: checkerId,
    });
    expect(erpnext.calls()).toBe(1);
    // The lookup names the invoice, a submitted return, and the refund's tag.
    const lookup = decodeURIComponent(erpnext.gets[0]!);
    expect(lookup).toContain('["return_against","=","ACC-SINV-A10"]');
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
      status: "submitted_to_erpnext",
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
    expect((await statusOf(schoolId, refundId)).status).toBe("submitted_to_erpnext");
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
            data: decodeURIComponent(path).includes("ACC-SINV-R01")
              ? [{ name: "ACC-CRN-R01" }]
              : [],
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
      status: "submitted_to_erpnext",
      erpnext_credit_note_id: "ACC-CRN-R01",
    });
    expect(byId.get(missing)!.status).toBe("pending_approval");
    expect(byId.get(fresh)!.status).toBe("approved");

    // The finalize is audited as the checker's approval.
    const [audit] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.audit_logs
      WHERE target_table = 'refund_requests' AND target_id = ${posted}
        AND new_values->>'status' = 'submitted_to_erpnext'
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
