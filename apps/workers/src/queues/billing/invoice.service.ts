import { ERROR_CODES } from "@studafy/constants";
import { v5 as uuidv5 } from "uuid";

import { resolveSchoolCredentials } from "./credential-resolver";
import { ErpNextClient, ErpNextError } from "./erpnext-client";

import type { GenerateBatchInvoicesJobData, GenerateInvoiceJobData } from "./schemas";
import type { JSONValue, TransactionSql } from "postgres";

const NAMESPACE_DETERMINISTIC = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

export interface InvoiceCacheRow {
  id: string;
  school_id: string;
  student_id: string;
  erpnext_docname: string;
  erpnext_status: string;
  total_amount_minor: number;
  outstanding_amount_minor: number;
  issued_date: string;
  due_date: string | null;
  last_synced_at: string;
}

export interface SingleInvoiceResult {
  idempotencyKey: string;
  studentId: string;
  erpnextDocname: string | null;
  status: "created" | "already_exists" | "failed";
  error?: string;
}

export interface BatchInvoiceResult {
  total: number;
  succeeded: number;
  alreadyExisted: number;
  failed: { studentId: string; error: string }[];
}

function makeIdempotencyKey(
  schoolId: string,
  studentId: string,
  feeStructureName: string,
  periodTitle: string,
): string {
  return uuidv5(
    `${schoolId}:${studentId}:${feeStructureName}:${periodTitle}`,
    NAMESPACE_DETERMINISTIC,
  );
}

function statusFromDocstatus(docstatus: number | null | undefined): string {
  if (docstatus === 1) return "submitted";
  if (docstatus === 2) return "cancelled";
  return "draft";
}

async function getCurrencyRef(
  tx: TransactionSql,
  code: string,
): Promise<{ id: string; code: string; minorUnit: number }> {
  const [row] = await tx<{ id: string; code: string; minor_unit: number }[]>`
    SELECT id, code, minor_unit
    FROM app.currencies
    WHERE code = ${code.toUpperCase()} AND is_active = true
  `;
  if (!row) {
    throw new Error(`Unknown currency: ${code}`);
  }
  return { id: row.id, code: row.code, minorUnit: row.minor_unit };
}

function toMinorUnits(amount: number, minorUnit: number): bigint {
  if (!Number.isFinite(amount)) {
    throw new RangeError(`Cannot convert non-finite amount to minor units: ${amount}`);
  }
  const scaled = amount * 10 ** minorUnit;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return BigInt(rounded);
}

interface FeeStructureComponent {
  fee_category: string;
  amount: number;
  description?: string;
}

interface ErpNextSalesInvoiceDoc {
  name?: string;
  customer?: string;
  grand_total?: number;
  total?: number;
  outstanding_amount?: number;
  currency?: string;
  posting_date?: string;
  due_date?: string;
  docstatus?: number;
  custom_school_id?: string;
  items?: Record<string, unknown>[];
}

async function buildStudentCustomerId(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<string> {
  const [student] = await tx<{ admission_number: string }[]>`
    SELECT s.admission_number
    FROM app.students s
    WHERE s.id = ${studentId}::uuid AND s.school_id = ${schoolId}::uuid
  `;
  if (!student) {
    throw new CodedError(
      404,
      ERROR_CODES.INVOICE_STUDENT_NOT_FOUND,
      `Student ${studentId} not found`,
    );
  }
  return student.admission_number;
}

class CodedError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "CodedError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

async function projectToCache(
  tx: TransactionSql,
  schoolId: string,
  doc: ErpNextSalesInvoiceDoc,
  params: {
    studentId: string;
    currencyCode: string;
    idempotencyKey: string;
  },
): Promise<InvoiceCacheRow> {
  const erpnextName = doc.name;
  if (!erpnextName) {
    throw new Error("ERPNext returned a Sales Invoice with no document name");
  }

  const currency = await getCurrencyRef(tx, params.currencyCode);
  const totalAmount = Number(doc.grand_total ?? doc.total ?? 0);
  const outstandingAmount = Number(doc.outstanding_amount ?? doc.grand_total ?? doc.total ?? 0);
  const totalMinor = toMinorUnits(totalAmount, currency.minorUnit);
  const outstandingMinor = toMinorUnits(outstandingAmount, currency.minorUnit);
  const issuedDate = doc.posting_date ?? new Date().toISOString().slice(0, 10);
  const dueDate = doc.due_date ?? null;

  await tx`
    INSERT INTO app.invoice_cache (
      school_id, student_id, currency_id, erpnext_docname, erpnext_status,
      total_amount_minor, outstanding_amount_minor, issued_date, due_date,
      erpnext_payload, last_synced_at
    ) VALUES (
      ${schoolId}::uuid,
      ${params.studentId}::uuid,
      ${currency.id}::uuid,
      ${erpnextName},
      ${statusFromDocstatus(doc.docstatus)},
      ${totalMinor.toString()}::bigint,
      ${outstandingMinor.toString()}::bigint,
      ${issuedDate}::date,
      ${dueDate !== null ? (dueDate as string) : null}::date,
      ${tx.json(doc as unknown as JSONValue)}::jsonb,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT (school_id, erpnext_docname) DO UPDATE
      SET erpnext_status           = EXCLUDED.erpnext_status,
          total_amount_minor       = EXCLUDED.total_amount_minor,
          outstanding_amount_minor = EXCLUDED.outstanding_amount_minor,
          erpnext_payload          = EXCLUDED.erpnext_payload,
          last_synced_at           = EXCLUDED.last_synced_at,
          updated_at               = CURRENT_TIMESTAMP
  `;

  await tx`
    INSERT INTO app.erpnext_id_mappings (school_id, entity, studafy_id, erpnext_docname)
    VALUES (
      ${schoolId}::uuid,
      'invoice'::app.finance_entity_type,
      ${params.idempotencyKey}::uuid,
      ${erpnextName}
    )
    ON CONFLICT (school_id, entity, studafy_id) DO UPDATE
      SET erpnext_docname = EXCLUDED.erpnext_docname,
          updated_at = CURRENT_TIMESTAMP
      WHERE app.erpnext_id_mappings.erpnext_docname IS DISTINCT FROM EXCLUDED.erpnext_docname
  `;

  const [cached] = await tx<InvoiceCacheRow[]>`
    SELECT id, school_id, student_id, erpnext_docname, erpnext_status,
           total_amount_minor, outstanding_amount_minor,
           issued_date::text AS issued_date,
           due_date::text AS due_date,
           last_synced_at::text AS last_synced_at
    FROM app.invoice_cache
    WHERE school_id = ${schoolId}::uuid AND erpnext_docname = ${erpnextName}
  `;

  return cached!;
}

export async function generateInvoice(
  tx: TransactionSql,
  schoolId: string,
  params: GenerateInvoiceJobData,
  envBaseUrl: string | undefined,
  envApiKey: string | undefined,
): Promise<SingleInvoiceResult> {
  const idempotencyKey = params.idempotencyKey;

  const existing = await tx<{ erpnext_docname: string | null }[]>`
    SELECT erpnext_docname
    FROM app.erpnext_id_mappings
    WHERE school_id = ${schoolId}::uuid
      AND entity = 'invoice'::app.finance_entity_type
      AND studafy_id = ${idempotencyKey}::uuid
  `;

  if (existing.length > 0 && existing[0].erpnext_docname !== null) {
    return {
      idempotencyKey,
      studentId: params.studentId,
      erpnextDocname: existing[0].erpnext_docname,
      status: "already_exists",
    };
  }

  const credentials = await resolveSchoolCredentials(tx, schoolId, envBaseUrl, envApiKey);
  const client = new ErpNextClient(credentials);

  const [feeStructure] = await tx<
    {
      program_erpnext_name: string | null;
      currency_id: string;
      erpnext_payload: Record<string, unknown>;
    }[]
  >`
    SELECT fsc.program_erpnext_name,
           c.code AS currency_id,
           fsc.erpnext_payload
    FROM app.fee_structure_cache fsc
    JOIN app.currencies c ON c.id = fsc.currency_id
    WHERE fsc.school_id = ${schoolId}::uuid
      AND fsc.erpnext_docname = ${params.feeStructureErpnextName}
  `;

  if (!feeStructure) {
    throw new CodedError(
      404,
      ERROR_CODES.FEE_STRUCTURE_NOT_FOUND,
      `Fee structure ${params.feeStructureErpnextName} not found`,
    );
  }

  const currencyCode = feeStructure.currency_id;
  const feePayload = feeStructure.erpnext_payload as Record<string, unknown>;
  const rawComponents = feePayload.components as FeeStructureComponent[] | undefined;
  const components = rawComponents ?? [];

  const customerId = await buildStudentCustomerId(tx, schoolId, params.studentId);

  const items = components.map((c) => ({
    item_code: c.fee_category,
    qty: 1,
    rate: c.amount,
    description: c.description ?? undefined,
  }));

  // Query confirmed scholarship/discount awards for this student.
  interface ConfirmedAward {
    discount_type: string;
    amount: number;
    scope: string;
    fee_category: string | null;
  }
  const confirmedAwards = await tx<ConfirmedAward[]>`
    SELECT sdc.discount_type, sdc.amount, sdc.scope, sdc.fee_category
    FROM app.award_cache ac
    JOIN app.scholarship_discount_cache sdc ON sdc.id = ac.scholarship_discount_id
    WHERE ac.school_id = ${schoolId}::uuid
      AND ac.student_id = ${params.studentId}::uuid
      AND ac.award_status = 'confirmed'
  `;

  const totalAmount = items.reduce((sum, item) => sum + item.rate * item.qty, 0);
  let discountAmount = 0;
  const percentageAwards: number[] = [];

  for (const award of confirmedAwards) {
    if (award.discount_type === "fixed") {
      discountAmount += Number(award.amount);
    } else if (award.discount_type === "percentage") {
      percentageAwards.push(Number(award.amount));
    }
  }

  if (percentageAwards.length > 0) {
    const combinedPercentage = percentageAwards.reduce((s, p) => s + p, 0);
    discountAmount += totalAmount * (combinedPercentage / 100);
  }

  const payload: Record<string, unknown> = {
    customer: customerId,
    currency: currencyCode,
    items,
    posting_date: new Date().toISOString().slice(0, 10),
    custom_school_id: schoolId,
  };
  if (discountAmount > 0) {
    payload.apply_discount_on = "Grand Total";
    payload.discount_amount = Math.round(discountAmount * 100) / 100;
  }
  if (params.dueDate) {
    payload.due_date = params.dueDate;
  }

  let doc: ErpNextSalesInvoiceDoc;
  try {
    const response = await client.post<{ data: ErpNextSalesInvoiceDoc }>(
      "/api/resource/Sales%20Invoice",
      payload,
    );
    doc = response.data.data;
  } catch (error) {
    if (error instanceof ErpNextError) {
      throw new CodedError(error.status, ERROR_CODES.INVOICE_GENERATION_FAILED, error.message);
    }
    throw error;
  }

  const row = await projectToCache(tx, schoolId, doc, {
    studentId: params.studentId,
    currencyCode,
    idempotencyKey,
  });

  return {
    idempotencyKey,
    studentId: params.studentId,
    erpnextDocname: row.erpnext_docname,
    status: "created",
  };
}

async function runConcurrent<T>(
  items: T[],
  fn: (item: T) => Promise<SingleInvoiceResult>,
  concurrency: number,
): Promise<SingleInvoiceResult[]> {
  const results: SingleInvoiceResult[] = [];
  let index = 0;

  const worker = async (): Promise<void> => {
    while (index < items.length) {
      const current = index++;
      try {
        results[current] = await fn(items[current]);
      } catch (error) {
        results[current] = {
          idempotencyKey: "",
          studentId: items[current] as unknown as string,
          erpnextDocname: null,
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

export interface StudentRef {
  id: string;
}

export async function generateBatchInvoices(
  tx: TransactionSql,
  sql: ReturnType<typeof import("postgres")>,
  schoolId: string,
  params: GenerateBatchInvoicesJobData,
  envBaseUrl: string | undefined,
  envApiKey: string | undefined,
): Promise<BatchInvoiceResult> {
  const conditions: string[] = [`school_id = '${schoolId}'`];
  if (params.classIds && params.classIds.length > 0) {
    const ids = params.classIds.map((id) => `'${id}'`).join(",");
    conditions.push(`class_id IN (${ids})`);
  }
  if (params.gradeIds && params.gradeIds.length > 0) {
    const ids = params.gradeIds.map((id) => `'${id}'`).join(",");
    conditions.push(`grade_id IN (${ids})`);
  }

  const sqlCondition = conditions.join(" AND ");

  const students = await sql.unsafe<StudentRef[]>(
    `SELECT id FROM app.students WHERE ${sqlCondition}`,
  );

  if (students.length === 0) {
    return { total: 0, succeeded: 0, alreadyExisted: 0, failed: [] };
  }

  const concurrency = 10;

  const results = await runConcurrent(
    students,
    async (student) => {
      const idempotencyKey = makeIdempotencyKey(
        schoolId,
        student.id,
        params.feeStructureErpnextName,
        params.periodTitle,
      );

      return sql.begin(async (subTx) => {
        await subTx`SELECT set_config('app.school_id', ${schoolId}, true)`.execute();
        await subTx.unsafe("SET LOCAL ROLE studafy_admin");

        return generateInvoice(
          subTx,
          schoolId,
          {
            version: 1,
            schoolId,
            studentId: student.id,
            feeStructureErpnextName: params.feeStructureErpnextName,
            idempotencyKey,
            periodTitle: params.periodTitle,
            dueDate: params.dueDate,
          },
          envBaseUrl,
          envApiKey,
        );
      });
    },
    concurrency,
  );

  const succeeded = results.filter((r) => r.status === "created").length;
  const alreadyExisted = results.filter((r) => r.status === "already_exists").length;
  const failed = results
    .filter((r) => r.status === "failed")
    .map((r) => ({ studentId: r.studentId, error: r.error ?? "Unknown error" }));

  return {
    total: students.length,
    succeeded,
    alreadyExisted,
    failed,
  };
}
