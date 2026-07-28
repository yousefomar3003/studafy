import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import type { AttendanceSessionStatus } from "./schemas";
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
