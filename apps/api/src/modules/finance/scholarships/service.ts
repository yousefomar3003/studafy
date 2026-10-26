import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { formatMinorUnits, getCurrencyByCode, toMinorUnits } from "../currency";

import type { TransactionSql } from "postgres";

export type DiscountType = "percentage" | "fixed";
export type AwardStatus = "pending_approval" | "approved" | "rejected" | "revoked";

export interface ScholarshipRow {
  id: string;
  name: string;
  description: string | null;
  discount_type: DiscountType;
  percentage: string | null;
  amount: string | null;
  amount_minor: number | null;
  currency: string | null;
  currency_minor_unit: number | null;
  fee_category: string | null;
  is_active: boolean;
  approved_award_count: number;
  created_at: string;
  updated_at: string;
}

export interface AwardRow {
  id: string;
  scholarship_id: string;
  scholarship_name: string;
  scholarship_is_active: boolean;
  discount_type: DiscountType;
  percentage: string | null;
  amount: string | null;
  currency: string | null;
  fee_category: string | null;
  student_id: string;
  student_name: string;
  admission_number: string;
  status: AwardStatus;
  notes: string | null;
  requested_by: string;
  requested_by_name: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateScholarshipParams {
  name: string;
  description?: string;
  discount_type: DiscountType;
  percentage?: number;
  amount?: number;
  currency?: string;
  fee_category?: string;
}

export interface UpdateScholarshipParams {
  name?: string;
  description?: string | null;
  is_active?: boolean;
}

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

function isViolation(error: unknown, code: string, constraint: string): boolean {
  const e = error as { code?: string; constraint_name?: string };
  return e?.code === code && e.constraint_name === constraint;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return isViolation(error, UNIQUE_VIOLATION, constraint);
}

function iso(value: unknown): string | null {
  return value ? (value as Date).toISOString() : null;
}

/** The discount's display values: a percentage as stored, an amount at its currency's precision. */
function discountValues(row: Record<string, unknown>) {
  const minorUnit = row.currency_minor_unit as number | null;
  const amountMinor = row.amount_minor === null ? null : BigInt(row.amount_minor as string);
  return {
    percentage: (row.percentage as string | null) ?? null,
    amount:
      amountMinor === null || minorUnit === null ? null : formatMinorUnits(amountMinor, minorUnit),
    amount_minor: amountMinor === null ? null : Number(amountMinor),
    currency: (row.currency as string | null) ?? null,
    currency_minor_unit: minorUnit,
  };
}

// ---------------------------------------------------------------------------
// Scholarships
// ---------------------------------------------------------------------------

const SCHOLARSHIP_COLUMNS = `
  sc.id, sc.name, sc.description, sc.discount_type, sc.percentage::text AS percentage,
  sc.amount_minor, c.code AS currency, c.minor_unit AS currency_minor_unit, sc.fee_category,
  sc.is_active, sc.created_at, sc.updated_at,
  (SELECT count(*)::int FROM app.scholarship_awards AS a
    WHERE a.school_id = sc.school_id AND a.scholarship_id = sc.id AND a.status = 'approved'
  ) AS approved_award_count
`;

function parseScholarshipRow(row: Record<string, unknown>): ScholarshipRow {
  const values = discountValues(row);
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string | null,
    discount_type: row.discount_type as DiscountType,
    ...values,
    fee_category: row.fee_category as string | null,
    is_active: row.is_active as boolean,
    approved_award_count: row.approved_award_count as number,
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
  };
}

async function findScholarship(
  tx: TransactionSql,
  schoolId: string,
  scholarshipId: string,
): Promise<ScholarshipRow | null> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(SCHOLARSHIP_COLUMNS)}
    FROM app.scholarships AS sc
    LEFT JOIN app.currencies AS c ON c.id = sc.currency_id
    WHERE sc.school_id = ${schoolId}::uuid AND sc.id = ${scholarshipId}::uuid
  `;
  return row ? parseScholarshipRow(row) : null;
}

export async function listScholarships(
  tx: TransactionSql,
  schoolId: string,
  params: { is_active?: "true" | "false"; limit: number; offset: number },
): Promise<{ rows: ScholarshipRow[]; total: number }> {
  const activeFilter =
    params.is_active === undefined ? tx`` : tx` AND sc.is_active = ${params.is_active === "true"}`;

  const [rows, [count]] = await Promise.all([
    tx<Record<string, unknown>[]>`
      SELECT ${tx.unsafe(SCHOLARSHIP_COLUMNS)}
      FROM app.scholarships AS sc
      LEFT JOIN app.currencies AS c ON c.id = sc.currency_id
      WHERE sc.school_id = ${schoolId}::uuid${activeFilter}
      ORDER BY sc.is_active DESC, sc.name ASC
      LIMIT ${params.limit} OFFSET ${params.offset}
    `,
    tx<{ total: number }[]>`
      SELECT count(*)::int AS total FROM app.scholarships AS sc
      WHERE sc.school_id = ${schoolId}::uuid${activeFilter}
    `,
  ]);

  return { rows: rows.map(parseScholarshipRow), total: count?.total ?? 0 };
}

export async function createScholarship(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  params: CreateScholarshipParams,
): Promise<ScholarshipRow> {
  let currencyId: string | null = null;
  let amountMinor: bigint | null = null;
  if (params.discount_type === "fixed") {
    const currency = await getCurrencyByCode(tx, params.currency!);
    if (!currency) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        `Unknown or inactive currency: ${params.currency}`,
      );
    }
    currencyId = currency.id;
    amountMinor = toMinorUnits(params.amount!, currency.minorUnit);
  }

  let inserted: { id: string } | undefined;
  try {
    [inserted] = await tx<{ id: string }[]>`
      INSERT INTO app.scholarships (
        school_id, name, description, discount_type, percentage, amount_minor, currency_id,
        fee_category, created_by
      ) VALUES (
        ${schoolId}::uuid,
        ${params.name},
        ${params.description || null},
        ${params.discount_type},
        ${params.discount_type === "percentage" ? params.percentage! : null},
        ${amountMinor === null ? null : amountMinor.toString()}::bigint,
        ${currencyId}::uuid,
        ${params.fee_category ?? null},
        ${userId}::uuid
      )
      RETURNING id
    `;
  } catch (error) {
    if (isUniqueViolation(error, "uq_scholarships_school_name")) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.SCHOLARSHIP_NAME_TAKEN,
        "A scholarship with this name already exists",
      );
    }
    throw error;
  }

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "scholarships",
    targetId: inserted!.id,
    newValues: {
      name: params.name,
      discount_type: params.discount_type,
      percentage: params.percentage ?? null,
      amount_minor: amountMinor === null ? null : amountMinor.toString(),
      currency: params.currency ?? null,
      fee_category: params.fee_category ?? null,
    },
  });

  return (await findScholarship(tx, schoolId, inserted!.id))!;
}

export async function updateScholarship(
  tx: TransactionSql,
  schoolId: string,
  scholarshipId: string,
  params: UpdateScholarshipParams,
): Promise<ScholarshipRow> {
  const existing = await findScholarship(tx, schoolId, scholarshipId);
  if (!existing) {
    throw new CodedHttpException(404, ERROR_CODES.SCHOLARSHIP_NOT_FOUND, "Scholarship not found");
  }

  try {
    await tx`
      UPDATE app.scholarships
      SET name = ${params.name ?? existing.name},
          description = ${params.description === undefined ? existing.description : params.description || null},
          is_active = ${params.is_active ?? existing.is_active},
          updated_at = CURRENT_TIMESTAMP
      WHERE school_id = ${schoolId}::uuid AND id = ${scholarshipId}::uuid
    `;
  } catch (error) {
    if (isUniqueViolation(error, "uq_scholarships_school_name")) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.SCHOLARSHIP_NAME_TAKEN,
        "A scholarship with this name already exists",
      );
    }
    throw error;
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "scholarships",
    targetId: scholarshipId,
    oldValues: {
      name: existing.name,
      description: existing.description,
      is_active: existing.is_active,
    },
    newValues: { ...params },
  });

  return (await findScholarship(tx, schoolId, scholarshipId))!;
}

// ---------------------------------------------------------------------------
// Awards
// ---------------------------------------------------------------------------

const AWARD_COLUMNS = `
  a.id, a.scholarship_id, sc.name AS scholarship_name, sc.is_active AS scholarship_is_active,
  sc.discount_type,
  sc.percentage::text AS percentage, sc.amount_minor, c.code AS currency,
  c.minor_unit AS currency_minor_unit, sc.fee_category,
  a.student_id, coalesce(st.preferred_name, st.first_name) || ' ' || st.last_name AS student_name,
  st.admission_number, a.status, a.notes,
  a.requested_by, coalesce(ru.display_name, ru.email) AS requested_by_name,
  a.decided_by, coalesce(du.display_name, du.email) AS decided_by_name,
  a.decided_at, a.decision_notes, a.created_at, a.updated_at
`;

const AWARD_FROM = `
  app.scholarship_awards AS a
  JOIN app.scholarships AS sc ON sc.id = a.scholarship_id AND sc.school_id = a.school_id
  LEFT JOIN app.currencies AS c ON c.id = sc.currency_id
  JOIN app.students AS st ON st.id = a.student_id AND st.school_id = a.school_id
  LEFT JOIN app.users AS ru ON ru.id = a.requested_by
  LEFT JOIN app.users AS du ON du.id = a.decided_by
`;

function parseAwardRow(row: Record<string, unknown>): AwardRow {
  const { percentage, amount, currency } = discountValues(row);
  return {
    id: row.id as string,
    scholarship_id: row.scholarship_id as string,
    scholarship_name: row.scholarship_name as string,
    scholarship_is_active: row.scholarship_is_active as boolean,
    discount_type: row.discount_type as DiscountType,
    percentage,
    amount,
    currency,
    fee_category: row.fee_category as string | null,
    student_id: row.student_id as string,
    student_name: row.student_name as string,
    admission_number: row.admission_number as string,
    status: row.status as AwardStatus,
    notes: row.notes as string | null,
    requested_by: row.requested_by as string,
    requested_by_name: row.requested_by_name as string | null,
    decided_by: row.decided_by as string | null,
    decided_by_name: row.decided_by_name as string | null,
    decided_at: iso(row.decided_at),
    decision_notes: row.decision_notes as string | null,
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
  };
}

export async function getAward(
  tx: TransactionSql,
  schoolId: string,
  awardId: string,
): Promise<AwardRow> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(AWARD_COLUMNS)}
    FROM ${tx.unsafe(AWARD_FROM)}
    WHERE a.school_id = ${schoolId}::uuid AND a.id = ${awardId}::uuid
  `;
  if (!row) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.SCHOLARSHIP_AWARD_NOT_FOUND,
      "Scholarship award not found",
    );
  }
  return parseAwardRow(row);
}

export async function listAwards(
  tx: TransactionSql,
  schoolId: string,
  params: {
    status?: AwardStatus;
    student_id?: string;
    scholarship_id?: string;
    limit: number;
    offset: number;
  },
): Promise<{ rows: AwardRow[]; total: number }> {
  const filters = tx`
    a.school_id = ${schoolId}::uuid
    ${params.status ? tx`AND a.status = ${params.status}` : tx``}
    ${params.student_id ? tx`AND a.student_id = ${params.student_id}::uuid` : tx``}
    ${params.scholarship_id ? tx`AND a.scholarship_id = ${params.scholarship_id}::uuid` : tx``}
  `;

  const [rows, [count]] = await Promise.all([
    tx<Record<string, unknown>[]>`
      SELECT ${tx.unsafe(AWARD_COLUMNS)}
      FROM ${tx.unsafe(AWARD_FROM)}
      WHERE ${filters}
      ORDER BY a.created_at DESC, a.id
      LIMIT ${params.limit} OFFSET ${params.offset}
    `,
    tx<{ total: number }[]>`
      SELECT count(*)::int AS total FROM app.scholarship_awards AS a WHERE ${filters}
    `,
  ]);

  return { rows: rows.map(parseAwardRow), total: count?.total ?? 0 };
}

export async function createAward(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  params: { scholarship_id: string; student_id: string; notes?: string },
): Promise<string> {
  const scholarship = await findScholarship(tx, schoolId, params.scholarship_id);
  if (!scholarship) {
    throw new CodedHttpException(404, ERROR_CODES.SCHOLARSHIP_NOT_FOUND, "Scholarship not found");
  }
  if (!scholarship.is_active) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.SCHOLARSHIP_INACTIVE,
      "This scholarship is inactive and cannot be awarded",
    );
  }

  let inserted: { id: string } | undefined;
  try {
    [inserted] = await tx<{ id: string }[]>`
      INSERT INTO app.scholarship_awards (school_id, scholarship_id, student_id, notes, requested_by)
      VALUES (
        ${schoolId}::uuid,
        ${params.scholarship_id}::uuid,
        ${params.student_id}::uuid,
        ${params.notes || null},
        ${userId}::uuid
      )
      RETURNING id
    `;
  } catch (error) {
    if (isUniqueViolation(error, "uq_scholarship_awards_open")) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.SCHOLARSHIP_AWARD_DUPLICATE,
        "This student already has this scholarship or a pending request for it",
      );
    }
    // The student is checked by its foreign key rather than read first: the caller may not be
    // allowed to see the students table at all (see ../students/service.ts).
    if (isViolation(error, FOREIGN_KEY_VIOLATION, "fk_scholarship_awards_student")) {
      throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Student not found");
    }
    throw error;
  }

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "scholarship_awards",
    targetId: inserted!.id,
    newValues: {
      scholarship_id: params.scholarship_id,
      student_id: params.student_id,
      status: "pending_approval",
      requested_by: userId,
    },
  });

  return inserted!.id;
}

const TRANSITIONS: Record<"approve" | "reject" | "revoke", { from: AwardStatus; to: AwardStatus }> =
  {
    approve: { from: "pending_approval", to: "approved" },
    reject: { from: "pending_approval", to: "rejected" },
    revoke: { from: "approved", to: "revoked" },
  };

/**
 * The school admin's decision on an award. No maker/checker identity check, unlike refunds: the
 * control is that only `billing:approveScholarship` (ORG_ADMIN) decides, so an award an admin
 * requests is already admin-approved in substance, and a single-admin school is not left stuck.
 */
export async function decideAward(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  awardId: string,
  decision: keyof typeof TRANSITIONS,
  notes: string | undefined,
): Promise<void> {
  const [award] = await tx<{ status: AwardStatus }[]>`
    SELECT status FROM app.scholarship_awards
    WHERE school_id = ${schoolId}::uuid AND id = ${awardId}::uuid
  `;
  if (!award) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.SCHOLARSHIP_AWARD_NOT_FOUND,
      "Scholarship award not found",
    );
  }

  // eslint-disable-next-line security/detect-object-injection -- `decision` is a fixed literal union, not user input
  const { from, to } = TRANSITIONS[decision];
  const updated = await tx`
    UPDATE app.scholarship_awards
    SET status = ${to},
        decided_by = ${userId}::uuid,
        decided_at = CURRENT_TIMESTAMP,
        decision_notes = ${notes || null},
        updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId}::uuid AND id = ${awardId}::uuid AND status = ${from}
  `;
  if (updated.count === 0) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.SCHOLARSHIP_AWARD_INVALID_STATUS,
      `Cannot ${decision} an award with status '${award.status}'`,
    );
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "scholarship_awards",
    targetId: awardId,
    oldValues: { status: from },
    newValues: { status: to, decided_by: userId, decision_notes: notes ?? null },
  });
}
