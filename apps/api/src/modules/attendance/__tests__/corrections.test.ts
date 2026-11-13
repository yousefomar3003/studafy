// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import {
  createTestDatabase,
  migrateDatabase,
  createFullTenant,
  createTeacher,
  integrationEnabled,
  type TestDatabase,
  type TenantFixture,
} from "../../../../tests/harness";
import { CodedHttpException } from "../../../coded-http-exception";
import {
  correctAttendanceRecord,
  getAttendanceRecordHistory,
  getCorrectionWindowHours,
  DEFAULT_CORRECTION_WINDOW_HOURS,
} from "../corrections";

import type { AttendanceSessionStatus, AttendanceStatus } from "../schemas";
import type { ErrorCode } from "@studafy/constants";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Sql, TransactionSql } from "postgres";

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

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Run inside the same context the API would: the studafy_app role plus the tenant and actor GUCs.
 *
 * app.user_id is what separates this from the discipline suite's simpler wrapper — every
 * authorization decision a correction makes bottoms out in app.teaches_class() or
 * app.current_user_is_school_admin(), and both resolve the acting user from that setting.
 */
async function withTx<T>(
  schoolId: string,
  userId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx`
      SELECT set_config('role', 'studafy_app', true),
             set_config('app.school_id', ${schoolId}, true),
             set_config('app.user_id', ${userId}, true)
    `;
    result = await fn(tx);
  });
  return result as T;
}

/** Seeded as studafy_admin for the reason createStudent documents: role_scope_visibility is a
 *  restrictive SELECT policy, and PostgreSQL applies it to INSERT ... RETURNING too. */
async function asAdmin<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    result = await fn(tx);
  });
  return result as T;
}

interface RecordFixture {
  sessionId: string;
  recordId: string;
  studentId: string;
}

let periodCounter = 0;

/**
 * A session at `sessionDate` in `status`, holding one record for the tenant's first student.
 *
 * Each call takes a fresh period so the business-key registry
 * (uq_attendance_session_keys_business_key over school/class/date/period) never collides between
 * tests sharing a class.
 */
async function seedRecord(
  fixture: TenantFixture,
  options: {
    sessionDate: string;
    sessionStatus: AttendanceSessionStatus;
    status?: AttendanceStatus;
    minutesLate?: number | null;
    classId?: string;
  },
): Promise<RecordFixture> {
  periodCounter += 1;
  const period = periodCounter;
  const student = fixture.students[0]!;
  const teacherUserId = fixture.teachers[0]!.userId;

  return asAdmin(fixture.schoolId, async (tx) => {
    const [session] = await tx<{ id: string; created_at: Date }[]>`
      INSERT INTO app.attendance_sessions
        (school_id, class_id, session_date, period, status, taken_by_user_id)
      VALUES (
        ${fixture.schoolId}::uuid,
        ${options.classId ?? fixture.cls.id}::uuid,
        ${options.sessionDate}::date,
        ${period}::smallint,
        ${options.sessionStatus}::app.attendance_session_status,
        ${teacherUserId}::uuid
      )
      RETURNING id, created_at
    `;

    const [record] = await tx<{ id: string }[]>`
      INSERT INTO app.attendance_records
        (school_id, attendance_session_id, session_created_at, student_id, status, minutes_late,
         recorded_by_user_id)
      VALUES (
        ${fixture.schoolId}::uuid,
        ${session!.id}::uuid,
        ${session!.created_at},
        ${student.id}::uuid,
        ${options.status ?? "absent"}::app.attendance_status,
        ${options.minutesLate ?? null}::smallint,
        ${teacherUserId}::uuid
      )
      RETURNING id
    `;

    return { sessionId: session!.id, recordId: record!.id, studentId: student.id };
  });
}

async function setCorrectionWindowHours(schoolId: string, hours: number): Promise<void> {
  await asAdmin(schoolId, async (tx) => {
    await tx`
      INSERT INTO app.school_settings (school_id, attendance_correction_window_hours)
      VALUES (${schoolId}::uuid, ${hours})
      ON CONFLICT (school_id)
      DO UPDATE SET attendance_correction_window_hours = EXCLUDED.attendance_correction_window_hours
    `;
  });
}

/**
 * Assert the database refuses a statement outright.
 *
 * Runs it inside a PL/pgSQL sub-transaction, the pattern packages/db/tests uses: a statement
 * rejected on the outer transaction poisons it, and postgres.js then has no clean path to a
 * ROLLBACK — the test hangs instead of failing. Catching inside the block keeps the failure local,
 * and re-raising when the statement *succeeded* is what makes this an assertion rather than a
 * try/catch that passes either way.
 */
async function expectDenied(schoolId: string, userId: string, statement: string): Promise<void> {
  await withTx(schoolId, userId, async (tx) => {
    await tx.unsafe(`
      DO $expected_denial$
      DECLARE failed boolean := false;
      BEGIN
        BEGIN
          EXECUTE $statement$${statement}$statement$;
        EXCEPTION WHEN OTHERS THEN
          failed := true;
        END;
        IF NOT failed THEN
          RAISE EXCEPTION 'expected the statement to be denied, but it succeeded';
        END IF;
      END
      $expected_denial$
    `);
  });
}

/** Assert a rejection carries a specific HTTP status and canonical error code. */
async function expectCoded(
  promise: Promise<unknown>,
  status: ContentfulStatusCode,
  code: ErrorCode,
): Promise<CodedHttpException> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CodedHttpException);
  const coded = caught as CodedHttpException;
  expect(coded.status).toBe(status);
  expect(coded.code).toBe(code);
  return coded;
}

async function readRecord(
  sql: Sql,
  schoolId: string,
  recordId: string,
): Promise<{ status: string; minutes_late: number | null; version: number }> {
  const [row] = await sql<{ status: string; minutes_late: number | null; version: number }[]>`
    SELECT status::text AS status, minutes_late, version
    FROM app.attendance_records
    WHERE id = ${recordId}::uuid AND school_id = ${schoolId}::uuid
  `;
  return row!;
}

async function countVersions(sql: Sql, recordId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM app.attendance_record_versions
    WHERE attendance_record_id = ${recordId}::uuid
  `;
  return row!.count;
}

/** Today in UTC. Anchors "clearly inside a 48-hour window" without depending on the wall clock. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Correction window
// ---------------------------------------------------------------------------

describeDb("getCorrectionWindowHours", () => {
  test("falls back to the 48-hour default when the school has no settings row", async () => {
    const fixture = await createFullTenant(db.sql);

    const hours = await withTx(fixture.schoolId, fixture.teachers[0]!.userId, (tx) =>
      getCorrectionWindowHours(tx, fixture.schoolId),
    );

    expect(hours).toBe(DEFAULT_CORRECTION_WINDOW_HOURS);
  });

  test("returns the school's configured window once one is set", async () => {
    const fixture = await createFullTenant(db.sql);
    await setCorrectionWindowHours(fixture.schoolId, 12);

    const hours = await withTx(fixture.schoolId, fixture.teachers[0]!.userId, (tx) =>
      getCorrectionWindowHours(tx, fixture.schoolId),
    );

    expect(hours).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// In-window corrections
// ---------------------------------------------------------------------------

describeDb("correctAttendanceRecord — inside the window", () => {
  test("a teacher of the class corrects a submitted record and advances it to version 2", async () => {
    const fixture = await createFullTenant(db.sql);
    const teacherUserId = fixture.teachers[0]!.userId;
    const seeded = await seedRecord(fixture, {
      sessionDate: today(),
      sessionStatus: "submitted",
      status: "absent",
    });

    const corrected = await withTx(fixture.schoolId, teacherUserId, (tx) =>
      correctAttendanceRecord(tx, fixture.schoolId, teacherUserId, false, seeded.recordId, {
        status: "present",
        reason: "Student was marked absent in error; the register was misread.",
      }),
    );

    expect(corrected.status).toBe("present");
    expect(corrected.minutes_late).toBeNull();
    expect(corrected.version).toBe(2);
    expect(corrected.out_of_window).toBe(false);

    const stored = await readRecord(db.sql, fixture.schoolId, seeded.recordId);
    expect(stored.status).toBe("present");
    expect(stored.version).toBe(2);
  });

  test("writes exactly one immutable chain row describing the shift", async () => {
    const fixture = await createFullTenant(db.sql);
    const teacherUserId = fixture.teachers[0]!.userId;
    const seeded = await seedRecord(fixture, {
      sessionDate: today(),
      sessionStatus: "locked",
      status: "absent",
    });

    await withTx(fixture.schoolId, teacherUserId, (tx) =>
      correctAttendanceRecord(tx, fixture.schoolId, teacherUserId, false, seeded.recordId, {
        status: "excused",
        reason: "Medical note received after the register closed.",
      }),
    );

    const [chain] = await db.sql<Record<string, unknown>[]>`
      SELECT version, previous_status::text AS previous_status, new_status::text AS new_status,
             reason, corrected_by_user_id, out_of_window, student_id
      FROM app.attendance_record_versions
      WHERE attendance_record_id = ${seeded.recordId}::uuid
    `;

    expect(await countVersions(db.sql, seeded.recordId)).toBe(1);
    expect(chain!.version).toBe(2);
    expect(chain!.previous_status).toBe("absent");
    expect(chain!.new_status).toBe("excused");
    expect(chain!.reason).toBe("Medical note received after the register closed.");
    expect(chain!.corrected_by_user_id).toBe(teacherUserId);
    expect(chain!.out_of_window).toBe(false);
    expect(chain!.student_id).toBe(seeded.studentId);
  });

  test("stores minutes_late when correcting to 'late' and discards it otherwise", async () => {
    const fixture = await createFullTenant(db.sql);
    const teacherUserId = fixture.teachers[0]!.userId;
    const seeded = await seedRecord(fixture, {
      sessionDate: today(),
      sessionStatus: "submitted",
      status: "absent",
    });

    const toLate = await withTx(fixture.schoolId, teacherUserId, (tx) =>
      correctAttendanceRecord(tx, fixture.schoolId, teacherUserId, false, seeded.recordId, {
        status: "late",
        minutes_late: 15,
        reason: "Arrived 15 minutes into the period.",
      }),
    );
    expect(toLate.minutes_late).toBe(15);

    // minutes_late belongs to 'late' and is dropped on the way out of it, rather than lingering on
    // a status that cannot express it.
    const toPresent = await withTx(fixture.schoolId, teacherUserId, (tx) =>
      correctAttendanceRecord(tx, fixture.schoolId, teacherUserId, false, seeded.recordId, {
        status: "present",
        minutes_late: 15,
        reason: "Confirmed on time after checking the gate log.",
      }),
    );
    expect(toPresent.minutes_late).toBeNull();
    expect(toPresent.version).toBe(3);
  });

  test("rejects a correction to 'late' with no minutes_late", async () => {
    const fixture = await createFullTenant(db.sql);
    const teacherUserId = fixture.teachers[0]!.userId;
    const seeded = await seedRecord(fixture, {
      sessionDate: today(),
      sessionStatus: "submitted",
      status: "absent",
    });

    await expectCoded(
      withTx(fixture.schoolId, teacherUserId, (tx) =>
        correctAttendanceRecord(tx, fixture.schoolId, teacherUserId, false, seeded.recordId, {
          status: "late",
          reason: "Arrived after the bell.",
        }),
      ),
      400,
      "VALIDATION_FAILED",
    );
  });

  test("consecutive corrections extend the chain contiguously", async () => {
    const fixture = await createFullTenant(db.sql);
    const teacherUserId = fixture.teachers[0]!.userId;
    const seeded = await seedRecord(fixture, {
      sessionDate: today(),
      sessionStatus: "submitted",
      status: "absent",
    });

    await withTx(fixture.schoolId, teacherUserId, (tx) =>
      correctAttendanceRecord(tx, fixture.schoolId, teacherUserId, false, seeded.recordId, {
        status: "excused",
        reason: "Parent called in the absence.",
      }),
    );
    await withTx(fixture.schoolId, teacherUserId, (tx) =>
      correctAttendanceRecord(tx, fixture.schoolId, teacherUserId, false, seeded.recordId, {
        status: "present",
        reason: "Student was found to have attended the second half.",
      }),
    );

    const chain = await db.sql<{ version: number; new_status: string }[]>`
      SELECT version, new_status::text AS new_status
      FROM app.attendance_record_versions
      WHERE attendance_record_id = ${seeded.recordId}::uuid
      ORDER BY version
    `;

    expect(chain.map((row) => row.version)).toEqual([2, 3]);
    expect(chain.map((row) => row.new_status)).toEqual(["excused", "present"]);
    expect((await readRecord(db.sql, fixture.schoolId, seeded.recordId)).version).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Window expiry and the principal override
// ---------------------------------------------------------------------------

describeDb("correctAttendanceRecord — outside the window", () => {
  test("refuses a teacher once the window has closed, leaving the record untouched", async () => {
    const fixture = await createFullTenant(db.sql);
    const teacherUserId = fixture.teachers[0]!.userId;
    const seeded = await seedRecord(fixture, {
      sessionDate: "2026-01-05",
      sessionStatus: "submitted",
      status: "absent",
    });

    await expectCoded(
      withTx(fixture.schoolId, teacherUserId, (tx) =>
        correctAttendanceRecord(tx, fixture.schoolId, teacherUserId, false, seeded.recordId, {
          status: "present",
          reason: "Retroactive fix requested by the student.",
        }),
      ),
      403,
      "ATTENDANCE_CORRECTION_WINDOW_EXPIRED",
    );

    const stored = await readRecord(db.sql, fixture.schoolId, seeded.recordId);
    expect(stored.status).toBe("absent");
    expect(stored.version).toBe(1);
    expect(await countVersions(db.sql, seeded.recordId)).toBe(0);
  });

  test("lets a principal correct past the window and flags it as an override", async () => {
    const fixture = await createFullTenant(db.sql);
    const adminUserId = fixture.users.ORG_ADMIN.id;
    const seeded = await seedRecord(fixture, {
      sessionDate: "2026-01-05",
      sessionStatus: "locked",
      status: "absent",
    });

    const corrected = await withTx(fixture.schoolId, adminUserId, (tx) =>
      correctAttendanceRecord(tx, fixture.schoolId, adminUserId, true, seeded.recordId, {
        status: "excused",
        reason: "Attendance appeal upheld by the principal.",
      }),
    );

    expect(corrected.status).toBe("excused");
    expect(corrected.version).toBe(2);
    expect(corrected.out_of_window).toBe(true);

    const [chain] = await db.sql<{ out_of_window: boolean; corrected_by_user_id: string }[]>`
      SELECT out_of_window, corrected_by_user_id
      FROM app.attendance_record_versions
      WHERE attendance_record_id = ${seeded.recordId}::uuid
    `;
    expect(chain!.out_of_window).toBe(true);
    expect(chain!.corrected_by_user_id).toBe(adminUserId);
  });

  test("honours a shortened school window", async () => {
    const fixture = await createFullTenant(db.sql);
    const teacherUserId = fixture.teachers[0]!.userId;
    // One hour from midnight today has already elapsed for any run after 01:00, so the same session
    // that is comfortably inside the 48-hour default falls outside a 1-hour window.
    await setCorrectionWindowHours(fixture.schoolId, 1);
    const seeded = await seedRecord(fixture, {
      sessionDate: "2026-02-10",
      sessionStatus: "submitted",
      status: "absent",
    });

    await expectCoded(
      withTx(fixture.schoolId, teacherUserId, (tx) =>
        correctAttendanceRecord(tx, fixture.schoolId, teacherUserId, false, seeded.recordId, {
          status: "present",
          reason: "Too late under the school's own policy.",
        }),
      ),
      403,
      "ATTENDANCE_CORRECTION_WINDOW_EXPIRED",
    );
  });
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describeDb("correctAttendanceRecord — guards", () => {
  test("404s on an unknown record", async () => {
    const fixture = await createFullTenant(db.sql);
    const teacherUserId = fixture.teachers[0]!.userId;

    await expectCoded(
      withTx(fixture.schoolId, teacherUserId, (tx) =>
        correctAttendanceRecord(tx, fixture.schoolId, teacherUserId, false, crypto.randomUUID(), {
          status: "present",
          reason: "No such record.",
        }),
      ),
      404,
      "ATTENDANCE_RECORD_NOT_FOUND",
    );
  });

  test.each<AttendanceSessionStatus>(["draft", "open", "cancelled"])(
    "409s when the session is still '%s'",
    async (sessionStatus) => {
      const fixture = await createFullTenant(db.sql);
      const teacherUserId = fixture.teachers[0]!.userId;
      const seeded = await seedRecord(fixture, {
        sessionDate: today(),
        sessionStatus,
        status: "absent",
      });

      await expectCoded(
        withTx(fixture.schoolId, teacherUserId, (tx) =>
          correctAttendanceRecord(tx, fixture.schoolId, teacherUserId, false, seeded.recordId, {
            status: "present",
            reason: "The session has not been submitted yet.",
          }),
        ),
        409,
        "ATTENDANCE_CORRECTION_NOT_CORRECTABLE",
      );
    },
  );

  test("403s for a caller who can read the record but neither teaches the class nor administers the school", async () => {
    const fixture = await createFullTenant(db.sql);
    // The student the record is about. role_scope_visibility lets them read both their own record
    // and the session of a class they are enrolled in, so the row resolves and the class-scope
    // assertion is the only thing left between them and rewriting their own attendance. This is the
    // layer the permission guard on the route does not provide: two independent checks, not one
    // check reached twice.
    const studentUserId = fixture.students[0]!.userId;
    const seeded = await seedRecord(fixture, {
      sessionDate: today(),
      sessionStatus: "submitted",
      status: "absent",
    });

    await expectCoded(
      withTx(fixture.schoolId, studentUserId, (tx) =>
        correctAttendanceRecord(tx, fixture.schoolId, studentUserId, false, seeded.recordId, {
          status: "present",
          reason: "Marking myself present.",
        }),
      ),
      403,
      "ATTENDANCE_RECORD_FORBIDDEN",
    );

    const stored = await readRecord(db.sql, fixture.schoolId, seeded.recordId);
    expect(stored.status).toBe("absent");
    expect(stored.version).toBe(1);
  });

  test("404s, rather than 403s, for a teacher with no sight of the student at all", async () => {
    // Not a weaker guard than the case above — a stronger one. An unrelated teacher fails the
    // role_scope_visibility SELECT policy, so the record does not resolve and the response cannot
    // be used to confirm that it exists.
    const fixture = await createFullTenant(db.sql);
    const outsider = await createTeacher(db.sql, fixture.schoolId, {
      email: `outsider@test-${fixture.schoolSlug}.local`,
    });
    const seeded = await seedRecord(fixture, {
      sessionDate: today(),
      sessionStatus: "submitted",
      status: "absent",
    });

    await expectCoded(
      withTx(fixture.schoolId, outsider.userId, (tx) =>
        correctAttendanceRecord(tx, fixture.schoolId, outsider.userId, false, seeded.recordId, {
          status: "present",
          reason: "Not my class.",
        }),
      ),
      404,
      "ATTENDANCE_RECORD_NOT_FOUND",
    );
  });

  test("409s when the correction would change nothing", async () => {
    const fixture = await createFullTenant(db.sql);
    const teacherUserId = fixture.teachers[0]!.userId;
    const seeded = await seedRecord(fixture, {
      sessionDate: today(),
      sessionStatus: "submitted",
      status: "present",
    });

    await expectCoded(
      withTx(fixture.schoolId, teacherUserId, (tx) =>
        correctAttendanceRecord(tx, fixture.schoolId, teacherUserId, false, seeded.recordId, {
          status: "present",
          reason: "Replay of an already-applied correction.",
        }),
      ),
      409,
      "ATTENDANCE_CORRECTION_NO_CHANGE",
    );
  });
});

// ---------------------------------------------------------------------------
// Immutability and audit
// ---------------------------------------------------------------------------

describeDb("the version chain is append-only", () => {
  test("studafy_app may not update or delete a chain row", async () => {
    const fixture = await createFullTenant(db.sql);
    const teacherUserId = fixture.teachers[0]!.userId;
    const seeded = await seedRecord(fixture, {
      sessionDate: today(),
      sessionStatus: "submitted",
      status: "absent",
    });

    await withTx(fixture.schoolId, teacherUserId, (tx) =>
      correctAttendanceRecord(tx, fixture.schoolId, teacherUserId, false, seeded.recordId, {
        status: "present",
        reason: "Original justification, which must survive any later tampering.",
      }),
    );

    await expectDenied(
      fixture.schoolId,
      teacherUserId,
      `UPDATE app.attendance_record_versions SET reason = 'rewritten'
         WHERE attendance_record_id = '${seeded.recordId}'::uuid`,
    );

    await expectDenied(
      fixture.schoolId,
      teacherUserId,
      `DELETE FROM app.attendance_record_versions
         WHERE attendance_record_id = '${seeded.recordId}'::uuid`,
    );

    const [chain] = await db.sql<{ reason: string }[]>`
      SELECT reason FROM app.attendance_record_versions
      WHERE attendance_record_id = ${seeded.recordId}::uuid
    `;
    expect(chain!.reason).toBe("Original justification, which must survive any later tampering.");
  });

  test("records the before and after states in audit_logs", async () => {
    const fixture = await createFullTenant(db.sql);
    const teacherUserId = fixture.teachers[0]!.userId;
    const seeded = await seedRecord(fixture, {
      sessionDate: today(),
      sessionStatus: "submitted",
      status: "absent",
    });

    await withTx(fixture.schoolId, teacherUserId, (tx) =>
      correctAttendanceRecord(tx, fixture.schoolId, teacherUserId, false, seeded.recordId, {
        status: "present",
        reason: "Register misread.",
      }),
    );

    const [entry] = await db.sql<
      {
        action: string;
        actor_id: string;
        old_values: Record<string, unknown>;
        new_values: Record<string, unknown>;
      }[]
    >`
      SELECT action::text AS action, actor_id, old_values, new_values
      FROM app.audit_logs
      WHERE target_table = 'attendance_records' AND target_id = ${seeded.recordId}::uuid
    `;

    expect(entry!.action).toBe("update");
    expect(entry!.actor_id).toBe(teacherUserId);
    expect(entry!.old_values.status).toBe("absent");
    expect(entry!.old_values.version).toBe(1);
    expect(entry!.new_values.status).toBe("present");
    expect(entry!.new_values.version).toBe(2);
    expect(entry!.new_values.reason).toBe("Register misread.");
    expect(entry!.new_values.out_of_window).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describeDb("getAttendanceRecordHistory", () => {
  test("an uncorrected record reports a single synthesized genesis entry", async () => {
    const fixture = await createFullTenant(db.sql);
    const teacherUserId = fixture.teachers[0]!.userId;
    const seeded = await seedRecord(fixture, {
      sessionDate: today(),
      sessionStatus: "submitted",
      status: "late",
      minutesLate: 7,
    });

    const history = await withTx(fixture.schoolId, teacherUserId, (tx) =>
      getAttendanceRecordHistory(tx, fixture.schoolId, seeded.recordId),
    );

    expect(history.record_id).toBe(seeded.recordId);
    expect(history.student_id).toBe(seeded.studentId);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({
      version: 1,
      status: "late",
      previous_status: null,
      minutes_late: 7,
      reason: null,
      corrected_by_user_id: teacherUserId,
      out_of_window: false,
    });
  });

  test("returns the genesis entry followed by every correction, oldest first", async () => {
    const fixture = await createFullTenant(db.sql);
    const teacherUserId = fixture.teachers[0]!.userId;
    const adminUserId = fixture.users.ORG_ADMIN.id;
    const seeded = await seedRecord(fixture, {
      sessionDate: today(),
      sessionStatus: "submitted",
      status: "absent",
    });

    await withTx(fixture.schoolId, teacherUserId, (tx) =>
      correctAttendanceRecord(tx, fixture.schoolId, teacherUserId, false, seeded.recordId, {
        status: "excused",
        reason: "Parent called in the absence.",
      }),
    );
    await withTx(fixture.schoolId, adminUserId, (tx) =>
      correctAttendanceRecord(tx, fixture.schoolId, adminUserId, true, seeded.recordId, {
        status: "present",
        reason: "Gate log shows the student did attend.",
      }),
    );

    const history = await withTx(fixture.schoolId, teacherUserId, (tx) =>
      getAttendanceRecordHistory(tx, fixture.schoolId, seeded.recordId),
    );

    expect(history.entries.map((entry) => entry.version)).toEqual([1, 2, 3]);
    // The genesis status is reconstructed from what the earliest correction replaced.
    expect(history.entries[0]).toMatchObject({
      version: 1,
      status: "absent",
      previous_status: null,
      reason: null,
      corrected_by_user_id: teacherUserId,
    });
    expect(history.entries[1]).toMatchObject({
      version: 2,
      status: "excused",
      previous_status: "absent",
      reason: "Parent called in the absence.",
      corrected_by_user_id: teacherUserId,
    });
    expect(history.entries[2]).toMatchObject({
      version: 3,
      status: "present",
      previous_status: "excused",
      reason: "Gate log shows the student did attend.",
      corrected_by_user_id: adminUserId,
    });
  });

  test("404s on an unknown record", async () => {
    const fixture = await createFullTenant(db.sql);
    const teacherUserId = fixture.teachers[0]!.userId;

    await expectCoded(
      withTx(fixture.schoolId, teacherUserId, (tx) =>
        getAttendanceRecordHistory(tx, fixture.schoolId, crypto.randomUUID()),
      ),
      404,
      "ATTENDANCE_RECORD_NOT_FOUND",
    );
  });
});
