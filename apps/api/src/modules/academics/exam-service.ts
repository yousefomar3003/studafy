import { DOMAIN_EVENTS, ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";
import { emit } from "../../lib/events/emitter";
import { emitAuditLog } from "../../middleware/auditEmitter";

import type { ExamStatus } from "./schemas";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExamRow {
  id: string;
  school_id: string;
  class_id: string;
  created_by_user_id: string;
  last_edited_by_user_id: string;
  title: string;
  description: string | null;
  status: ExamStatus;
  starts_at: Date;
  ends_at: Date;
  max_score: number;
  room_id: string | null;
  weight: number;
  created_at: Date;
  updated_at: Date;
}

export interface ExamConflictWarning {
  conflict_type: "class_slot" | "room";
  timetable_slot_id: string;
  class_code: string;
  entity_id: string;
  entity_name: string;
  weekday: number;
}

export interface ListExamsParams {
  limit: number;
  offset: number;
  class_id: string;
  status?: string;
}

export interface CreateExamParams {
  class_id: string;
  title: string;
  description?: string | null;
  starts_at: string;
  ends_at: string;
  max_score: number;
  room_id?: string | null;
  weight?: number;
  status?: string;
}

export interface UpdateExamParams {
  title?: string;
  description?: string | null;
  starts_at?: string;
  ends_at?: string;
  max_score?: number;
  room_id?: string | null;
  weight?: number;
  status?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DELETABLE_STATUSES: ExamStatus[] = ["draft", "scheduled"];

async function getExam(
  tx: TransactionSql,
  schoolId: string,
  examId: string,
): Promise<ExamRow | undefined> {
  const [row] = await tx<ExamRow[]>`
    SELECT id, school_id, class_id,
           created_by_user_id, last_edited_by_user_id,
           title, description, status,
           starts_at, ends_at, max_score,
           room_id, weight,
           created_at, updated_at
    FROM app.exams
    WHERE id = ${examId} AND school_id = ${schoolId}
  `;
  return row;
}

function getAllowedTransitions(current: ExamStatus): ExamStatus[] {
  switch (current) {
    case "draft":
      return ["scheduled", "cancelled"];
    case "scheduled":
      return ["open", "cancelled", "archived"];
    case "open":
      return ["closed", "cancelled"];
    case "closed":
      return ["archived"];
    case "cancelled":
      return [];
    case "archived":
      return [];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

export async function checkTimetableConflicts(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
  roomId: string | null,
  startsAt: Date,
): Promise<ExamConflictWarning[]> {
  const warnings: ExamConflictWarning[] = [];

  // Extract ISO day of week (1=Mon .. 7=Sun) from the exam start time.
  const [weekdayRow] = await tx<{ weekday: number }[]>`
    SELECT EXTRACT(ISODOW FROM ${startsAt}::timestamptz)::int AS weekday
  `;
  const weekday = weekdayRow?.weekday;
  if (!weekday) return warnings;

  // Find the approved timetable version for this class's term.
  const [approvedVersion] = await tx<{ id: string }[]>`
    SELECT tv.id
    FROM app.timetable_versions tv
    JOIN app.classes cl ON cl.id = ${classId} AND cl.school_id = ${schoolId}
    WHERE tv.school_id = ${schoolId}
      AND tv.term_id = cl.term_id
      AND tv.status = 'approved'
    LIMIT 1
  `;
  if (!approvedVersion) return warnings;

  // Class-slot conflict: this class already has an approved timetable slot on the same weekday.
  const [classSlot] = await tx<
    {
      id: string;
      class_code: string;
      weekday: number;
    }[]
  >`
    SELECT ts.id,
           cl.code AS class_code,
           ts.weekday
    FROM app.timetable_slots ts
    JOIN app.classes cl ON cl.id = ts.class_id AND cl.school_id = ts.school_id
    WHERE ts.timetable_version_id = ${approvedVersion.id}
      AND ts.school_id = ${schoolId}
      AND ts.class_id = ${classId}
      AND ts.weekday = ${weekday}::smallint
    LIMIT 1
  `;
  if (classSlot) {
    warnings.push({
      conflict_type: "class_slot",
      timetable_slot_id: classSlot.id,
      class_code: classSlot.class_code,
      entity_id: classId,
      entity_name: classSlot.class_code,
      weekday: classSlot.weekday,
    });
  }

  // Room conflict: the same room is booked for a different class on the same weekday.
  if (roomId) {
    const [roomSlot] = await tx<
      {
        id: string;
        class_code: string;
        room_name: string;
        weekday: number;
      }[]
    >`
      SELECT ts.id,
             cl.code AS class_code,
             r.name AS room_name,
             ts.weekday
      FROM app.timetable_slots ts
      JOIN app.classes cl ON cl.id = ts.class_id AND cl.school_id = ts.school_id
      JOIN app.rooms r ON r.id = ts.room_id AND r.school_id = ts.school_id
      WHERE ts.timetable_version_id = ${approvedVersion.id}
        AND ts.school_id = ${schoolId}
        AND ts.room_id = ${roomId}
        AND ts.class_id <> ${classId}
        AND ts.weekday = ${weekday}::smallint
      LIMIT 1
    `;
    if (roomSlot) {
      warnings.push({
        conflict_type: "room",
        timetable_slot_id: roomSlot.id,
        class_code: roomSlot.class_code,
        entity_id: roomId,
        entity_name: roomSlot.room_name,
        weekday: roomSlot.weekday,
      });
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listExams(
  tx: TransactionSql,
  schoolId: string,
  params: ListExamsParams,
): Promise<{ rows: ExamRow[]; total: number }> {
  const statusFilter = params.status ? tx` AND e.status = ${params.status}::app.exam_status` : tx``;

  const [rows, countResult] = await Promise.all([
    tx<ExamRow[]>`
      SELECT e.id, e.school_id, e.class_id,
             e.created_by_user_id, e.last_edited_by_user_id,
             e.title, e.description, e.status,
             e.starts_at, e.ends_at, e.max_score,
             e.room_id, e.weight,
             e.created_at, e.updated_at
      FROM app.exams e
      WHERE e.school_id = ${schoolId}
        AND e.class_id = ${params.class_id}
        ${statusFilter}
      ORDER BY e.starts_at DESC
      LIMIT ${params.limit}
      OFFSET ${params.offset}
    `,
    tx<{ count: string }[]>`
      SELECT count(*)::int AS count
      FROM app.exams e
      WHERE e.school_id = ${schoolId}
        AND e.class_id = ${params.class_id}
        ${statusFilter}
    `,
  ]);

  return { rows, total: Number(countResult[0]?.count ?? 0) };
}

export async function getExamById(
  tx: TransactionSql,
  schoolId: string,
  examId: string,
): Promise<ExamRow | undefined> {
  return getExam(tx, schoolId, examId);
}

export async function createExam(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  params: CreateExamParams,
): Promise<{ exam: ExamRow; warnings: ExamConflictWarning[] }> {
  const [classRow] = await tx<{ id: string }[]>`
    SELECT id FROM app.classes
    WHERE id = ${params.class_id} AND school_id = ${schoolId}
  `;
  if (!classRow) {
    throw new HTTPException(404, { message: "Class not found" });
  }

  if (params.room_id) {
    const [room] = await tx<{ id: string }[]>`
      SELECT id FROM app.rooms
      WHERE id = ${params.room_id} AND school_id = ${schoolId}
    `;
    if (!room) {
      throw new HTTPException(404, { message: "Room not found" });
    }
  }

  const [row] = await tx<ExamRow[]>`
    INSERT INTO app.exams (
      school_id, class_id, created_by_user_id, last_edited_by_user_id,
      title, description, status,
      starts_at, ends_at, max_score,
      room_id, weight
    ) VALUES (
      ${schoolId},
      ${params.class_id},
      ${userId},
      ${userId},
      ${params.title},
      ${params.description ?? null},
      ${params.status ?? "draft"}::app.exam_status,
      ${params.starts_at}::timestamptz,
      ${params.ends_at}::timestamptz,
      ${params.max_score},
      ${params.room_id ?? null},
      ${params.weight ?? 1}
    )
    RETURNING id, school_id, class_id,
              created_by_user_id, last_edited_by_user_id,
              title, description, status,
              starts_at, ends_at, max_score,
              room_id, weight,
              created_at, updated_at
  `;

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "exams",
    targetId: row!.id,
    newValues: { title: params.title, class_id: params.class_id },
  });

  const warnings = await checkTimetableConflicts(
    tx,
    schoolId,
    params.class_id,
    params.room_id ?? null,
    row!.starts_at,
  );

  await emit(tx, DOMAIN_EVENTS.EXAM_SCHEDULED, {
    examId: row!.id,
    classId: params.class_id,
    scheduledByUserId: userId,
  });

  return { exam: row!, warnings };
}

export async function updateExam(
  tx: TransactionSql,
  schoolId: string,
  examId: string,
  userId: string,
  params: UpdateExamParams,
): Promise<{ exam: ExamRow; warnings: ExamConflictWarning[] }> {
  const existing = await getExam(tx, schoolId, examId);
  if (!existing) {
    throw new CodedHttpException(404, ERROR_CODES.EXAM_NOT_FOUND, "Exam not found");
  }

  if (params.room_id !== undefined && params.room_id !== null) {
    const [room] = await tx<{ id: string }[]>`
      SELECT id FROM app.rooms
      WHERE id = ${params.room_id} AND school_id = ${schoolId}
    `;
    if (!room) {
      throw new HTTPException(404, { message: "Room not found" });
    }
  }

  if (params.status && params.status !== existing.status) {
    const allowed = getAllowedTransitions(existing.status);
    if (!allowed.includes(params.status as ExamStatus)) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.EXAM_INVALID_STATE,
        `Cannot transition exam from '${existing.status}' to '${params.status}'`,
      );
    }
  }

  const startsAtExplicit = Object.prototype.hasOwnProperty.call(params, "starts_at");
  const endsAtExplicit = Object.prototype.hasOwnProperty.call(params, "ends_at");
  const roomIdExplicit = Object.prototype.hasOwnProperty.call(params, "room_id");
  const weightExplicit = Object.prototype.hasOwnProperty.call(params, "weight");

  const [row] = await tx<ExamRow[]>`
    UPDATE app.exams
    SET title = COALESCE(${params.title ?? null}, title),
        description = COALESCE(${params.description ?? null}, description),
        starts_at = CASE
          WHEN ${startsAtExplicit} THEN ${params.starts_at ?? null}::timestamptz
          ELSE starts_at
        END,
        ends_at = CASE
          WHEN ${endsAtExplicit} THEN ${params.ends_at ?? null}::timestamptz
          ELSE ends_at
        END,
        max_score = COALESCE(${params.max_score ?? null}, max_score),
        room_id = CASE
          WHEN ${roomIdExplicit} THEN ${params.room_id ?? null}
          ELSE room_id
        END,
        weight = CASE
          WHEN ${weightExplicit} THEN ${params.weight ?? existing.weight}
          ELSE weight
        END,
        status = COALESCE(${params.status ?? null}::app.exam_status, status),
        last_edited_by_user_id = ${userId},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${examId} AND school_id = ${schoolId}
    RETURNING id, school_id, class_id,
              created_by_user_id, last_edited_by_user_id,
              title, description, status,
              starts_at, ends_at, max_score,
              room_id, weight,
              created_at, updated_at
  `;

  if (!row) {
    throw new HTTPException(404, { message: "Exam not found" });
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "exams",
    targetId: examId,
    oldValues: {
      title: existing.title,
      status: existing.status,
      starts_at: existing.starts_at,
      room_id: existing.room_id,
    },
    newValues: { ...params },
  });

  const effectiveStartsAt = params.starts_at ? new Date(params.starts_at) : existing.starts_at;
  const effectiveRoomId = params.room_id !== undefined ? params.room_id : existing.room_id;

  const warnings = await checkTimetableConflicts(
    tx,
    schoolId,
    existing.class_id,
    effectiveRoomId,
    effectiveStartsAt,
  );

  if (params.status !== existing.status || params.starts_at || params.room_id !== undefined) {
    await emit(tx, DOMAIN_EVENTS.EXAM_UPDATED, {
      examId,
      classId: existing.class_id,
      updatedByUserId: userId,
    });
  }

  return { exam: row, warnings };
}

export async function deleteExam(
  tx: TransactionSql,
  schoolId: string,
  examId: string,
): Promise<void> {
  const existing = await getExam(tx, schoolId, examId);
  if (!existing) {
    throw new CodedHttpException(404, ERROR_CODES.EXAM_NOT_FOUND, "Exam not found");
  }

  if (!DELETABLE_STATUSES.includes(existing.status)) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.EXAM_INVALID_STATE,
      "Only draft or scheduled exams can be deleted",
    );
  }

  const deleted = await tx`
    DELETE FROM app.exams
    WHERE id = ${examId} AND school_id = ${schoolId}
    RETURNING id
  `;

  if (deleted.length === 0) {
    throw new HTTPException(404, { message: "Exam not found" });
  }

  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "exams",
    targetId: examId,
    oldValues: { title: existing.title, class_id: existing.class_id },
  });

  await emit(tx, DOMAIN_EVENTS.EXAM_CANCELLED, {
    examId,
    classId: existing.class_id,
  });
}
