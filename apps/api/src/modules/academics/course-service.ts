import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";

import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CatalogStatus = "draft" | "active" | "inactive" | "archived";

export interface CourseRow {
  id: string;
  school_id: string;
  subject_id: string;
  code: string;
  name: string;
  description: string | null;
  credit_hours: number;
  status: CatalogStatus;
  created_at: Date;
  updated_at: Date;
}

export interface ListCoursesParams {
  limit: number;
  offset: number;
  status?: string;
}

export interface CreateCourseParams {
  subject_id: string;
  code: string;
  name: string;
  description?: string | null;
  credit_hours?: number;
  status?: string;
}

export interface UpdateCourseParams {
  code?: string;
  name?: string;
  description?: string | null;
  credit_hours?: number;
  status?: string;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listCourses(
  tx: TransactionSql,
  schoolId: string,
  subjectId: string | undefined,
  params: ListCoursesParams,
): Promise<{ rows: CourseRow[]; total: number }> {
  const subjectFilter = subjectId ? tx` AND c.subject_id = ${subjectId}` : tx``;
  const statusFilter = params.status
    ? tx` AND c.status = ${params.status}::app.catalog_status`
    : tx``;

  const [rows, countResult] = await Promise.all([
    tx<CourseRow[]>`
      SELECT c.id, c.school_id, c.subject_id, c.code, c.name, c.description,
             c.credit_hours::float8 AS credit_hours,
             c.status, c.created_at, c.updated_at
      FROM app.courses AS c
      WHERE c.school_id = ${schoolId}
        ${subjectFilter}
        ${statusFilter}
      ORDER BY c.code ASC
      LIMIT ${params.limit}
      OFFSET ${params.offset}
    `,
    tx<{ count: string }[]>`
      SELECT count(*)::int AS count
      FROM app.courses AS c
      WHERE c.school_id = ${schoolId}
        ${subjectFilter}
        ${statusFilter}
    `,
  ]);

  return { rows, total: Number(countResult[0]?.count ?? 0) };
}

export async function getCourse(
  tx: TransactionSql,
  schoolId: string,
  courseId: string,
): Promise<CourseRow | undefined> {
  const [row] = await tx<CourseRow[]>`
    SELECT id, school_id, subject_id, code, name, description,
           credit_hours::float8 AS credit_hours, status,
           created_at, updated_at
    FROM app.courses
    WHERE id = ${courseId} AND school_id = ${schoolId}
  `;
  return row;
}

export async function createCourse(
  tx: TransactionSql,
  schoolId: string,
  params: CreateCourseParams,
): Promise<CourseRow> {
  const [subject] = await tx<{ id: string }[]>`
    SELECT id FROM app.subjects
    WHERE id = ${params.subject_id} AND school_id = ${schoolId}
  `;

  if (!subject) {
    throw new HTTPException(404, { message: "Subject not found" });
  }

  const [row] = await tx<CourseRow[]>`
    INSERT INTO app.courses
      (school_id, subject_id, code, name, description, credit_hours, status)
    VALUES (
      ${schoolId},
      ${params.subject_id},
      ${params.code},
      ${params.name},
      ${params.description ?? null},
      ${params.credit_hours ?? 1},
      ${params.status ?? "draft"}::app.catalog_status
    )
    RETURNING id, school_id, subject_id, code, name, description,
              credit_hours::float8 AS credit_hours, status,
              created_at, updated_at
  `;

  return row!;
}

export async function updateCourse(
  tx: TransactionSql,
  schoolId: string,
  courseId: string,
  params: UpdateCourseParams,
): Promise<CourseRow> {
  const existing = await getCourse(tx, schoolId, courseId);
  if (!existing) {
    throw new HTTPException(404, { message: "Course not found" });
  }

  if (params.credit_hours !== undefined && existing.credit_hours !== params.credit_hours) {
    const [published] = await tx<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM app.classes AS c
        JOIN app.gradebooks AS gb
          ON gb.class_id = c.id AND gb.school_id = c.school_id
        JOIN app.grade_submissions AS gs
          ON gs.gradebook_id = gb.id AND gs.school_id = gb.school_id
        WHERE c.school_id = ${schoolId}
          AND c.course_id = ${courseId}
          AND gs.status = 'published'
      ) AS exists
    `;

    if (published?.exists) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.CONFLICT_STATE_MISMATCH,
        "Course credit hours cannot change after grades have been published",
      );
    }
  }

  const [row] = await tx<CourseRow[]>`
    UPDATE app.courses
    SET code = COALESCE(${params.code ?? null}, code),
        name = COALESCE(${params.name ?? null}, name),
        description = COALESCE(${params.description ?? null}, description),
        credit_hours = COALESCE(
          ${params.credit_hours !== undefined ? String(params.credit_hours) : null}::numeric(6,2),
          credit_hours
        ),
        status = COALESCE(${params.status ?? null}::app.catalog_status, status),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${courseId} AND school_id = ${schoolId}
    RETURNING id, school_id, subject_id, code, name, description,
              credit_hours::float8 AS credit_hours, status,
              created_at, updated_at
  `;

  if (!row) {
    throw new HTTPException(404, { message: "Course not found" });
  }

  return row;
}

/**
 * Delete a course. If the course has dependent classes, archive it instead of
 * hard-deleting. Unreferenced planned courses are hard-deleted.
 */
export async function deleteCourse(
  tx: TransactionSql,
  schoolId: string,
  courseId: string,
): Promise<{ deleted: boolean }> {
  const existing = await getCourse(tx, schoolId, courseId);
  if (!existing) {
    throw new HTTPException(404, { message: "Course not found" });
  }

  const [{ count }] = await tx<{ count: string }[]>`
    SELECT count(*)::int AS count
    FROM app.classes
    WHERE course_id = ${courseId} AND school_id = ${schoolId}
  `;

  if (Number(count) > 0) {
    await tx`
      UPDATE app.courses
      SET status = 'archived'::app.catalog_status,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${courseId} AND school_id = ${schoolId}
    `;
    return { deleted: false };
  }

  const deleted = await tx`
    DELETE FROM app.courses
    WHERE id = ${courseId} AND school_id = ${schoolId}
    RETURNING id
  `;

  if (deleted.length === 0) {
    throw new HTTPException(404, { message: "Course not found" });
  }

  return { deleted: true };
}
