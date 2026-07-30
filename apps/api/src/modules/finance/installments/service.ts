import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { ErpNextError } from "../../../erpnext/client";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { formatMinorUnits, getCurrencyByCode, toMinorUnits } from "../currency";
import { upsertMapping } from "../id-mappings/service";

import type { TenantErpNext } from "../client/tenant-client";
import type { JSONValue, TransactionSql } from "postgres";

const FEE_SCHEDULE_DOCTYPE = "Fee Schedule";
const RESOURCE_PATH = "/api/resource/Fee%20Schedule";

export interface InstallmentRow {
  id: string;
  school_id: string;
  erpnext_fee_schedule_id: string;
  student_id: string;
  fee_structure_id: string | null;
  due_date: string;
  total_amount: string;
  paid_amount: string;
  outstanding_amount: string;
  total_amount_minor: number;
  paid_amount_minor: number;
  outstanding_amount_minor: number;
  currency: string;
  currency_minor_unit: number;
  status: string;
  synced_at: string;
}

export interface ListInstallmentsParams {
  status?: string;
  dueDateFrom?: string;
  dueDateTo?: string;
  limit: number;
  offset: number;
}

export interface GenerateFeeScheduleParams {
  feeStructure: string;
  studentIds: string[];
  dueDates: string[];
  academicYearId?: string;
  program?: string;
  scheduleType: string;
}

const CACHE_COLUMNS = `
  fsc.id,
  fsc.school_id,
  fsc.erpnext_fee_schedule_id,
  fsc.student_id,
  fsc.fee_structure_id,
  fsc.due_date::text AS due_date,
  fsc.total_amount_minor,
  fsc.paid_amount_minor,
  fsc.outstanding_amount_minor,
  fsc.status,
  fsc.synced_at,
  c.code AS currency,
  c.minor_unit AS currency_minor_unit
`;

function parseCacheRow(row: Record<string, unknown>): InstallmentRow {
  const minorUnit = row.currency_minor_unit as number;

  return {
    id: row.id as string,
    school_id: row.school_id as string,
    erpnext_fee_schedule_id: row.erpnext_fee_schedule_id as string,
    student_id: row.student_id as string,
    fee_structure_id: row.fee_structure_id as string | null,
    due_date: row.due_date as string,
    total_amount: formatMinorUnits(BigInt(row.total_amount_minor as string | number), minorUnit),
    paid_amount: formatMinorUnits(BigInt(row.paid_amount_minor as string | number), minorUnit),
    outstanding_amount: formatMinorUnits(
      BigInt(row.outstanding_amount_minor as string | number),
      minorUnit,
    ),
    total_amount_minor: Number(row.total_amount_minor),
    paid_amount_minor: Number(row.paid_amount_minor),
    outstanding_amount_minor: Number(row.outstanding_amount_minor),
    currency: row.currency as string,
    currency_minor_unit: minorUnit,
    status: row.status as string,
    synced_at: (row.synced_at as Date).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listInstallments(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  params: ListInstallmentsParams,
): Promise<{ rows: InstallmentRow[]; total: number }> {
  const conditions = tx`fsc.school_id = ${schoolId}::uuid AND fsc.student_id = ${studentId}::uuid`;
  const statusFilter = params.status ? tx` AND fsc.status = ${params.status}` : tx``;
  const dateFromFilter = params.dueDateFrom
    ? tx` AND fsc.due_date >= ${params.dueDateFrom}::date`
    : tx``;
  const dateToFilter = params.dueDateTo ? tx` AND fsc.due_date <= ${params.dueDateTo}::date` : tx``;

  const [rows, [count]] = await Promise.all([
    tx<Record<string, unknown>[]>`
      SELECT ${tx.unsafe(CACHE_COLUMNS)}
      FROM app.fee_schedule_cache AS fsc
      JOIN app.currencies AS c ON c.id = fsc.currency_id
      WHERE ${conditions}${statusFilter}${dateFromFilter}${dateToFilter}
      ORDER BY fsc.due_date ASC, fsc.erpnext_fee_schedule_id
      LIMIT ${params.limit} OFFSET ${params.offset}
    `,
    tx<{ total: number }[]>`
      SELECT count(*)::int AS total
      FROM app.fee_schedule_cache AS fsc
      WHERE ${conditions}${statusFilter}${dateFromFilter}${dateToFilter}
    `,
  ]);

  return { rows: rows.map(parseCacheRow), total: count?.total ?? 0 };
}

// ---------------------------------------------------------------------------
// Cache projection
// ---------------------------------------------------------------------------

interface ErpNextFeeScheduleDoc {
  name?: string;
  student?: string | null;
  fee_structure?: string | null;
  total_amount?: number | string | null;
  paid_amount?: number | string | null;
  outstanding_amount?: number | string | null;
  currency?: string | null;
  due_date?: string | null;
  docstatus?: number | null;
  custom_school_id?: string | null;
}

async function projectToCache(
  tx: TransactionSql,
  schoolId: string,
  doc: ErpNextFeeScheduleDoc,
  feeStructureId: string | null,
): Promise<InstallmentRow> {
  const erpnextName = doc.name;
  if (!erpnextName) {
    throw new CodedHttpException(
      502,
      ERROR_CODES.ERPNEXT_UNAVAILABLE,
      "ERPNext returned a fee schedule with no document name",
    );
  }

  const currencyCode = (doc.currency ?? "JOD").toUpperCase();
  const currency = await getCurrencyByCode(tx, currencyCode);
  if (!currency) {
    throw new CodedHttpException(
      502,
      ERROR_CODES.ERPNEXT_UNAVAILABLE,
      `ERPNext returned an unknown currency: ${currencyCode}`,
    );
  }

  const totalAmount = Number(doc.total_amount ?? 0);
  const paidAmount = Number(doc.paid_amount ?? 0);
  const outstandingAmount = Number(doc.outstanding_amount ?? totalAmount);
  const totalMinor = toMinorUnits(totalAmount, currency.minorUnit);
  const paidMinor = toMinorUnits(paidAmount, currency.minorUnit);
  const outstandingMinor = toMinorUnits(outstandingAmount, currency.minorUnit);

  let computedStatus: string;
  if (outstandingMinor <= 0n) {
    computedStatus = "paid";
  } else if (paidMinor > 0n) {
    computedStatus = "partially_paid";
  } else {
    computedStatus = "pending";
  }

  const [row] = await tx<Record<string, unknown>[]>`
    INSERT INTO app.fee_schedule_cache (
      school_id, student_id, erpnext_fee_schedule_id, fee_structure_id,
      due_date, total_amount_minor, paid_amount_minor, outstanding_amount_minor,
      currency_id, status, erpnext_payload, synced_at
    ) VALUES (
      ${schoolId}::uuid,
      ${doc.student ?? null}::uuid,
      ${erpnextName},
      ${feeStructureId}::uuid,
      ${doc.due_date ?? "2099-12-31"}::date,
      ${totalMinor.toString()}::bigint,
      ${paidMinor.toString()}::bigint,
      ${outstandingMinor.toString()}::bigint,
      ${currency.id}::uuid,
      ${computedStatus},
      ${tx.json(doc as unknown as JSONValue)}::jsonb,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT (school_id, erpnext_fee_schedule_id) DO UPDATE
      SET student_id              = EXCLUDED.student_id,
          fee_structure_id        = EXCLUDED.fee_structure_id,
          due_date                = EXCLUDED.due_date,
          total_amount_minor      = EXCLUDED.total_amount_minor,
          paid_amount_minor       = EXCLUDED.paid_amount_minor,
          outstanding_amount_minor = EXCLUDED.outstanding_amount_minor,
          currency_id             = EXCLUDED.currency_id,
          status                  = EXCLUDED.status,
          erpnext_payload         = EXCLUDED.erpnext_payload,
          synced_at               = EXCLUDED.synced_at,
          updated_at              = CURRENT_TIMESTAMP
    RETURNING id
  `;

  await upsertMapping(tx, schoolId, "fee_schedule", row!.id as string, erpnextName);

  const [projected] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(CACHE_COLUMNS)}
    FROM app.fee_schedule_cache AS fsc
    JOIN app.currencies AS c ON c.id = fsc.currency_id
    WHERE fsc.school_id = ${schoolId}::uuid AND fsc.erpnext_fee_schedule_id = ${erpnextName}
  `;

  return parseCacheRow(projected!);
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

  if (error.status === 404) {
    throw new CodedHttpException(404, ERROR_CODES.FEE_SCHEDULE_NOT_FOUND, "Fee schedule not found");
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
// Write — generate fee schedule
// ---------------------------------------------------------------------------

export async function generateFeeSchedule(
  tx: TransactionSql,
  erpnext: TenantErpNext,
  schoolId: string,
  params: GenerateFeeScheduleParams,
  acceptLanguage?: string,
): Promise<InstallmentRow[]> {
  const rows: InstallmentRow[] = [];

  for (const studentId of params.studentIds) {
    const payload: Record<string, unknown> = {
      student: studentId,
      fee_structure: params.feeStructure,
      due_date: params.dueDates[0],
      custom_school_id: schoolId,
    };
    if (params.program) payload.program = params.program;
    if (params.scheduleType) payload.schedule_type = params.scheduleType;

    let doc: ErpNextFeeScheduleDoc;
    try {
      const response = await erpnext.post<{ data: ErpNextFeeScheduleDoc }>(RESOURCE_PATH, payload, {
        acceptLanguage,
      });
      doc = response.data.data;
    } catch (error) {
      translateErpNextError(error);
    }

    const feeStructureId = await resolveFeeStructureId(tx, schoolId, params.feeStructure);
    const row = await projectToCache(tx, schoolId, doc, feeStructureId);

    await emitAuditLog(tx, {
      action: "insert",
      targetTable: "fee_schedule_cache",
      targetId: schoolId,
      newValues: {
        erpnext_doctype: FEE_SCHEDULE_DOCTYPE,
        erpnext_fee_schedule_id: row.erpnext_fee_schedule_id,
        student_id: row.student_id,
        due_date: row.due_date,
        total_amount_minor: row.total_amount_minor,
        currency: row.currency,
      },
    });

    rows.push(row);
  }

  return rows;
}

async function resolveFeeStructureId(
  tx: TransactionSql,
  schoolId: string,
  erpnextDocname: string,
): Promise<string | null> {
  const [row] = await tx<{ id: string }[]>`
    SELECT id FROM app.fee_structure_cache
    WHERE school_id = ${schoolId}::uuid AND erpnext_docname = ${erpnextDocname}
  `;
  return row?.id ?? null;
}
