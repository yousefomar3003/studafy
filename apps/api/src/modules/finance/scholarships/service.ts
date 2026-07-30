import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { ErpNextError } from "../../../erpnext/client";
import { emitAuditLog } from "../../../middleware/auditEmitter";

import type { TenantErpNext } from "../client/tenant-client";
import type { JSONValue, TransactionSql } from "postgres";

const RESOURCE_PATH = "/api/resource/Scholarship%20Award";

export interface ScholarshipDiscountRow {
  id: string;
  school_id: string;
  erpnext_docname: string;
  erpnext_status: string;
  title: string;
  discount_type: string;
  amount: number;
  scope: string;
  fee_category: string | null;
  currency: string | null;
  currency_minor_unit: number | null;
  is_active: boolean;
  last_synced_at: Date;
}

export interface ListScholarshipDiscountsParams {
  is_active?: string;
  scope?: string;
  fee_category?: string;
  limit: number;
  offset: number;
}

export interface AwardRow {
  id: string;
  school_id: string;
  student_id: string;
  scholarship_discount_id: string;
  scholarship_discount_title: string;
  award_status: string;
  awarded_by: string;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  erpnext_docname: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ListAwardsParams {
  student_id?: string;
  status?: string;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

function translateErpNextError(error: unknown): never {
  if (!(error instanceof ErpNextError)) throw error;

  if (error.kind === "circuit_open") {
    throw new CodedHttpException(
      503,
      ERROR_CODES.ERPNEXT_CIRCUIT_OPEN,
      "ERPNext is unreachable; requests are paused while it recovers",
    );
  }
  if (error.kind === "timeout") {
    throw new CodedHttpException(
      504,
      ERROR_CODES.ERPNEXT_TIMEOUT,
      "ERPNext did not respond in time",
    );
  }
  if (error.kind === "network") {
    throw new CodedHttpException(503, ERROR_CODES.ERPNEXT_UNAVAILABLE, "ERPNext is unreachable");
  }

  if (error.status >= 500) {
    throw new CodedHttpException(503, ERROR_CODES.ERPNEXT_UNAVAILABLE, "ERPNext is unreachable");
  }

  throw new CodedHttpException(
    error.status === 429 ? 429 : 400,
    error.status === 429 ? ERROR_CODES.RATE_LIMIT_EXCEEDED : ERROR_CODES.VALIDATION_FAILED,
    error.message,
  );
}

// ---------------------------------------------------------------------------
// Cache query columns
// ---------------------------------------------------------------------------

const DISCOUNT_CACHE_COLUMNS = `
  sdc.id,
  sdc.school_id,
  sdc.erpnext_docname,
  sdc.erpnext_status,
  sdc.title,
  sdc.discount_type,
  sdc.amount,
  sdc.scope,
  sdc.fee_category,
  c.code AS currency,
  c.minor_unit AS currency_minor_unit,
  sdc.is_active,
  sdc.last_synced_at
`;

function parseDiscountCacheRow(row: Record<string, unknown>): ScholarshipDiscountRow {
  return {
    id: row.id as string,
    school_id: row.school_id as string,
    erpnext_docname: row.erpnext_docname as string,
    erpnext_status: row.erpnext_status as string,
    title: row.title as string,
    discount_type: row.discount_type as string,
    amount: Number(row.amount),
    scope: row.scope as string,
    fee_category: row.fee_category as string | null,
    currency: row.currency as string | null,
    currency_minor_unit: row.currency_minor_unit as number | null,
    is_active: row.is_active as boolean,
    last_synced_at: row.last_synced_at as Date,
  };
}

// ---------------------------------------------------------------------------
// Read scholarship/discount configs
// ---------------------------------------------------------------------------

export async function listScholarshipDiscounts(
  tx: TransactionSql,
  schoolId: string,
  params: ListScholarshipDiscountsParams,
): Promise<{ rows: ScholarshipDiscountRow[]; total: number }> {
  const isActiveFilter =
    params.is_active !== undefined ? tx` AND sdc.is_active = ${params.is_active === "true"}` : tx``;
  const scopeFilter = params.scope ? tx` AND sdc.scope = ${params.scope}` : tx``;
  const categoryFilter = params.fee_category
    ? tx` AND sdc.fee_category = ${params.fee_category}`
    : tx``;

  const [rows, [count]] = await Promise.all([
    tx<Record<string, unknown>[]>`
      SELECT ${tx.unsafe(DISCOUNT_CACHE_COLUMNS)}
      FROM app.scholarship_discount_cache AS sdc
      LEFT JOIN app.currencies AS c ON c.id = sdc.currency_id
      WHERE sdc.school_id = ${schoolId}::uuid
        ${isActiveFilter}${scopeFilter}${categoryFilter}
      ORDER BY sdc.title ASC, sdc.erpnext_docname
      LIMIT ${params.limit} OFFSET ${params.offset}
    `,
    tx<{ total: number }[]>`
      SELECT count(*)::int AS total
      FROM app.scholarship_discount_cache AS sdc
      WHERE sdc.school_id = ${schoolId}::uuid
        ${isActiveFilter}${scopeFilter}${categoryFilter}
    `,
  ]);

  return { rows: rows.map(parseDiscountCacheRow), total: count?.total ?? 0 };
}

export async function getScholarshipDiscountById(
  tx: TransactionSql,
  schoolId: string,
  id: string,
): Promise<ScholarshipDiscountRow | null> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(DISCOUNT_CACHE_COLUMNS)}
    FROM app.scholarship_discount_cache AS sdc
    LEFT JOIN app.currencies AS c ON c.id = sdc.currency_id
    WHERE sdc.school_id = ${schoolId}::uuid AND sdc.id = ${id}::uuid
  `;
  if (!row) return null;
  return parseDiscountCacheRow(row);
}

// ---------------------------------------------------------------------------
// Awards — maker step
// ---------------------------------------------------------------------------

export async function createAward(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  params: { student_id: string; scholarship_discount_id: string },
): Promise<AwardRow> {
  const discount = await getScholarshipDiscountById(tx, schoolId, params.scholarship_discount_id);
  if (!discount) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.SCHOLARSHIP_DISCOUNT_NOT_FOUND,
      "Scholarship/discount not found",
    );
  }

  const [row] = await tx<Record<string, unknown>[]>`
    INSERT INTO app.award_cache (
      school_id, student_id, scholarship_discount_id, award_status, awarded_by
    ) VALUES (
      ${schoolId}::uuid,
      ${params.student_id}::uuid,
      ${params.scholarship_discount_id}::uuid,
      'pending',
      ${userId}::uuid
    )
    ON CONFLICT (school_id, student_id, scholarship_discount_id)
      WHERE award_status = 'pending'
      DO UPDATE SET updated_at = CURRENT_TIMESTAMP
    RETURNING id, school_id, student_id, scholarship_discount_id, award_status,
              awarded_by, confirmed_by, confirmed_at, erpnext_docname,
              created_at, updated_at
  `;

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "award_cache",
    targetId: schoolId,
    newValues: {
      award_id: row.id as string,
      student_id: params.student_id,
      scholarship_discount_id: params.scholarship_discount_id,
      status: "pending",
      awarded_by: userId,
    },
  });

  return parseAwardRow(row, discount.title);
}

// ---------------------------------------------------------------------------
// Awards — checker step
// ---------------------------------------------------------------------------

export async function confirmAward(
  tx: TransactionSql,
  erpnext: TenantErpNext,
  schoolId: string,
  userId: string,
  awardId: string,
  acceptLanguage?: string,
): Promise<AwardRow> {
  const [existing] = await tx<Record<string, unknown>[]>`
    SELECT ac.*, sdc.title AS scholarship_discount_title
    FROM app.award_cache AS ac
    JOIN app.scholarship_discount_cache AS sdc ON sdc.id = ac.scholarship_discount_id
    WHERE ac.id = ${awardId}::uuid AND ac.school_id = ${schoolId}::uuid
  `;

  if (!existing) {
    throw new CodedHttpException(404, ERROR_CODES.AWARD_NOT_FOUND, "Award not found");
  }

  if (existing.award_status !== "pending") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.AWARD_INVALID_STATUS_TRANSITION,
      `Cannot confirm an award with status '${existing.award_status}'`,
    );
  }

  if (existing.awarded_by === userId) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.AWARD_CONFIRM_SELF,
      "The awarder and confirmer must be different users",
    );
  }

  const discount = await getScholarshipDiscountById(
    tx,
    schoolId,
    existing.scholarship_discount_id as string,
  );
  if (!discount) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.SCHOLARSHIP_DISCOUNT_NOT_FOUND,
      "Referenced scholarship/discount no longer exists",
    );
  }

  const erpnextDoc: Record<string, unknown> = {
    student: existing.student_id as string,
    scholarship_discount: discount.erpnext_docname,
    award_status: "confirmed",
    custom_school_id: schoolId,
  };

  let erpnextResult: { name?: string };
  try {
    const response = await erpnext.post<{ data: Record<string, unknown> }>(
      RESOURCE_PATH,
      erpnextDoc,
      { acceptLanguage },
    );
    erpnextResult = response.data.data as { name?: string };
  } catch (error) {
    translateErpNextError(error);
  }

  const [updated] = await tx<Record<string, unknown>[]>`
    UPDATE app.award_cache
    SET award_status = 'confirmed',
        confirmed_by = ${userId}::uuid,
        confirmed_at = CURRENT_TIMESTAMP,
        erpnext_docname = ${erpnextResult.name ?? null},
        erpnext_payload = ${tx.json(erpnextDoc as unknown as JSONValue)}::jsonb,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${awardId}::uuid
    RETURNING id, school_id, student_id, scholarship_discount_id, award_status,
              awarded_by, confirmed_by, confirmed_at, erpnext_docname,
              created_at, updated_at
  `;

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "award_cache",
    targetId: schoolId,
    oldValues: {
      award_id: awardId,
      status: "pending",
      awarded_by: existing.awarded_by as string,
    },
    newValues: {
      award_id: awardId,
      status: "confirmed",
      confirmed_by: userId,
      erpnext_docname: erpnextResult.name ?? null,
    },
  });

  return parseAwardRow(updated!, existing.scholarship_discount_title as string);
}

// ---------------------------------------------------------------------------
// List awards
// ---------------------------------------------------------------------------

const AWARD_COLUMNS = `
  ac.id,
  ac.school_id,
  ac.student_id,
  ac.scholarship_discount_id,
  sdc.title AS scholarship_discount_title,
  ac.award_status,
  ac.awarded_by,
  ac.confirmed_by,
  ac.confirmed_at,
  ac.erpnext_docname,
  ac.created_at,
  ac.updated_at
`;

function parseAwardRow(row: Record<string, unknown>, discountTitle?: string): AwardRow {
  return {
    id: row.id as string,
    school_id: row.school_id as string,
    student_id: row.student_id as string,
    scholarship_discount_id: row.scholarship_discount_id as string,
    scholarship_discount_title: discountTitle ?? (row.scholarship_discount_title as string) ?? "",
    award_status: row.award_status as string,
    awarded_by: row.awarded_by as string,
    confirmed_by: row.confirmed_by as string | null,
    confirmed_at: row.confirmed_at as Date | null,
    erpnext_docname: row.erpnext_docname as string | null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

function mapAwardRow(row: Record<string, unknown>): AwardRow {
  return parseAwardRow(row);
}

export async function listAwards(
  tx: TransactionSql,
  schoolId: string,
  params: ListAwardsParams,
): Promise<{ rows: AwardRow[]; total: number }> {
  const studentFilter = params.student_id
    ? tx` AND ac.student_id = ${params.student_id}::uuid`
    : tx``;
  const statusFilter = params.status ? tx` AND ac.award_status = ${params.status}` : tx``;

  const [rows, [count]] = await Promise.all([
    tx<Record<string, unknown>[]>`
      SELECT ${tx.unsafe(AWARD_COLUMNS)}
      FROM app.award_cache AS ac
      JOIN app.scholarship_discount_cache AS sdc ON sdc.id = ac.scholarship_discount_id
      WHERE ac.school_id = ${schoolId}::uuid
        ${studentFilter}${statusFilter}
      ORDER BY ac.created_at DESC
      LIMIT ${params.limit} OFFSET ${params.offset}
    `,
    tx<{ total: number }[]>`
      SELECT count(*)::int AS total
      FROM app.award_cache AS ac
      WHERE ac.school_id = ${schoolId}::uuid
        ${studentFilter}${statusFilter}
    `,
  ]);

  return { rows: rows.map(mapAwardRow), total: count?.total ?? 0 };
}
