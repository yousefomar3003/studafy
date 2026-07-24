import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";

import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AcademicPeriodStatus = "planned" | "active" | "closed" | "archived";

export interface AcademicYearRow {
  id: string;
  school_id: string;
  code: string;
  name: string;
  starts_on: Date;
  ends_on: Date;
  status: AcademicPeriodStatus;
  created_at: Date;
  updated_at: Date;
}

export interface ListAcademicYearsParams {
  limit: number;
  offset: number;
  status?: string;
}

export interface CreateAcademicYearParams {
  code: string;
  name: string;
  starts_on: string;
  ends_on: string;
  status?: string;
}

export interface UpdateAcademicYearParams {
  code?: string;
  name?: string;
  starts_on?: string;
  ends_on?: string;
  status?: string;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listAcademicYears(
  tx: TransactionSql,
  schoolId: string,
  params: ListAcademicYearsParams,
): Promise<{ rows: AcademicYearRow[]; total: number }> {
  const statusFilter = params.status
    ? tx` AND status = ${params.status}::app.academic_period_status`
    : tx``;

  const [rows, countResult] = await Promise.all([
    tx<AcademicYearRow[]>`
      SELECT id, school_id, code, name, starts_on, ends_on, status, created_at, updated_at
      FROM app.academic_years
      WHERE school_id = ${schoolId}
        ${statusFilter}
      ORDER BY starts_on DESC
      LIMIT ${params.limit}
      OFFSET ${params.offset}
    `,
    tx<{ count: string }[]>`
      SELECT count(*)::int AS count
      FROM app.academic_years
      WHERE school_id = ${schoolId}
        ${statusFilter}
    `,
  ]);

  return { rows, total: Number(countResult[0]?.count ?? 0) };
}

export async function getAcademicYear(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
): Promise<AcademicYearRow | undefined> {
  const [row] = await tx<AcademicYearRow[]>`
    SELECT id, school_id, code, name, starts_on, ends_on, status, created_at, updated_at
    FROM app.academic_years
    WHERE id = ${yearId} AND school_id = ${schoolId}
  `;
  return row;
}

export async function createAcademicYear(
  tx: TransactionSql,
  schoolId: string,
  params: CreateAcademicYearParams,
): Promise<AcademicYearRow> {
  await validateActiveYearConstraint(tx, schoolId, params.status);
  await validateNoDateOverlap(tx, schoolId, params.starts_on, params.ends_on);

  const [row] = await tx<AcademicYearRow[]>`
    INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
    VALUES (
      ${schoolId},
      ${params.code},
      ${params.name},
      ${params.starts_on}::date,
      ${params.ends_on}::date,
      ${params.status ?? "planned"}::app.academic_period_status
    )
    RETURNING id, school_id, code, name, starts_on, ends_on, status, created_at, updated_at
  `;

  return row!;
}

export async function updateAcademicYear(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
  params: UpdateAcademicYearParams,
): Promise<AcademicYearRow> {
  const existing = await getAcademicYear(tx, schoolId, yearId);
  if (!existing) {
    throw new HTTPException(404, { message: "Academic year not found" });
  }

  await validateActiveYearConstraint(tx, schoolId, params.status, yearId);

  const newStartsOn = params.starts_on ?? existing.starts_on.toISOString().slice(0, 10);
  const newEndsOn = params.ends_on ?? existing.ends_on.toISOString().slice(0, 10);
  await validateNoDateOverlap(tx, schoolId, newStartsOn, newEndsOn, yearId);

  const [row] = await tx<AcademicYearRow[]>`
    UPDATE app.academic_years
    SET code = COALESCE(${params.code ?? null}, code),
        name = COALESCE(${params.name ?? null}, name),
        starts_on = COALESCE(${params.starts_on ? params.starts_on : null}::date, starts_on),
        ends_on = COALESCE(${params.ends_on ? params.ends_on : null}::date, ends_on),
        status = COALESCE(${params.status ?? null}::app.academic_period_status, status),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${yearId} AND school_id = ${schoolId}
    RETURNING id, school_id, code, name, starts_on, ends_on, status, created_at, updated_at
  `;

  if (!row) {
    throw new HTTPException(404, { message: "Academic year not found" });
  }

  return row;
}

export async function deleteAcademicYear(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
): Promise<void> {
  const existing = await getAcademicYear(tx, schoolId, yearId);
  if (!existing) {
    throw new HTTPException(404, { message: "Academic year not found" });
  }

  if (existing.status !== "planned") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      "Only academic years in 'planned' status can be deleted.",
    );
  }

  const deleted = await tx`
    DELETE FROM app.academic_years
    WHERE id = ${yearId} AND school_id = ${schoolId}
    RETURNING id
  `;

  if (deleted.length === 0) {
    throw new HTTPException(404, { message: "Academic year not found" });
  }
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

async function validateActiveYearConstraint(
  tx: TransactionSql,
  schoolId: string,
  newStatus?: string,
  excludeYearId?: string,
): Promise<void> {
  if (newStatus !== "active") return;

  const [existing] = await tx<{ id: string }[]>`
    SELECT id
    FROM app.academic_years
    WHERE school_id = ${schoolId}
      AND status = 'active'
      ${excludeYearId ? tx`AND id != ${excludeYearId}` : tx``}
    LIMIT 1
  `;

  if (existing) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.ACADEMIC_YEAR_ACTIVE_EXISTS,
      "An active academic year already exists for this school. Use the rollover action to transition.",
    );
  }
}

async function validateNoDateOverlap(
  tx: TransactionSql,
  schoolId: string,
  startsOn: string,
  endsOn: string,
  excludeYearId?: string,
): Promise<void> {
  const overlapping = await tx<{ id: string }[]>`
    SELECT id
    FROM app.academic_years
    WHERE school_id = ${schoolId}
      AND status = 'active'
      AND starts_on < ${endsOn}::date
      AND ends_on > ${startsOn}::date
      ${excludeYearId ? tx`AND id != ${excludeYearId}` : tx``}
    LIMIT 1
  `;

  if (overlapping.length > 0) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.ACADEMIC_YEAR_DATE_OVERLAP,
      "The specified date range overlaps with an existing active academic year.",
    );
  }
}
