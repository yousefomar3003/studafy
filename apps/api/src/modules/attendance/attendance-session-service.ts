import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import type { AttendanceSessionStatus, AttendanceStatus } from "./schemas";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AttendanceSessionRow {
  id: string;
  school_id: string;
  class_id: string;
  session_date: string;
  period: number | null;
  status: AttendanceSessionStatus;
  taken_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface OpenSessionParams {
  class_id: string;
  session_date: string;
  period?: number;
}

export interface ListSessionsParams {
  limit: number;
  offset: number;
  class_id?: string;
  session_date?: string;
}

export interface UpdateSessionStatusParams {
  status: AttendanceSessionStatus;
}

// ---------------------------------------------------------------------------
// Valid status transitions
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  draft: new Set(["open", "cancelled"]),
  open: new Set(["submitted", "cancelled"]),
  submitted: new Set(["locked"]),
  locked: new Set(),
  cancelled: new Set(),
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const SESSION_COLUMNS = `
  id, school_id, class_id, session_date::text AS session_date, period,
  status::text AS status, taken_by_user_id, created_at, updated_at
`;

function parseSessionRow(row: Record<string, unknown>): AttendanceSessionRow {
  return {
    id: row.id as string,
    school_id: row.school_id as string,
    class_id: row.class_id as string,
    session_date: row.session_date as string,
    period: row.period as number | null,
    status: row.status as AttendanceSessionStatus,
    taken_by_user_id: row.taken_by_user_id as string | null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

async function findExistingSession(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
  sessionDate: string,
  period: number | null,
): Promise<AttendanceSessionRow | undefined> {
  const [row] = await tx`
    SELECT k.attendance_session_id, k.session_created_at
    FROM app.attendance_session_keys k
    WHERE k.school_id = ${schoolId}
      AND k.class_id = ${classId}
      AND k.session_date = ${sessionDate}::date
      AND k.period IS NOT DISTINCT FROM ${period}::smallint
  `;

  if (!row) return undefined;

  const [session] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(SESSION_COLUMNS)}
    FROM app.attendance_sessions
    WHERE id = ${row.attendance_session_id}
      AND school_id = ${schoolId}
      AND created_at = ${row.session_created_at}
  `;

  return session ? parseSessionRow(session) : undefined;
}

async function validateTimetableSlot(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
  sessionDate: string,
  period: number,
): Promise<boolean> {
  const [match] = await tx<{ exists: number }[]>`
    SELECT 1 AS exists
    FROM app.timetable_slots ts
    JOIN app.timetable_versions tv
      ON tv.id = ts.timetable_version_id AND tv.school_id = ts.school_id
    WHERE ts.school_id = ${schoolId}
      AND ts.class_id = ${classId}
      AND ts.weekday = EXTRACT(ISODOW FROM ${sessionDate}::date)::smallint
      AND ts.period = ${period}::smallint
      AND tv.status = 'approved'
    LIMIT 1
  `;

  return Boolean(match);
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Open an attendance session for a class on a given date and period.
 *
 * Idempotent: if a session already exists for (school_id, class_id, session_date, period),
 * the existing session is returned instead of creating a duplicate.
 *
 * When period is provided, validates that a matching approved timetable slot exists.
 * When period is null (daily attendance mode), timetable validation is skipped.
 */
export async function openAttendanceSession(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  params: OpenSessionParams,
): Promise<{ session: AttendanceSessionRow; created: boolean }> {
  const period = params.period ?? null;

  // Idempotent: return existing if one already covers this class/date/period.
  const existing = await findExistingSession(
    tx,
    schoolId,
    params.class_id,
    params.session_date,
    period,
  );
  if (existing) {
    return { session: existing, created: false };
  }

  // Validate timetable slot exists for this class, weekday, and period.
  if (period != null) {
    const hasSlot = await validateTimetableSlot(
      tx,
      schoolId,
      params.class_id,
      params.session_date,
      period,
    );
    if (!hasSlot) {
      throw new CodedHttpException(
        404,
        ERROR_CODES.ATTENDANCE_NO_TIMETABLE_SLOT,
        "No approved timetable slot found for this class, date, and period",
      );
    }
  }

  // Validate class exists within this school.
  const [classRow] = await tx<{ id: string }[]>`
    SELECT id FROM app.classes
    WHERE id = ${params.class_id} AND school_id = ${schoolId}
  `;
  if (!classRow) {
    throw new HTTPException(404, { message: "Class not found" });
  }

  const [row] = await tx<Record<string, unknown>[]>`
    INSERT INTO app.attendance_sessions
      (school_id, class_id, session_date, period, status, taken_by_user_id)
    VALUES
      (${schoolId}, ${params.class_id}, ${params.session_date}::date,
       ${period}::smallint, 'open', ${userId}::uuid)
    RETURNING ${tx.unsafe(SESSION_COLUMNS)}
  `;

  if (!row) {
    throw new HTTPException(500, { message: "Failed to create attendance session" });
  }

  const session = parseSessionRow(row);

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "attendance_sessions",
    targetId: session.id,
    newValues: {
      class_id: params.class_id,
      session_date: params.session_date,
      period: params.period ?? null,
      status: "open",
    },
  });

  return { session, created: true };
}

/**
 * List attendance sessions for the school, optionally filtered by class and/or date.
 */
export async function listAttendanceSessions(
  tx: TransactionSql,
  schoolId: string,
  params: ListSessionsParams,
): Promise<{ rows: AttendanceSessionRow[]; total: number }> {
  const classFilter = params.class_id ? tx` AND s.class_id = ${params.class_id}` : tx``;

  const dateFilter = params.session_date
    ? tx` AND s.session_date = ${params.session_date}::date`
    : tx``;

  const [rows, countResult] = await Promise.all([
    tx<Record<string, unknown>[]>`
      SELECT ${tx.unsafe(SESSION_COLUMNS)}
      FROM app.attendance_sessions s
      WHERE s.school_id = ${schoolId}
        ${classFilter}
        ${dateFilter}
      ORDER BY s.session_date DESC, s.id DESC
      LIMIT ${params.limit}
      OFFSET ${params.offset}
    `,
    tx<{ count: string }[]>`
      SELECT count(*)::int AS count
      FROM app.attendance_sessions s
      WHERE s.school_id = ${schoolId}
        ${classFilter}
        ${dateFilter}
    `,
  ]);

  return {
    rows: rows.map(parseSessionRow),
    total: Number(countResult[0]?.count ?? 0),
  };
}

/**
 * Get a single attendance session by ID.
 */
export async function getAttendanceSession(
  tx: TransactionSql,
  schoolId: string,
  sessionId: string,
): Promise<AttendanceSessionRow | undefined> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(SESSION_COLUMNS)}
    FROM app.attendance_sessions
    WHERE id = ${sessionId} AND school_id = ${schoolId}
  `;

  return row ? parseSessionRow(row) : undefined;
}

/**
 * Update an attendance session's status.
 *
 * Enforces valid state transitions:
 *   draft → open | cancelled
 *   open → submitted | cancelled
 *   submitted → locked
 *   locked → (terminal)
 *   cancelled → (terminal)
 */
export async function updateAttendanceSessionStatus(
  tx: TransactionSql,
  schoolId: string,
  sessionId: string,
  params: UpdateSessionStatusParams,
): Promise<AttendanceSessionRow> {
  const existing = await getAttendanceSession(tx, schoolId, sessionId);
  if (!existing) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.ATTENDANCE_SESSION_NOT_FOUND,
      "Attendance session not found",
    );
  }

  const allowed = VALID_TRANSITIONS[existing.status];
  if (!allowed || !allowed.has(params.status)) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.ATTENDANCE_INVALID_STATUS_TRANSITION,
      `Cannot transition attendance session from '${existing.status}' to '${params.status}'`,
    );
  }

  const [row] = await tx<Record<string, unknown>[]>`
    UPDATE app.attendance_sessions
    SET status = ${params.status}::app.attendance_session_status,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${sessionId} AND school_id = ${schoolId}
    RETURNING ${tx.unsafe(SESSION_COLUMNS)}
  `;

  if (!row) {
    throw new HTTPException(404, { message: "Attendance session not found" });
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "attendance_sessions",
    targetId: sessionId,
    oldValues: { status: existing.status },
    newValues: { status: params.status },
  });

  return parseSessionRow(row);
}

// ---------------------------------------------------------------------------
// Attendance Records (batch)
// ---------------------------------------------------------------------------

export interface BatchRecordItem {
  student_id: string;
  status: AttendanceStatus;
  minutes_late?: number;
  reason?: string;
}

export interface BatchRecordAttendanceParams {
  attendance_session_id: string;
  records: BatchRecordItem[];
}

export interface AttendanceRecordRow {
  id: string;
  school_id: string;
  attendance_session_id: string;
  student_id: string;
  status: AttendanceStatus;
  minutes_late: number | null;
  reason: string | null;
  recorded_by_user_id: string | null;
  created_at: Date;
}

export interface BatchRecordAttendanceResult {
  records: AttendanceRecordRow[];
  created_count: number;
  /**
   * The session's business date. Returned so the route can enqueue the ST-110 alert job without a
   * second round trip — the session is already loaded here to validate the batch.
   */
  session_date: string;
}

const RECORD_COLUMNS = `
  id, school_id, attendance_session_id, student_id,
  status::text AS status, minutes_late, reason,
  recorded_by_user_id, created_at
`;

function parseRecordRow(row: Record<string, unknown>): AttendanceRecordRow {
  return {
    id: row.id as string,
    school_id: row.school_id as string,
    attendance_session_id: row.attendance_session_id as string,
    student_id: row.student_id as string,
    status: row.status as AttendanceStatus,
    minutes_late: row.minutes_late as number | null,
    reason: row.reason as string | null,
    recorded_by_user_id: row.recorded_by_user_id as string | null,
    created_at: row.created_at as Date,
  };
}

/**
 * The register roster for a class: its actively enrolled students with display names only --
 * what taking attendance needs, nothing of the student profile (`/api/students` stays web-only for
 * that reason). Null when the class does not exist or the caller cannot see it. RLS narrows both
 * reads to the caller's own classes and students, or the whole school for an admin or attendance
 * officer (migration 000133).
 */
export async function listClassRoster(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
): Promise<{ id: string; name: string }[] | null> {
  const [klass] = await tx<{ id: string }[]>`
    SELECT id FROM app.classes WHERE id = ${classId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!klass) return null;

  return tx<{ id: string; name: string }[]>`
    SELECT s.id,
           concat_ws(' ', coalesce(s.preferred_name, s.first_name), s.last_name) AS name
    FROM app.enrollments AS e
    JOIN app.students AS s ON s.id = e.student_id AND s.school_id = e.school_id
    WHERE e.school_id = ${schoolId}::uuid
      AND e.class_id = ${classId}::uuid
      AND e.status = 'active'
    ORDER BY lower(coalesce(s.preferred_name, s.first_name)), lower(s.last_name), s.id
  `;
}

/**
 * Every record already taken in one session, ordered by student. Null when the session does not
 * exist or the caller cannot see it -- RLS (role_scope_visibility on attendance_sessions/_records)
 * narrows both reads to the caller's classes, or the whole school for an admin or attendance officer.
 */
export async function listSessionRecords(
  tx: TransactionSql,
  schoolId: string,
  sessionId: string,
): Promise<AttendanceRecordRow[] | null> {
  const session = await getAttendanceSession(tx, schoolId, sessionId);
  if (!session) return null;

  const rows = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(RECORD_COLUMNS)}
    FROM app.attendance_records
    WHERE attendance_session_id = ${sessionId}::uuid
      AND school_id = ${schoolId}::uuid
    ORDER BY student_id
  `;
  return rows.map(parseRecordRow);
}

export interface StudentAttendanceEntry {
  id: string;
  attendance_session_id: string;
  session_date: string;
  period: number | null;
  class_id: string;
  class_code: string;
  status: AttendanceStatus;
  minutes_late: number | null;
  reason: string | null;
}

/**
 * One student's attendance records for sessions dated within [startDate, endDate], newest first.
 *
 * Read under the caller's row scope: records scope by student and sessions by class, so a teacher
 * sees only the sessions of classes they teach, while the attendance officer, principal and school
 * admin see every class. A student the caller cannot see yields an empty list, not an error.
 */
export async function listStudentAttendance(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  startDate: string,
  endDate: string,
): Promise<StudentAttendanceEntry[]> {
  const rows = await tx<Record<string, unknown>[]>`
    SELECT r.id, r.attendance_session_id, s.session_date::text AS session_date, s.period,
           s.class_id, c.code AS class_code, r.status::text AS status, r.minutes_late, r.reason
    FROM app.attendance_records r
    JOIN app.attendance_sessions s
      ON s.id = r.attendance_session_id AND s.school_id = r.school_id
    JOIN app.classes c ON c.id = s.class_id AND c.school_id = s.school_id
    WHERE r.school_id = ${schoolId}::uuid
      AND r.student_id = ${studentId}::uuid
      AND s.session_date BETWEEN ${startDate}::date AND ${endDate}::date
      AND s.status <> 'cancelled'
    ORDER BY s.session_date DESC, s.period NULLS FIRST, c.code
  `;
  return rows.map((row) => ({
    id: row.id as string,
    attendance_session_id: row.attendance_session_id as string,
    session_date: row.session_date as string,
    period: row.period === null ? null : Number(row.period),
    class_id: row.class_id as string,
    class_code: row.class_code as string,
    status: row.status as AttendanceStatus,
    minutes_late: row.minutes_late === null ? null : Number(row.minutes_late),
    reason: (row.reason as string | null) ?? null,
  }));
}

/**
 * Record attendance for multiple students in a single call.
 *
 * Idempotent: records that already exist for (session_id, student_id) are
 * silently skipped.  The response always reflects the full set of records
 * for the session regardless of how many were actually inserted.
 *
 * Scope is enforced: the caller must be a school admin, the teacher of the
 * class this session belongs to, or the school's attendance officer.
 */
export async function recordAttendanceBatch(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  params: BatchRecordAttendanceParams,
): Promise<BatchRecordAttendanceResult> {
  // 1. Fetch session and validate it exists, is open, and belongs to this school.
  const [session] = await tx<Record<string, unknown>[]>`
    SELECT id, class_id, status::text AS status, created_at, session_date::text AS session_date
    FROM app.attendance_sessions
    WHERE id = ${params.attendance_session_id} AND school_id = ${schoolId}
  `;
  if (!session) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.ATTENDANCE_SESSION_NOT_FOUND,
      "Attendance session not found",
    );
  }
  if (session.status !== "open") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.ATTENDANCE_SESSION_NOT_OPEN,
      `Attendance session is '${session.status}'; only 'open' sessions accept records`,
    );
  }

  // 2. Assert scope: caller must be a school admin, the class's teacher, or the school's
  //    attendance officer (who takes attendance for every class -- migration 000133).
  const classId = session.class_id as string;
  const [auth] = await tx<{ allowed: boolean }[]>`
    SELECT (
      app.current_user_is_school_admin()
      OR app.teaches_class(${classId}::uuid)
      OR app.current_user_is_attendance_officer()
    ) AS allowed
  `;
  if (!auth?.allowed) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.ATTENDANCE_RECORD_FORBIDDEN,
      "You are not assigned to this class",
    );
  }

  // 3. Validate all student_ids are actively enrolled in this class. Enrolment is the roster: a
  //    student's class membership lives in app.enrollments (app.students has no class column -- the
  //    check this replaces filtered on one and failed every batch with an undefined-column error).
  const studentIds = params.records.map((r) => r.student_id);
  const enrolled = await tx<{ id: string }[]>`
    SELECT student_id AS id FROM app.enrollments
    WHERE school_id = ${schoolId}::uuid
      AND class_id = ${classId}::uuid
      AND status = 'active'
      AND student_id = ANY (${studentIds}::uuid[])
  `;
  const enrolledSet = new Set(enrolled.map((r) => r.id));
  for (const sid of studentIds) {
    if (!enrolledSet.has(sid)) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.ATTENDANCE_STUDENT_NOT_IN_CLASS,
        `Student ${sid} is not enrolled in this class`,
      );
    }
  }

  // 4. Validate conditional fields (minutes_late required when status is 'late').
  for (const r of params.records) {
    if (r.status === "late" && (r.minutes_late == null || r.minutes_late < 1)) {
      throw new HTTPException(400, {
        message: `minutes_late is required and must be >= 1 when status is 'late' (student: ${r.student_id})`,
      });
    }
  }

  // 5. Check attendance_record_keys for already-recorded students.
  const existing = await tx<{ student_id: string }[]>`
    SELECT student_id
    FROM app.attendance_record_keys
    WHERE school_id = ${schoolId}
      AND attendance_session_id = ${params.attendance_session_id}
      AND student_id = ANY (${studentIds}::uuid[])
  `;
  const existingSet = new Set(existing.map((r) => r.student_id));
  const newRecords = params.records.filter((r) => !existingSet.has(r.student_id));

  // 6. Single multi-row INSERT for records that don't yet exist.
  if (newRecords.length > 0) {
    const insertable = newRecords.map((r) => ({
      student_id: r.student_id,
      status: r.status,
      minutes_late: r.status === "late" ? (r.minutes_late ?? 0) : null,
      reason: r.reason ?? null,
    }));

    const sessionCreatedAt = session.created_at as Date;
    await tx`
      INSERT INTO app.attendance_records
        (school_id, attendance_session_id, session_created_at, student_id, status, minutes_late, reason, recorded_by_user_id)
      SELECT
        ${schoolId}::uuid,
        ${params.attendance_session_id}::uuid,
        ${sessionCreatedAt}::timestamptz,
        x.student_id,
        x.status::app.attendance_status,
        x.minutes_late::smallint,
        x.reason,
        ${userId}::uuid
      FROM jsonb_to_recordset(${tx.json(insertable)}::jsonb)
        AS x(student_id uuid, status text, minutes_late smallint, reason text)
    `;
  }

  // 7. Fetch the full set of records for the response (includes pre-existing records).
  const allRows = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(RECORD_COLUMNS)}
    FROM app.attendance_records
    WHERE attendance_session_id = ${params.attendance_session_id}
      AND school_id = ${schoolId}
    ORDER BY student_id
  `;

  // 8. Emit single audit log for the batch.
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "attendance_records",
    targetId: params.attendance_session_id,
    newValues: {
      count: newRecords.length,
      session_status: session.status,
      class_id: classId,
      records: newRecords.map((r) => ({
        student_id: r.student_id,
        status: r.status,
      })),
    },
  });

  return {
    records: allRows.map(parseRecordRow),
    created_count: newRecords.length,
    session_date: session.session_date as string,
  };
}
