/**
 * Attendance corrections (ST-109).
 *
 * Amending a submitted attendance record is a three-write operation held in one transaction: the
 * record moves to its next generation, the chain gains an immutable row describing the move, and
 * the audit log gains the before/after diff. Nothing overwrites history — app.attendance_records
 * carries only the current state, and every state it ever held is reachable through
 * app.attendance_record_versions.
 *
 * Who may correct is answered in two places, deliberately. The permission matrix decides whether a
 * caller may correct at all and whether they may do so past the school's correction window; the
 * database decides whether they are anywhere near this class, through the same
 * app.teaches_class helper the RLS policies call. Neither check subsumes the other: a principal
 * holds the override permission but still may not touch a class in another tenant, and an
 * instructor may teach the class but still be refused once the window has closed.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { emitAuditLog } from "../../../middleware/auditEmitter";

import type { AttendanceSessionStatus, AttendanceStatus } from "../schemas";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Applied when a school has no settings row yet. app.school_settings rows are created lazily on
 * first read of the settings endpoint, so a school that has never opened that page has no row at
 * all — and a missing row must not mean "no window" in either direction.
 */
export const DEFAULT_CORRECTION_WINDOW_HOURS = 48;

/** A session must have reached one of these before its records can be corrected. */
const CORRECTABLE_SESSION_STATUSES: ReadonlySet<AttendanceSessionStatus> = new Set([
  "submitted",
  "locked",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CorrectAttendanceRecordParams {
  status: AttendanceStatus;
  minutes_late?: number | null;
  reason: string;
}

export interface CorrectedAttendanceRecordRow {
  id: string;
  school_id: string;
  attendance_session_id: string;
  student_id: string;
  status: AttendanceStatus;
  minutes_late: number | null;
  reason: string | null;
  recorded_by_user_id: string | null;
  version: number;
  out_of_window: boolean;
  /**
   * The parent session's business date. Carried out so the route can enqueue the ST-110 alert job
   * without re-reading the session — a correction to 'absent' can create a threshold breach.
   */
  session_date: string;
  created_at: Date;
  updated_at: Date;
}

export interface AttendanceRecordHistoryEntryRow {
  version: number;
  status: AttendanceStatus;
  previous_status: AttendanceStatus | null;
  minutes_late: number | null;
  reason: string | null;
  corrected_by_user_id: string | null;
  corrected_at: Date;
  out_of_window: boolean;
}

export interface AttendanceRecordHistoryRow {
  record_id: string;
  student_id: string;
  attendance_session_id: string;
  entries: AttendanceRecordHistoryEntryRow[];
}

/** The record joined to the context needed to authorize and time-bound a correction. */
interface CorrectionSubject {
  id: string;
  created_at: Date;
  version: number;
  status: AttendanceStatus;
  minutes_late: number | null;
  student_id: string;
  attendance_session_id: string;
  class_id: string;
  session_date: string;
  session_status: AttendanceSessionStatus;
  in_window: boolean;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The school's correction window, in hours.
 *
 * Exported for the settings surface and tests; the correction path itself folds this into its
 * single subject query rather than paying a second round trip for it.
 */
export async function getCorrectionWindowHours(
  tx: TransactionSql,
  schoolId: string,
): Promise<number> {
  const [row] = await tx<{ hours: number | null }[]>`
    SELECT attendance_correction_window_hours AS hours
    FROM app.school_settings
    WHERE school_id = ${schoolId}::uuid
  `;
  return row?.hours ?? DEFAULT_CORRECTION_WINDOW_HOURS;
}

/**
 * Load the record together with everything needed to decide the correction.
 *
 * The window comparison runs in SQL rather than in TypeScript because it needs three things the
 * application does not hold: the database's clock, the school's timezone, and the session's
 * business date. Anchoring to midnight of session_date in the school's own timezone gives every
 * record of a session the same deadline, which is what a teacher expects when they are told
 * "you have 48 hours"; anchoring to each row's created_at would instead give the same session
 * several deadlines depending on how the roster was submitted.
 */
async function loadCorrectionSubject(
  tx: TransactionSql,
  schoolId: string,
  recordId: string,
): Promise<CorrectionSubject | undefined> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT
      r.id,
      r.created_at,
      r.version,
      r.status::text          AS status,
      r.minutes_late,
      r.student_id,
      r.attendance_session_id,
      s.class_id,
      s.session_date::text    AS session_date,
      s.status::text          AS session_status,
      CURRENT_TIMESTAMP < (
        (s.session_date::timestamp AT TIME ZONE COALESCE(st.timezone, 'Africa/Casablanca'))
        + make_interval(
            hours => COALESCE(
              st.attendance_correction_window_hours,
              ${DEFAULT_CORRECTION_WINDOW_HOURS}
            )
          )
      )                       AS in_window
    FROM app.attendance_records AS r
    JOIN app.attendance_sessions AS s
      ON s.id = r.attendance_session_id
     AND s.school_id = r.school_id
     AND s.created_at = r.session_created_at
    LEFT JOIN app.school_settings AS st
      ON st.school_id = r.school_id
    WHERE r.id = ${recordId}::uuid
      AND r.school_id = ${schoolId}::uuid
  `;

  if (!row) return undefined;

  return {
    id: row.id as string,
    created_at: row.created_at as Date,
    version: row.version as number,
    status: row.status as AttendanceStatus,
    minutes_late: row.minutes_late as number | null,
    student_id: row.student_id as string,
    attendance_session_id: row.attendance_session_id as string,
    class_id: row.class_id as string,
    session_date: row.session_date as string,
    session_status: row.session_status as AttendanceSessionStatus,
    in_window: row.in_window as boolean,
  };
}

// ---------------------------------------------------------------------------
// Correction
// ---------------------------------------------------------------------------

/**
 * Apply a correction to a single attendance record.
 *
 * `canOverride` is the caller's ATTENDANCE_CORRECTION_OVERRIDE permission, resolved by the route.
 * It is passed in rather than read from a role here so this service never learns what a role is —
 * the permission matrix stays the only place that mapping lives.
 */
export async function correctAttendanceRecord(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  canOverride: boolean,
  recordId: string,
  params: CorrectAttendanceRecordParams,
): Promise<CorrectedAttendanceRecordRow> {
  // 1. Load the record with its session and the school's window.
  const subject = await loadCorrectionSubject(tx, schoolId, recordId);
  if (!subject) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.ATTENDANCE_RECORD_NOT_FOUND,
      "Attendance record not found",
    );
  }

  // 2. Only a submitted or locked session holds records worth correcting. A draft or open session
  //    is still being taken, and POST /api/attendance/records/batch owns that state.
  if (!CORRECTABLE_SESSION_STATUSES.has(subject.session_status)) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.ATTENDANCE_CORRECTION_NOT_CORRECTABLE,
      `Attendance session is '${subject.session_status}'; corrections apply to 'submitted' or 'locked' sessions`,
    );
  }

  // 3. Class scope, delegated to the same helpers the RLS policies use.
  const [scope] = await tx<{ allowed: boolean }[]>`
    SELECT (
      app.current_user_is_school_admin()
      OR app.teaches_class(${subject.class_id}::uuid)
    ) AS allowed
  `;
  if (!scope?.allowed) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.ATTENDANCE_RECORD_FORBIDDEN,
      "You are not assigned to this class",
    );
  }

  // 4. Conditional field rules, matching recordAttendanceBatch: minutes_late belongs to 'late' and
  //    nowhere else, so it is required there and discarded everywhere else rather than silently
  //    carried over from the status being replaced.
  if (params.status === "late" && (params.minutes_late == null || params.minutes_late < 1)) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "minutes_late is required and must be >= 1 when status is 'late'",
    );
  }
  const nextMinutesLate = params.status === "late" ? (params.minutes_late ?? null) : null;

  // 5. A correction that changes nothing is a client bug, not a version. Rejecting it also makes a
  //    duplicate submission safe: the replay sees the state its predecessor produced and stops,
  //    rather than appending an identical generation.
  if (params.status === subject.status && nextMinutesLate === subject.minutes_late) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.ATTENDANCE_CORRECTION_NO_CHANGE,
      "The correction matches the current attendance record",
    );
  }

  // 6. Window. Past it, an instructor is refused outright and a principal proceeds on the record.
  const outOfWindow = !subject.in_window;
  if (outOfWindow && !canOverride) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.ATTENDANCE_CORRECTION_WINDOW_EXPIRED,
      "The correction window for this attendance record has closed",
    );
  }

  const nextVersion = subject.version + 1;

  // 7. Advance the record. All three of id, school_id and created_at are matched: created_at is the
  //    partition key and id alone is not unique across app.attendance_records.
  const [updated] = await tx<Record<string, unknown>[]>`
    UPDATE app.attendance_records
    SET status = ${params.status}::app.attendance_status,
        minutes_late = ${nextMinutesLate}::smallint,
        version = ${nextVersion},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${subject.id}::uuid
      AND school_id = ${schoolId}::uuid
      AND created_at = ${subject.created_at}
    RETURNING
      id, school_id, attendance_session_id, student_id,
      status::text AS status, minutes_late, reason,
      recorded_by_user_id, version, created_at, updated_at
  `;

  if (!updated) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.ATTENDANCE_RECORD_NOT_FOUND,
      "Attendance record not found",
    );
  }

  // 8. Append the immutable chain entry.
  await tx`
    INSERT INTO app.attendance_record_versions (
      school_id, attendance_record_id, record_created_at, student_id, version,
      previous_status, new_status, previous_minutes_late, new_minutes_late,
      reason, corrected_by_user_id, out_of_window
    ) VALUES (
      ${schoolId}::uuid,
      ${subject.id}::uuid,
      ${subject.created_at},
      ${subject.student_id}::uuid,
      ${nextVersion},
      ${subject.status}::app.attendance_status,
      ${params.status}::app.attendance_status,
      ${subject.minutes_late}::smallint,
      ${nextMinutesLate}::smallint,
      ${params.reason},
      ${userId}::uuid,
      ${outOfWindow}
    )
  `;

  // 9. Audit the diff.
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "attendance_records",
    targetId: subject.id,
    oldValues: {
      status: subject.status,
      minutes_late: subject.minutes_late,
      version: subject.version,
    },
    newValues: {
      status: params.status,
      minutes_late: nextMinutesLate,
      version: nextVersion,
      reason: params.reason,
      out_of_window: outOfWindow,
      student_id: subject.student_id,
      class_id: subject.class_id,
    },
  });

  return {
    id: updated.id as string,
    school_id: updated.school_id as string,
    attendance_session_id: updated.attendance_session_id as string,
    student_id: updated.student_id as string,
    status: updated.status as AttendanceStatus,
    minutes_late: updated.minutes_late as number | null,
    reason: updated.reason as string | null,
    recorded_by_user_id: updated.recorded_by_user_id as string | null,
    version: updated.version as number,
    out_of_window: outOfWindow,
    session_date: subject.session_date,
    created_at: updated.created_at as Date,
    updated_at: updated.updated_at as Date,
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * The full correction chain for a record, oldest first.
 *
 * Generation 1 — the record as first submitted — is reconstructed rather than stored. Its status is
 * whatever the earliest correction replaced, its actor is whoever recorded the entry, and its
 * timestamp is the record's creation. Storing it instead would mean writing a chain row for every
 * student on every roster, turning the batch-record hot path into two inserts per student to
 * describe something the record already knows.
 */
export async function getAttendanceRecordHistory(
  tx: TransactionSql,
  schoolId: string,
  recordId: string,
): Promise<AttendanceRecordHistoryRow> {
  const [record] = await tx<Record<string, unknown>[]>`
    SELECT
      id, student_id, attendance_session_id,
      status::text AS status, minutes_late, recorded_by_user_id, created_at
    FROM app.attendance_records
    WHERE id = ${recordId}::uuid
      AND school_id = ${schoolId}::uuid
  `;

  if (!record) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.ATTENDANCE_RECORD_NOT_FOUND,
      "Attendance record not found",
    );
  }

  const versions = await tx<Record<string, unknown>[]>`
    SELECT
      version,
      previous_status::text AS previous_status,
      new_status::text      AS new_status,
      previous_minutes_late,
      new_minutes_late,
      reason,
      corrected_by_user_id,
      corrected_at,
      out_of_window
    FROM app.attendance_record_versions
    WHERE school_id = ${schoolId}::uuid
      AND attendance_record_id = ${recordId}::uuid
    ORDER BY version ASC
  `;

  const first = versions[0];

  const genesis: AttendanceRecordHistoryEntryRow = {
    version: 1,
    // What the earliest correction replaced is, by definition, the original. With no corrections
    // the record has never moved, so its current state is its original one.
    status: first
      ? (first.previous_status as AttendanceStatus)
      : (record.status as AttendanceStatus),
    previous_status: null,
    minutes_late: first
      ? (first.previous_minutes_late as number | null)
      : (record.minutes_late as number | null),
    reason: null,
    corrected_by_user_id: record.recorded_by_user_id as string | null,
    corrected_at: record.created_at as Date,
    out_of_window: false,
  };

  const corrections: AttendanceRecordHistoryEntryRow[] = versions.map((row) => ({
    version: row.version as number,
    status: row.new_status as AttendanceStatus,
    previous_status: row.previous_status as AttendanceStatus,
    minutes_late: row.new_minutes_late as number | null,
    reason: row.reason as string,
    corrected_by_user_id: row.corrected_by_user_id as string,
    corrected_at: row.corrected_at as Date,
    out_of_window: row.out_of_window as boolean,
  }));

  return {
    record_id: record.id as string,
    student_id: record.student_id as string,
    attendance_session_id: record.attendance_session_id as string,
    entries: [genesis, ...corrections],
  };
}
