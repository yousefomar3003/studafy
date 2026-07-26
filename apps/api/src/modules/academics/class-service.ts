import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import type { ClassStatus } from "./schemas";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClassRow {
  id: string;
  school_id: string;
  course_id: string;
  academic_year_id: string;
  term_id: string;
  lead_teacher_id: string;
  room_id: string;
  code: string;
  capacity: number | null;
  status: ClassStatus;
  created_at: Date;
  updated_at: Date;
}

export interface ListClassesParams {
  limit: number;
  offset: number;
  status?: string;
  course_id?: string;
  term_id?: string;
  lead_teacher_id?: string;
}

export interface CreateClassParams {
  course_id: string;
  academic_year_id: string;
  term_id: string;
  lead_teacher_id: string;
  room_id: string;
  code: string;
  capacity?: number | null;
  status?: string;
}

export interface UpdateClassParams {
  lead_teacher_id?: string;
  room_id?: string;
  code?: string;
  capacity?: number | null;
  status?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function countActiveEnrollments(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
): Promise<number> {
  const [{ count }] = await tx<{ count: string }[]>`
    SELECT count(*)::int AS count
    FROM app.enrollments
    WHERE class_id = ${classId} AND school_id = ${schoolId}
      AND status IN ('active', 'waitlisted')
  `;
  return Number(count);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listClasses(
  tx: TransactionSql,
  schoolId: string,
  params: ListClassesParams,
): Promise<{ rows: ClassRow[]; total: number }> {
  const statusFilter = params.status
    ? tx` AND cl.status = ${params.status}::app.class_status`
    : tx``;
  const courseFilter = params.course_id ? tx` AND cl.course_id = ${params.course_id}` : tx``;
  const termFilter = params.term_id ? tx` AND cl.term_id = ${params.term_id}` : tx``;
  const teacherFilter = params.lead_teacher_id
    ? tx` AND cl.lead_teacher_id = ${params.lead_teacher_id}`
    : tx``;

  const [rows, countResult] = await Promise.all([
    tx<ClassRow[]>`
      SELECT cl.id, cl.school_id, cl.course_id, cl.academic_year_id, cl.term_id,
             cl.lead_teacher_id, cl.room_id, cl.code, cl.capacity, cl.status,
             cl.created_at, cl.updated_at
      FROM app.classes AS cl
      WHERE cl.school_id = ${schoolId}
        ${statusFilter}
        ${courseFilter}
        ${termFilter}
        ${teacherFilter}
      ORDER BY cl.code ASC
      LIMIT ${params.limit}
      OFFSET ${params.offset}
    `,
    tx<{ count: string }[]>`
      SELECT count(*)::int AS count
      FROM app.classes AS cl
      WHERE cl.school_id = ${schoolId}
        ${statusFilter}
        ${courseFilter}
        ${termFilter}
        ${teacherFilter}
    `,
  ]);

  return { rows, total: Number(countResult[0]?.count ?? 0) };
}

export async function getClass(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
): Promise<ClassRow | undefined> {
  const [row] = await tx<ClassRow[]>`
    SELECT id, school_id, course_id, academic_year_id, term_id,
           lead_teacher_id, room_id, code, capacity, status,
           created_at, updated_at
    FROM app.classes
    WHERE id = ${classId} AND school_id = ${schoolId}
  `;
  return row;
}

export async function createClass(
  tx: TransactionSql,
  schoolId: string,
  params: CreateClassParams,
): Promise<ClassRow> {
  const [course] = await tx<{ id: string }[]>`
    SELECT id FROM app.courses
    WHERE id = ${params.course_id} AND school_id = ${schoolId}
  `;
  if (!course) {
    throw new HTTPException(404, { message: "Course not found" });
  }

  const [academicYear] = await tx<{ id: string }[]>`
    SELECT id FROM app.academic_years
    WHERE id = ${params.academic_year_id} AND school_id = ${schoolId}
  `;
  if (!academicYear) {
    throw new HTTPException(404, { message: "Academic year not found" });
  }

  const [term] = await tx<{ id: string }[]>`
    SELECT id FROM app.terms
    WHERE id = ${params.term_id} AND school_id = ${schoolId}
      AND academic_year_id = ${params.academic_year_id}
  `;
  if (!term) {
    throw new HTTPException(404, { message: "Term not found" });
  }

  const [teacher] = await tx<{ id: string }[]>`
    SELECT id FROM app.teachers
    WHERE id = ${params.lead_teacher_id} AND school_id = ${schoolId}
  `;
  if (!teacher) {
    throw new HTTPException(404, { message: "Teacher not found" });
  }

  const [room] = await tx<{ id: string }[]>`
    SELECT id FROM app.rooms
    WHERE id = ${params.room_id} AND school_id = ${schoolId}
  `;
  if (!room) {
    throw new HTTPException(404, { message: "Room not found" });
  }

  const [row] = await tx<ClassRow[]>`
    INSERT INTO app.classes (
      school_id, course_id, academic_year_id, term_id,
      lead_teacher_id, room_id, code, capacity, status
    ) VALUES (
      ${schoolId},
      ${params.course_id},
      ${params.academic_year_id},
      ${params.term_id},
      ${params.lead_teacher_id},
      ${params.room_id},
      ${params.code},
      ${params.capacity ?? null},
      ${params.status ?? "planned"}::app.class_status
    )
    RETURNING id, school_id, course_id, academic_year_id, term_id,
              lead_teacher_id, room_id, code, capacity, status,
              created_at, updated_at
  `;

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "classes",
    targetId: row!.id,
    newValues: { code: params.code, course_id: params.course_id },
  });

  return row!;
}

export async function updateClass(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
  params: UpdateClassParams,
): Promise<ClassRow> {
  const existing = await getClass(tx, schoolId, classId);
  if (!existing) {
    throw new HTTPException(404, { message: "Class not found" });
  }

  if (params.lead_teacher_id) {
    const [teacher] = await tx<{ id: string }[]>`
      SELECT id FROM app.teachers
      WHERE id = ${params.lead_teacher_id} AND school_id = ${schoolId}
    `;
    if (!teacher) {
      throw new HTTPException(404, { message: "Teacher not found" });
    }
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

  if (params.capacity !== undefined && params.capacity !== null) {
    const enrolled = await countActiveEnrollments(tx, schoolId, classId);
    if (enrolled > params.capacity) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.CLASS_CAPACITY_EXCEEDED,
        `Cannot set capacity to ${params.capacity}: ${enrolled} students are currently enrolled.`,
      );
    }
  }

  const capacityExplicit = Object.prototype.hasOwnProperty.call(params, "capacity");

  const [row] = await tx<ClassRow[]>`
    UPDATE app.classes
    SET lead_teacher_id = COALESCE(${params.lead_teacher_id ?? null}, lead_teacher_id),
        room_id = COALESCE(${params.room_id ?? null}, room_id),
        code = COALESCE(${params.code ?? null}, code),
        capacity = CASE
          WHEN ${capacityExplicit} THEN ${params.capacity ?? null}::int
          ELSE capacity
        END,
        status = COALESCE(${params.status ?? null}::app.class_status, status),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${classId} AND school_id = ${schoolId}
    RETURNING id, school_id, course_id, academic_year_id, term_id,
              lead_teacher_id, room_id, code, capacity, status,
              created_at, updated_at
  `;

  if (!row) {
    throw new HTTPException(404, { message: "Class not found" });
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "classes",
    targetId: classId,
    oldValues: { capacity: existing.capacity, status: existing.status },
    newValues: { ...params },
  });

  return row;
}

/**
 * Delete a class. If the class has any enrollments (active or historical), archive it
 * instead of hard-deleting. Unreferenced planned classes are hard-deleted.
 */
export async function deleteClass(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
): Promise<{ deleted: boolean }> {
  const existing = await getClass(tx, schoolId, classId);
  if (!existing) {
    throw new HTTPException(404, { message: "Class not found" });
  }

  const [{ count }] = await tx<{ count: string }[]>`
    SELECT count(*)::int AS count
    FROM app.enrollments
    WHERE class_id = ${classId} AND school_id = ${schoolId}
  `;

  if (Number(count) > 0) {
    await tx`
      UPDATE app.classes
      SET status = 'cancelled'::app.class_status,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${classId} AND school_id = ${schoolId}
    `;

    await emitAuditLog(tx, {
      action: "update",
      targetTable: "classes",
      targetId: classId,
      oldValues: { status: existing.status },
      newValues: { status: "cancelled", reason: "has_enrollments" },
    });

    return { deleted: false };
  }

  const deleted = await tx`
    DELETE FROM app.classes
    WHERE id = ${classId} AND school_id = ${schoolId}
    RETURNING id
  `;

  if (deleted.length === 0) {
    throw new HTTPException(404, { message: "Class not found" });
  }

  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "classes",
    targetId: classId,
  });

  return { deleted: true };
}
