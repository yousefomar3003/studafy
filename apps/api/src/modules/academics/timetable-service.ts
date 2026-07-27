import { DOMAIN_EVENTS, ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";
import { emit } from "../../lib/events/emitter";
import { emitAuditLog } from "../../middleware/auditEmitter";

import type { TimetableVersionStatus } from "./schemas";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimetableVersionRow {
  id: string;
  school_id: string;
  academic_year_id: string;
  term_id: string;
  name: string;
  status: TimetableVersionStatus;
  submitted_at: Date | null;
  submitted_by_user_id: string | null;
  approved_at: Date | null;
  approved_by_user_id: string | null;
  rejected_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TimetableSlotRow {
  id: string;
  school_id: string;
  timetable_version_id: string;
  class_id: string;
  teacher_id: string;
  room_id: string;
  weekday: number;
  period: number;
  created_at: Date;
  updated_at: Date;
}

export interface ListVersionsParams {
  limit: number;
  offset: number;
  term_id: string;
  status?: string;
}

export interface ListSlotsParams {
  limit: number;
  offset: number;
}

export interface CreateVersionParams {
  term_id: string;
  academic_year_id: string;
  name: string;
}

export interface UpdateVersionParams {
  name?: string;
}

export interface RejectVersionParams {
  reason?: string | null;
}

export interface CreateSlotParams {
  class_id: string;
  teacher_id: string;
  room_id: string;
  weekday: number;
  period: number;
}

export interface UpdateSlotParams {
  class_id?: string;
  teacher_id?: string;
  room_id?: string;
  weekday?: number;
  period?: number;
}

export interface CopyVersionParams {
  source_version_id: string;
  name: string;
  term_id: string;
  academic_year_id: string;
}

export interface ConflictDetail {
  conflict_type: "teacher" | "room";
  existing_slot_id: string;
  existing_class_code: string;
  entity_id: string;
  entity_name: string;
  weekday: number;
  period: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES = [
  "",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/** PostgreSQL exclusion-violation SQLSTATE. */
const PG_EXCLUSION_VIOLATION = "23P01";

const TEACHER_CONSTRAINT = "ex_timetable_slots_teacher_weekday_period";
const ROOM_CONSTRAINT = "ex_timetable_slots_room_weekday_period";

function isPgExclusionViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as unknown as { code: unknown }).code === PG_EXCLUSION_VIOLATION
  );
}

async function resolveSlotNames(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
  teacherId: string,
  roomId: string,
): Promise<{ classCode: string; teacherName: string; roomName: string }> {
  const [row] = await tx<{ class_code: string; teacher_name: string; room_name: string }[]>`
    SELECT cl.code AS class_code,
           COALESCE(u.display_name, u.email) AS teacher_name,
           r.name AS room_name
    FROM app.classes cl
    JOIN app.teachers t ON t.id = ${teacherId} AND t.school_id = ${schoolId}
    JOIN app.users u ON u.id = t.user_id AND u.school_id = ${schoolId}
    JOIN app.rooms r ON r.id = ${roomId} AND r.school_id = ${schoolId}
    WHERE cl.id = ${classId} AND cl.school_id = ${schoolId}
  `;
  if (!row) {
    return { classCode: "unknown", teacherName: "unknown", roomName: "unknown" };
  }
  return { classCode: row.class_code, teacherName: row.teacher_name, roomName: row.room_name };
}

async function findConflict(
  tx: TransactionSql,
  schoolId: string,
  versionId: string,
  constraint: string,
  params: CreateSlotParams | UpdateSlotParams,
): Promise<ConflictDetail | null> {
  const isTeacher = constraint.includes("teacher");

  const weekday = params.weekday!;
  const period = params.period!;

  if (isTeacher) {
    const [row] = await tx<
      {
        id: string;
        class_code: string;
        teacher_id: string;
        teacher_name: string;
        weekday: number;
        period: number;
      }[]
    >`
      SELECT ts.id,
             cl.code AS class_code,
             t.id AS teacher_id,
             COALESCE(u.display_name, u.email) AS teacher_name,
             ts.weekday, ts.period
      FROM app.timetable_slots ts
      JOIN app.classes cl ON cl.id = ts.class_id AND cl.school_id = ts.school_id
      JOIN app.teachers t ON t.id = ts.teacher_id AND t.school_id = ts.school_id
      JOIN app.users u ON u.id = t.user_id AND u.school_id = ts.school_id
      WHERE ts.timetable_version_id = ${versionId}
        AND ts.school_id = ${schoolId}
        AND ts.teacher_id = ${params.teacher_id!}
        AND ts.weekday = ${weekday}
        AND ts.period = ${period}
      LIMIT 1
    `;
    if (!row) return null;
    return {
      conflict_type: "teacher",
      existing_slot_id: row.id,
      existing_class_code: row.class_code,
      entity_id: row.teacher_id,
      entity_name: row.teacher_name,
      weekday: row.weekday,
      period: row.period,
    };
  }

  const [row] = await tx<
    {
      id: string;
      class_code: string;
      room_id: string;
      room_name: string;
      weekday: number;
      period: number;
    }[]
  >`
    SELECT ts.id,
           cl.code AS class_code,
           r.id AS room_id,
           r.name AS room_name,
           ts.weekday, ts.period
    FROM app.timetable_slots ts
    JOIN app.classes cl ON cl.id = ts.class_id AND cl.school_id = ts.school_id
    JOIN app.rooms r ON r.id = ts.room_id AND r.school_id = ts.school_id
    WHERE ts.timetable_version_id = ${versionId}
      AND ts.school_id = ${schoolId}
      AND ts.room_id = ${params.room_id!}
      AND ts.weekday = ${weekday}
      AND ts.period = ${period}
    LIMIT 1
  `;
  if (!row) return null;
  return {
    conflict_type: "room",
    existing_slot_id: row.id,
    existing_class_code: row.class_code,
    entity_id: row.room_id,
    entity_name: row.room_name,
    weekday: row.weekday,
    period: row.period,
  };
}

function throwConflictError(
  conflict: ConflictDetail,
  _schoolId: string,
  _newClassCode: string,
): never {
  const day = WEEKDAY_NAMES[conflict.weekday] ?? `day ${conflict.weekday}`;
  const periodLabel = `period ${conflict.period}`;
  const label =
    conflict.conflict_type === "teacher"
      ? `Teacher "${conflict.entity_name}"`
      : `Room "${conflict.entity_name}"`;

  const code =
    conflict.conflict_type === "teacher"
      ? ERROR_CODES.TIMETABLE_TEACHER_CONFLICT
      : ERROR_CODES.TIMETABLE_ROOM_CONFLICT;

  throw new CodedHttpException(
    409,
    code,
    `${label} is already scheduled for class "${conflict.existing_class_code}" on ${day} ${periodLabel} in this timetable version`,
  );
}

async function getVersion(
  tx: TransactionSql,
  schoolId: string,
  versionId: string,
): Promise<TimetableVersionRow | undefined> {
  const [row] = await tx<TimetableVersionRow[]>`
    SELECT id, school_id, academic_year_id, term_id, name, status,
           submitted_at, submitted_by_user_id,
           approved_at, approved_by_user_id,
           rejected_reason,
           created_at, updated_at
    FROM app.timetable_versions
    WHERE id = ${versionId} AND school_id = ${schoolId}
  `;
  return row;
}

// ---------------------------------------------------------------------------
// Version queries
// ---------------------------------------------------------------------------

export async function listTimetableVersions(
  tx: TransactionSql,
  schoolId: string,
  params: ListVersionsParams,
): Promise<{ rows: TimetableVersionRow[]; total: number }> {
  const statusFilter = params.status
    ? tx` AND v.status = ${params.status}::app.timetable_version_status`
    : tx``;

  const [rows, countResult] = await Promise.all([
    tx<TimetableVersionRow[]>`
      SELECT v.id, v.school_id, v.academic_year_id, v.term_id, v.name, v.status,
             v.submitted_at, v.submitted_by_user_id,
             v.approved_at, v.approved_by_user_id,
             v.rejected_reason,
             v.created_at, v.updated_at
      FROM app.timetable_versions v
      WHERE v.school_id = ${schoolId}
        AND v.term_id = ${params.term_id}
        ${statusFilter}
      ORDER BY v.created_at DESC
      LIMIT ${params.limit}
      OFFSET ${params.offset}
    `,
    tx<{ count: string }[]>`
      SELECT count(*)::int AS count
      FROM app.timetable_versions v
      WHERE v.school_id = ${schoolId}
        AND v.term_id = ${params.term_id}
        ${statusFilter}
    `,
  ]);

  return { rows, total: Number(countResult[0]?.count ?? 0) };
}

export async function getTimetableVersion(
  tx: TransactionSql,
  schoolId: string,
  versionId: string,
): Promise<TimetableVersionRow | undefined> {
  return getVersion(tx, schoolId, versionId);
}

export async function createTimetableVersion(
  tx: TransactionSql,
  schoolId: string,
  params: CreateVersionParams,
): Promise<TimetableVersionRow> {
  const [term] = await tx<{ id: string }[]>`
    SELECT id FROM app.terms
    WHERE id = ${params.term_id} AND school_id = ${schoolId}
      AND academic_year_id = ${params.academic_year_id}
  `;
  if (!term) {
    throw new HTTPException(404, { message: "Term not found for the given academic year" });
  }

  const [row] = await tx<TimetableVersionRow[]>`
    INSERT INTO app.timetable_versions (school_id, academic_year_id, term_id, name, status)
    VALUES (${schoolId}, ${params.academic_year_id}, ${params.term_id}, ${params.name}, 'draft')
    RETURNING id, school_id, academic_year_id, term_id, name, status,
              submitted_at, submitted_by_user_id,
              approved_at, approved_by_user_id,
              rejected_reason,
              created_at, updated_at
  `;

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "timetable_versions",
    targetId: row!.id,
    newValues: { name: params.name, term_id: params.term_id },
  });

  return row!;
}

export async function updateTimetableVersion(
  tx: TransactionSql,
  schoolId: string,
  versionId: string,
  params: UpdateVersionParams,
): Promise<TimetableVersionRow> {
  const existing = await getVersion(tx, schoolId, versionId);
  if (!existing) {
    throw new HTTPException(404, { message: "Timetable version not found" });
  }
  if (existing.status !== "draft") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.TIMETABLE_VERSION_NOT_DRAFT,
      "Only draft versions can be edited",
    );
  }

  const [row] = await tx<TimetableVersionRow[]>`
    UPDATE app.timetable_versions
    SET name = COALESCE(${params.name ?? null}, name),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${versionId} AND school_id = ${schoolId}
    RETURNING id, school_id, academic_year_id, term_id, name, status,
              submitted_at, submitted_by_user_id,
              approved_at, approved_by_user_id,
              rejected_reason,
              created_at, updated_at
  `;

  if (!row) {
    throw new HTTPException(404, { message: "Timetable version not found" });
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "timetable_versions",
    targetId: versionId,
    oldValues: { name: existing.name },
    newValues: { name: params.name },
  });

  return row;
}

export async function deleteTimetableVersion(
  tx: TransactionSql,
  schoolId: string,
  versionId: string,
): Promise<void> {
  const existing = await getVersion(tx, schoolId, versionId);
  if (!existing) {
    throw new HTTPException(404, { message: "Timetable version not found" });
  }
  if (existing.status !== "draft") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.TIMETABLE_VERSION_NOT_DRAFT,
      "Only draft versions can be deleted",
    );
  }

  const [{ count }] = await tx<{ count: string }[]>`
    SELECT count(*)::int AS count
    FROM app.timetable_slots
    WHERE timetable_version_id = ${versionId} AND school_id = ${schoolId}
  `;
  if (Number(count) > 0) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      "Cannot delete a timetable version that still has slots. Remove all slots first.",
    );
  }

  const deleted = await tx`
    DELETE FROM app.timetable_versions
    WHERE id = ${versionId} AND school_id = ${schoolId}
    RETURNING id
  `;

  if (deleted.length === 0) {
    throw new HTTPException(404, { message: "Timetable version not found" });
  }

  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "timetable_versions",
    targetId: versionId,
    oldValues: { name: existing.name },
  });
}

// ---------------------------------------------------------------------------
// Version state transitions
// ---------------------------------------------------------------------------

export async function submitTimetableVersion(
  tx: TransactionSql,
  schoolId: string,
  versionId: string,
  userId: string,
): Promise<TimetableVersionRow> {
  const existing = await getVersion(tx, schoolId, versionId);
  if (!existing) {
    throw new HTTPException(404, { message: "Timetable version not found" });
  }
  if (existing.status !== "draft") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.TIMETABLE_VERSION_NOT_DRAFT,
      "Only draft versions can be submitted",
    );
  }

  const [row] = await tx<TimetableVersionRow[]>`
    UPDATE app.timetable_versions
    SET status = 'pending', submitted_by_user_id = ${userId}
    WHERE id = ${versionId} AND school_id = ${schoolId}
    RETURNING id, school_id, academic_year_id, term_id, name, status,
              submitted_at, submitted_by_user_id,
              approved_at, approved_by_user_id,
              rejected_reason,
              created_at, updated_at
  `;

  if (!row) {
    throw new HTTPException(404, { message: "Timetable version not found" });
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "timetable_versions",
    targetId: versionId,
    oldValues: { status: existing.status },
    newValues: { status: "pending" },
  });

  return row;
}

export async function approveTimetableVersion(
  tx: TransactionSql,
  schoolId: string,
  versionId: string,
  userId: string,
): Promise<TimetableVersionRow> {
  const existing = await getVersion(tx, schoolId, versionId);
  if (!existing) {
    throw new HTTPException(404, { message: "Timetable version not found" });
  }
  if (existing.status !== "pending") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      "Only pending versions can be approved",
    );
  }

  const [row] = await tx<TimetableVersionRow[]>`
    UPDATE app.timetable_versions
    SET status = 'approved', approved_by_user_id = ${userId}
    WHERE id = ${versionId} AND school_id = ${schoolId}
    RETURNING id, school_id, academic_year_id, term_id, name, status,
              submitted_at, submitted_by_user_id,
              approved_at, approved_by_user_id,
              rejected_reason,
              created_at, updated_at
  `;

  if (!row) {
    throw new HTTPException(404, { message: "Timetable version not found" });
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "timetable_versions",
    targetId: versionId,
    oldValues: { status: existing.status },
    newValues: { status: "approved" },
  });

  const [{ count }] = await tx<{ count: string }[]>`
    SELECT count(*)::int AS count
    FROM app.timetable_slots
    WHERE timetable_version_id = ${versionId} AND school_id = ${schoolId}
  `;

  await emit(tx, DOMAIN_EVENTS.TIMETABLE_APPROVED, {
    timetableVersionId: versionId,
    termId: row.term_id,
    approvedByUserId: userId,
    slotCount: Number(count),
  });

  return row;
}

export async function rejectTimetableVersion(
  tx: TransactionSql,
  schoolId: string,
  versionId: string,
  params: RejectVersionParams,
): Promise<TimetableVersionRow> {
  const existing = await getVersion(tx, schoolId, versionId);
  if (!existing) {
    throw new HTTPException(404, { message: "Timetable version not found" });
  }
  if (existing.status !== "pending") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      "Only pending versions can be rejected back to draft",
    );
  }

  const reason = params.reason ?? null;

  const [row] = await tx<TimetableVersionRow[]>`
    UPDATE app.timetable_versions
    SET status = 'draft', rejected_reason = ${reason}
    WHERE id = ${versionId} AND school_id = ${schoolId}
    RETURNING id, school_id, academic_year_id, term_id, name, status,
              submitted_at, submitted_by_user_id,
              approved_at, approved_by_user_id,
              rejected_reason,
              created_at, updated_at
  `;

  if (!row) {
    throw new HTTPException(404, { message: "Timetable version not found" });
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "timetable_versions",
    targetId: versionId,
    oldValues: { status: existing.status },
    newValues: { status: "draft", rejected_reason: reason },
  });

  await emit(tx, DOMAIN_EVENTS.TIMETABLE_REJECTED, {
    timetableVersionId: versionId,
    termId: row.term_id,
    rejectedReason: reason ?? "",
  });

  return row;
}

// ---------------------------------------------------------------------------
// Copy from previous term
// ---------------------------------------------------------------------------

export async function copyTimetableVersion(
  tx: TransactionSql,
  schoolId: string,
  params: CopyVersionParams,
): Promise<{
  timetable_version: TimetableVersionRow;
  slots_copied: number;
  slots_skipped: number;
}> {
  const source = await getVersion(tx, schoolId, params.source_version_id);
  if (!source) {
    throw new HTTPException(404, { message: "Source timetable version not found" });
  }

  const [targetTerm] = await tx<{ id: string }[]>`
    SELECT id FROM app.terms
    WHERE id = ${params.term_id} AND school_id = ${schoolId}
      AND academic_year_id = ${params.academic_year_id}
  `;
  if (!targetTerm) {
    throw new HTTPException(404, { message: "Target term not found for the given academic year" });
  }

  const version = await createTimetableVersion(tx, schoolId, {
    term_id: params.term_id,
    academic_year_id: params.academic_year_id,
    name: params.name,
  });

  // Copy slots whose class belongs to the target term. Classes from the source term that
  // don't exist (or don't match) in the target term are silently skipped — the DB trigger
  // enforce_timetable_slot_class_term would reject them anyway.
  const result = await tx<{ inserted: number }[]>`
    WITH inserted AS (
      INSERT INTO app.timetable_slots (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
      SELECT
        ${schoolId},
        ${version.id},
        ts.class_id,
        ts.teacher_id,
        ts.room_id,
        ts.weekday,
        ts.period
      FROM app.timetable_slots ts
      JOIN app.classes cl ON cl.id = ts.class_id AND cl.school_id = ts.school_id
      WHERE ts.timetable_version_id = ${params.source_version_id}
        AND ts.school_id = ${schoolId}
        AND cl.term_id = ${params.term_id}
        AND cl.academic_year_id = ${params.academic_year_id}
      ON CONFLICT DO NOTHING
    )
    SELECT count(*)::int AS inserted FROM inserted
  `;

  const [{ count: sourceCount }] = await tx<{ count: string }[]>`
    SELECT count(*)::int AS count
    FROM app.timetable_slots
    WHERE timetable_version_id = ${params.source_version_id} AND school_id = ${schoolId}
  `;

  const copied = Number(result[0]?.inserted ?? 0);
  const totalSource = Number(sourceCount ?? 0);

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "timetable_versions",
    targetId: version.id,
    newValues: {
      copied_from: params.source_version_id,
      slots_copied: copied,
      slots_skipped: totalSource - copied,
    },
  });

  return { timetable_version: version, slots_copied: copied, slots_skipped: totalSource - copied };
}

// ---------------------------------------------------------------------------
// Slot queries
// ---------------------------------------------------------------------------

export async function listTimetableSlots(
  tx: TransactionSql,
  schoolId: string,
  versionId: string,
  params: ListSlotsParams,
): Promise<{ rows: TimetableSlotRow[]; total: number }> {
  const [rows, countResult] = await Promise.all([
    tx<TimetableSlotRow[]>`
      SELECT id, school_id, timetable_version_id, class_id, teacher_id, room_id,
             weekday, period, created_at, updated_at
      FROM app.timetable_slots
      WHERE school_id = ${schoolId} AND timetable_version_id = ${versionId}
      ORDER BY weekday ASC, period ASC
      LIMIT ${params.limit}
      OFFSET ${params.offset}
    `,
    tx<{ count: string }[]>`
      SELECT count(*)::int AS count
      FROM app.timetable_slots
      WHERE school_id = ${schoolId} AND timetable_version_id = ${versionId}
    `,
  ]);

  return { rows, total: Number(countResult[0]?.count ?? 0) };
}

export async function getTimetableSlot(
  tx: TransactionSql,
  schoolId: string,
  slotId: string,
): Promise<TimetableSlotRow | undefined> {
  const [row] = await tx<TimetableSlotRow[]>`
    SELECT id, school_id, timetable_version_id, class_id, teacher_id, room_id,
           weekday, period, created_at, updated_at
    FROM app.timetable_slots
    WHERE id = ${slotId} AND school_id = ${schoolId}
  `;
  return row;
}

export async function createTimetableSlot(
  tx: TransactionSql,
  schoolId: string,
  versionId: string,
  params: CreateSlotParams,
): Promise<TimetableSlotRow> {
  const version = await getVersion(tx, schoolId, versionId);
  if (!version) {
    throw new HTTPException(404, { message: "Timetable version not found" });
  }
  if (version.status !== "draft") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.TIMETABLE_VERSION_NOT_DRAFT,
      "Slots can only be added to draft versions",
    );
  }

  // Validate FKs exist within this school.
  const [classRow] = await tx<{ id: string }[]>`
    SELECT id FROM app.classes
    WHERE id = ${params.class_id} AND school_id = ${schoolId}
  `;
  if (!classRow) throw new HTTPException(404, { message: "Class not found" });

  const [teacher] = await tx<{ id: string }[]>`
    SELECT id FROM app.teachers
    WHERE id = ${params.teacher_id} AND school_id = ${schoolId}
  `;
  if (!teacher) throw new HTTPException(404, { message: "Teacher not found" });

  const [room] = await tx<{ id: string }[]>`
    SELECT id FROM app.rooms
    WHERE id = ${params.room_id} AND school_id = ${schoolId}
  `;
  if (!room) throw new HTTPException(404, { message: "Room not found" });

  const names = await resolveSlotNames(
    tx,
    schoolId,
    params.class_id,
    params.teacher_id,
    params.room_id,
  );

  try {
    const [row] = await tx<TimetableSlotRow[]>`
      INSERT INTO app.timetable_slots
        (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
      VALUES
        (${schoolId}, ${versionId}, ${params.class_id}, ${params.teacher_id}, ${params.room_id},
         ${params.weekday}::smallint, ${params.period}::smallint)
      RETURNING id, school_id, timetable_version_id, class_id, teacher_id, room_id,
                weekday, period, created_at, updated_at
    `;

    await emitAuditLog(tx, {
      action: "insert",
      targetTable: "timetable_slots",
      targetId: row!.id,
      newValues: {
        class_id: params.class_id,
        teacher_id: params.teacher_id,
        room_id: params.room_id,
        weekday: params.weekday,
        period: params.period,
      },
    });

    return row!;
  } catch (error) {
    if (isPgExclusionViolation(error)) {
      const msg = (error as Error).message;
      const constraint = msg.includes(TEACHER_CONSTRAINT)
        ? TEACHER_CONSTRAINT
        : msg.includes(ROOM_CONSTRAINT)
          ? ROOM_CONSTRAINT
          : null;
      if (constraint) {
        const conflict = await findConflict(tx, schoolId, versionId, constraint, params);
        if (conflict) {
          throwConflictError(conflict, schoolId, names.classCode);
        }
      }
    }
    throw error;
  }
}

export async function updateTimetableSlot(
  tx: TransactionSql,
  schoolId: string,
  slotId: string,
  params: UpdateSlotParams,
): Promise<TimetableSlotRow> {
  const existing = await getTimetableSlot(tx, schoolId, slotId);
  if (!existing) {
    throw new HTTPException(404, { message: "Timetable slot not found" });
  }

  const version = await getVersion(tx, schoolId, existing.timetable_version_id);
  if (!version) {
    throw new HTTPException(404, { message: "Timetable version not found" });
  }
  if (version.status !== "draft") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.TIMETABLE_VERSION_NOT_DRAFT,
      "Slots can only be edited in draft versions",
    );
  }

  if (params.teacher_id) {
    const [teacher] = await tx<{ id: string }[]>`
      SELECT id FROM app.teachers WHERE id = ${params.teacher_id} AND school_id = ${schoolId}
    `;
    if (!teacher) throw new HTTPException(404, { message: "Teacher not found" });
  }

  if (params.room_id) {
    const [room] = await tx<{ id: string }[]>`
      SELECT id FROM app.rooms WHERE id = ${params.room_id} AND school_id = ${schoolId}
    `;
    if (!room) throw new HTTPException(404, { message: "Room not found" });
  }

  if (params.class_id) {
    const [classRow] = await tx<{ id: string }[]>`
      SELECT id FROM app.classes WHERE id = ${params.class_id} AND school_id = ${schoolId}
    `;
    if (!classRow) throw new HTTPException(404, { message: "Class not found" });
  }

  const mergedParams: UpdateSlotParams = {
    class_id: params.class_id ?? existing.class_id,
    teacher_id: params.teacher_id ?? existing.teacher_id,
    room_id: params.room_id ?? existing.room_id,
    weekday: params.weekday ?? existing.weekday,
    period: params.period ?? existing.period,
  };

  try {
    const [row] = await tx<TimetableSlotRow[]>`
      UPDATE app.timetable_slots
      SET class_id = ${mergedParams.class_id!},
          teacher_id = ${mergedParams.teacher_id!},
          room_id = ${mergedParams.room_id!},
          weekday = ${mergedParams.weekday!}::smallint,
          period = ${mergedParams.period!}::smallint,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${slotId} AND school_id = ${schoolId}
      RETURNING id, school_id, timetable_version_id, class_id, teacher_id, room_id,
                weekday, period, created_at, updated_at
    `;

    if (!row) {
      throw new HTTPException(404, { message: "Timetable slot not found" });
    }

    await emitAuditLog(tx, {
      action: "update",
      targetTable: "timetable_slots",
      targetId: slotId,
      oldValues: {
        class_id: existing.class_id,
        teacher_id: existing.teacher_id,
        room_id: existing.room_id,
        weekday: existing.weekday,
        period: existing.period,
      },
      newValues: {
        class_id: mergedParams.class_id,
        teacher_id: mergedParams.teacher_id,
        room_id: mergedParams.room_id,
        weekday: mergedParams.weekday,
        period: mergedParams.period,
      },
    });

    return row;
  } catch (error) {
    if (isPgExclusionViolation(error)) {
      const msg = (error as Error).message;
      const constraint = msg.includes(TEACHER_CONSTRAINT)
        ? TEACHER_CONSTRAINT
        : msg.includes(ROOM_CONSTRAINT)
          ? ROOM_CONSTRAINT
          : null;
      if (constraint) {
        const conflict = await findConflict(
          tx,
          schoolId,
          existing.timetable_version_id,
          constraint,
          mergedParams,
        );
        if (conflict) {
          const names = await resolveSlotNames(
            tx,
            schoolId,
            mergedParams.class_id!,
            mergedParams.teacher_id!,
            mergedParams.room_id!,
          );
          throwConflictError(conflict, schoolId, names.classCode);
        }
      }
    }
    throw error;
  }
}

export async function deleteTimetableSlot(
  tx: TransactionSql,
  schoolId: string,
  slotId: string,
): Promise<void> {
  const existing = await getTimetableSlot(tx, schoolId, slotId);
  if (!existing) {
    throw new HTTPException(404, { message: "Timetable slot not found" });
  }

  const version = await getVersion(tx, schoolId, existing.timetable_version_id);
  if (!version) {
    throw new HTTPException(404, { message: "Timetable version not found" });
  }
  if (version.status !== "draft") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.TIMETABLE_VERSION_NOT_DRAFT,
      "Slots can only be deleted from draft versions",
    );
  }

  const deleted = await tx`
    DELETE FROM app.timetable_slots
    WHERE id = ${slotId} AND school_id = ${schoolId}
    RETURNING id
  `;

  if (deleted.length === 0) {
    throw new HTTPException(404, { message: "Timetable slot not found" });
  }

  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "timetable_slots",
    targetId: slotId,
    oldValues: {
      class_id: existing.class_id,
      teacher_id: existing.teacher_id,
      room_id: existing.room_id,
      weekday: existing.weekday,
      period: existing.period,
    },
  });
}
