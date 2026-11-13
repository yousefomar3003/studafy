import { HTTPException } from "hono/http-exception";

import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AcademicPeriodStatus = "planned" | "active" | "closed" | "archived";

export interface TermRow {
  id: string;
  school_id: string;
  academic_year_id: string;
  code: string;
  name: string;
  sequence_number: number;
  starts_on: Date;
  ends_on: Date;
  status: AcademicPeriodStatus;
  created_at: Date;
  updated_at: Date;
}

export interface ListTermsParams {
  limit: number;
  offset: number;
  status?: string;
}

export interface CreateTermParams {
  academic_year_id: string;
  code: string;
  name: string;
  sequence_number: number;
  starts_on: string;
  ends_on: string;
  status?: string;
}

export interface UpdateTermParams {
  code?: string;
  name?: string;
  sequence_number?: number;
  starts_on?: string;
  ends_on?: string;
  status?: string;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listTerms(
  tx: TransactionSql,
  schoolId: string,
  academicYearId: string,
  params: ListTermsParams,
): Promise<{ rows: TermRow[]; total: number }> {
  const statusFilter = params.status
    ? tx` AND t.status = ${params.status}::app.academic_period_status`
    : tx``;

  const [rows, countResult] = await Promise.all([
    tx<TermRow[]>`
      SELECT t.id, t.school_id, t.academic_year_id, t.code, t.name,
             t.sequence_number, t.starts_on, t.ends_on, t.status,
             t.created_at, t.updated_at
      FROM app.terms AS t
      WHERE t.school_id = ${schoolId}
        AND t.academic_year_id = ${academicYearId}
        ${statusFilter}
      ORDER BY t.sequence_number ASC
      LIMIT ${params.limit}
      OFFSET ${params.offset}
    `,
    tx<{ count: string }[]>`
      SELECT count(*)::int AS count
      FROM app.terms AS t
      WHERE t.school_id = ${schoolId}
        AND t.academic_year_id = ${academicYearId}
        ${statusFilter}
    `,
  ]);

  return { rows, total: Number(countResult[0]?.count ?? 0) };
}

export async function getTerm(
  tx: TransactionSql,
  schoolId: string,
  termId: string,
): Promise<TermRow | undefined> {
  const [row] = await tx<TermRow[]>`
    SELECT id, school_id, academic_year_id, code, name,
           sequence_number, starts_on, ends_on, status,
           created_at, updated_at
    FROM app.terms
    WHERE id = ${termId} AND school_id = ${schoolId}
  `;
  return row;
}

export async function createTerm(
  tx: TransactionSql,
  schoolId: string,
  params: CreateTermParams,
): Promise<TermRow> {
  const [row] = await tx<TermRow[]>`
    INSERT INTO app.terms (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
    VALUES (
      ${schoolId},
      ${params.academic_year_id},
      ${params.code},
      ${params.name},
      ${params.sequence_number},
      ${params.starts_on}::date,
      ${params.ends_on}::date,
      ${params.status ?? "planned"}::app.academic_period_status
    )
    RETURNING id, school_id, academic_year_id, code, name,
              sequence_number, starts_on, ends_on, status,
              created_at, updated_at
  `;

  return row!;
}

export async function updateTerm(
  tx: TransactionSql,
  schoolId: string,
  termId: string,
  params: UpdateTermParams,
): Promise<TermRow> {
  const existing = await getTerm(tx, schoolId, termId);
  if (!existing) {
    throw new HTTPException(404, { message: "Term not found" });
  }

  const [row] = await tx<TermRow[]>`
    UPDATE app.terms
    SET code = COALESCE(${params.code ?? null}, code),
        name = COALESCE(${params.name ?? null}, name),
        sequence_number = COALESCE(${params.sequence_number ?? null}::smallint, sequence_number),
        starts_on = COALESCE(${params.starts_on ? params.starts_on : null}::date, starts_on),
        ends_on = COALESCE(${params.ends_on ? params.ends_on : null}::date, ends_on),
        status = COALESCE(${params.status ?? null}::app.academic_period_status, status),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${termId} AND school_id = ${schoolId}
    RETURNING id, school_id, academic_year_id, code, name,
              sequence_number, starts_on, ends_on, status,
              created_at, updated_at
  `;

  if (!row) {
    throw new HTTPException(404, { message: "Term not found" });
  }

  return row;
}

export async function deleteTerm(
  tx: TransactionSql,
  schoolId: string,
  termId: string,
): Promise<void> {
  const existing = await getTerm(tx, schoolId, termId);
  if (!existing) {
    throw new HTTPException(404, { message: "Term not found" });
  }

  if (existing.status !== "planned") {
    throw new HTTPException(409, {
      message: "Only terms in 'planned' status can be deleted.",
    });
  }

  const deleted = await tx`
    DELETE FROM app.terms
    WHERE id = ${termId} AND school_id = ${schoolId}
    RETURNING id
  `;

  if (deleted.length === 0) {
    throw new HTTPException(404, { message: "Term not found" });
  }
}
