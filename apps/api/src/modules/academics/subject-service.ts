import { HTTPException } from "hono/http-exception";

import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CatalogStatus = "draft" | "active" | "inactive" | "archived";

export interface SubjectRow {
  id: string;
  school_id: string;
  code: string;
  name: string;
  description: string | null;
  status: CatalogStatus;
  created_at: Date;
  updated_at: Date;
}

export interface ListSubjectsParams {
  limit: number;
  offset: number;
  status?: string;
}

export interface CreateSubjectParams {
  code: string;
  name: string;
  description?: string | null;
  status?: string;
}

export interface UpdateSubjectParams {
  code?: string;
  name?: string;
  description?: string | null;
  status?: string;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listSubjects(
  tx: TransactionSql,
  schoolId: string,
  params: ListSubjectsParams,
): Promise<{ rows: SubjectRow[]; total: number }> {
  const statusFilter = params.status
    ? tx` AND s.status = ${params.status}::app.catalog_status`
    : tx``;

  const [rows, countResult] = await Promise.all([
    tx<SubjectRow[]>`
      SELECT s.id, s.school_id, s.code, s.name, s.description, s.status,
             s.created_at, s.updated_at
      FROM app.subjects AS s
      WHERE s.school_id = ${schoolId}
        ${statusFilter}
      ORDER BY s.code ASC
      LIMIT ${params.limit}
      OFFSET ${params.offset}
    `,
    tx<{ count: string }[]>`
      SELECT count(*)::int AS count
      FROM app.subjects AS s
      WHERE s.school_id = ${schoolId}
        ${statusFilter}
    `,
  ]);

  return { rows, total: Number(countResult[0]?.count ?? 0) };
}

export async function getSubject(
  tx: TransactionSql,
  schoolId: string,
  subjectId: string,
): Promise<SubjectRow | undefined> {
  const [row] = await tx<SubjectRow[]>`
    SELECT id, school_id, code, name, description, status, created_at, updated_at
    FROM app.subjects
    WHERE id = ${subjectId} AND school_id = ${schoolId}
  `;
  return row;
}

export async function createSubject(
  tx: TransactionSql,
  schoolId: string,
  params: CreateSubjectParams,
): Promise<SubjectRow> {
  const [row] = await tx<SubjectRow[]>`
    INSERT INTO app.subjects (school_id, code, name, description, status)
    VALUES (
      ${schoolId},
      ${params.code},
      ${params.name},
      ${params.description ?? null},
      ${params.status ?? "draft"}::app.catalog_status
    )
    RETURNING id, school_id, code, name, description, status, created_at, updated_at
  `;

  return row!;
}

export async function updateSubject(
  tx: TransactionSql,
  schoolId: string,
  subjectId: string,
  params: UpdateSubjectParams,
): Promise<SubjectRow> {
  const existing = await getSubject(tx, schoolId, subjectId);
  if (!existing) {
    throw new HTTPException(404, { message: "Subject not found" });
  }

  const [row] = await tx<SubjectRow[]>`
    UPDATE app.subjects
    SET code = COALESCE(${params.code ?? null}, code),
        name = COALESCE(${params.name ?? null}, name),
        description = COALESCE(${params.description ?? null}, description),
        status = COALESCE(${params.status ?? null}::app.catalog_status, status),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${subjectId} AND school_id = ${schoolId}
    RETURNING id, school_id, code, name, description, status, created_at, updated_at
  `;

  if (!row) {
    throw new HTTPException(404, { message: "Subject not found" });
  }

  return row;
}

/**
 * Delete a subject. If the subject has dependent courses, archive it instead of
 * hard-deleting. Unreferenced planned subjects are hard-deleted.
 */
export async function deleteSubject(
  tx: TransactionSql,
  schoolId: string,
  subjectId: string,
): Promise<{ deleted: boolean }> {
  const existing = await getSubject(tx, schoolId, subjectId);
  if (!existing) {
    throw new HTTPException(404, { message: "Subject not found" });
  }

  const [{ count }] = await tx<{ count: string }[]>`
    SELECT count(*)::int AS count
    FROM app.courses
    WHERE subject_id = ${subjectId} AND school_id = ${schoolId}
  `;

  if (Number(count) > 0) {
    await tx`
      UPDATE app.subjects
      SET status = 'archived'::app.catalog_status,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${subjectId} AND school_id = ${schoolId}
    `;
    return { deleted: false };
  }

  const deleted = await tx`
    DELETE FROM app.subjects
    WHERE id = ${subjectId} AND school_id = ${schoolId}
    RETURNING id
  `;

  if (deleted.length === 0) {
    throw new HTTPException(404, { message: "Subject not found" });
  }

  return { deleted: true };
}
