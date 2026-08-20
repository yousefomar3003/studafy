/**
 * Invoice list/detail and batch-generation gateway (ST-202).
 *
 * Reads come from `app.invoice_cache` — the same webhook-fed read model
 * `../invoices/projection.ts` writes — never from ERPNext directly, so the list and detail screens
 * render even while ERPNext is briefly unavailable, matching the read posture
 * `fee-structures/service.ts` documents for its own cache.
 *
 * Batch generation itself does not call ERPNext from this module at all: `createInvoiceBatch` only
 * resolves the target student list and seeds `app.invoice_batches`/`app.invoice_batch_items`; the
 * actual per-student ERPNext calls happen in the worker (`apps/workers/.../billing/invoice.service.ts`,
 * job `GENERATE_BATCH_INVOICES`), which the route enqueues after this transaction commits.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { decodeKeysetCursor, encodeKeysetCursor } from "../../../lib/keyset-cursor";
import { formatMinorUnits } from "../currency";

import type { InvoiceBatchItemStatus, InvoiceBatchStatus, InvoiceStatus } from "./schemas";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InvoiceRow {
  id: string;
  school_id: string;
  student_id: string;
  student_name: string;
  admission_number: string;
  erpnext_docname: string;
  erpnext_status: string;
  total_amount: string;
  total_amount_minor: number;
  outstanding_amount: string;
  outstanding_amount_minor: number;
  currency: string;
  currency_minor_unit: number;
  issued_date: string;
  due_date: string | null;
  last_synced_at: Date;
}

export interface InvoiceLine {
  fee_category: string;
  description: string | null;
  quantity: number;
  amount: number;
}

export interface InvoiceDetail extends InvoiceRow {
  lines: InvoiceLine[];
}

export interface ListInvoicesParams {
  limit: number;
  cursor?: string;
  status?: InvoiceStatus;
  student_id?: string;
  search?: string;
}

export interface InvoiceBatchRow {
  id: string;
  school_id: string;
  created_by: string;
  status: InvoiceBatchStatus;
  fee_structure_erpnext_name: string;
  period_title: string;
  due_date: string | null;
  target_class_ids: string[] | null;
  total_count: number;
  succeeded_count: number;
  already_existed_count: number;
  failed_count: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface InvoiceBatchItemRow {
  id: string;
  batch_id: string;
  student_id: string;
  student_name: string;
  admission_number: string;
  status: InvoiceBatchItemStatus;
  erpnext_docname: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateInvoiceBatchParams {
  fee_structure_erpnext_name: string;
  period_title: string;
  due_date?: string;
  target_class_ids?: string[];
}

const MAX_BATCH_TARGET_STUDENTS = 5000;

// ---------------------------------------------------------------------------
// Row shaping
// ---------------------------------------------------------------------------

const INVOICE_COLUMNS = `
  ic.id,
  ic.school_id,
  ic.student_id,
  s.first_name,
  s.last_name,
  s.admission_number,
  ic.erpnext_docname,
  ic.erpnext_status,
  ic.total_amount_minor,
  ic.outstanding_amount_minor,
  cur.code AS currency,
  cur.minor_unit AS currency_minor_unit,
  ic.issued_date::text AS issued_date,
  ic.due_date::text AS due_date,
  ic.last_synced_at,
  ic.erpnext_payload
`;

interface RawInvoiceRow {
  id: string;
  school_id: string;
  student_id: string;
  first_name: string;
  last_name: string;
  admission_number: string;
  erpnext_docname: string;
  erpnext_status: string;
  total_amount_minor: string | number;
  outstanding_amount_minor: string | number;
  currency: string;
  currency_minor_unit: number;
  issued_date: string;
  due_date: string | null;
  last_synced_at: Date;
  erpnext_payload: unknown;
}

function parseInvoiceRow(row: RawInvoiceRow): InvoiceRow {
  const minorUnit = row.currency_minor_unit;
  const totalMinor = BigInt(row.total_amount_minor);
  const outstandingMinor = BigInt(row.outstanding_amount_minor);

  return {
    id: row.id,
    school_id: row.school_id,
    student_id: row.student_id,
    student_name: [row.first_name, row.last_name].filter(Boolean).join(" "),
    admission_number: row.admission_number,
    erpnext_docname: row.erpnext_docname,
    erpnext_status: row.erpnext_status,
    total_amount: formatMinorUnits(totalMinor, minorUnit),
    total_amount_minor: Number(totalMinor),
    outstanding_amount: formatMinorUnits(outstandingMinor, minorUnit),
    outstanding_amount_minor: Number(outstandingMinor),
    currency: row.currency,
    currency_minor_unit: minorUnit,
    issued_date: row.issued_date,
    due_date: row.due_date,
    last_synced_at: row.last_synced_at,
  };
}

/**
 * ERPNext Sales Invoice Item fields, defensively read. `erpnext_payload.items` is ERPNext's own
 * document, not something this gateway schemas — an item missing `item_code` is dropped rather than
 * guessed at, matching `projection.ts`'s "refuse to guess" posture for the invoice as a whole.
 */
export function parseInvoiceLines(payload: unknown): InvoiceLine[] {
  if (payload === null || typeof payload !== "object") return [];
  const items = (payload as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];

  const lines: InvoiceLine[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const feeCategory = record.item_code ?? record.item_name;
    const amount = record.amount ?? record.rate;
    if (typeof feeCategory !== "string" || !feeCategory) continue;
    if (typeof amount !== "number" && typeof amount !== "string") continue;
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount)) continue;

    lines.push({
      fee_category: feeCategory,
      description: typeof record.description === "string" ? record.description : null,
      quantity: typeof record.qty === "number" ? record.qty : 1,
      amount: numericAmount,
    });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Invoice list / detail
// ---------------------------------------------------------------------------

/**
 * Paginated invoices for a school. **Exact-match fast path**: when `search` is given, this first
 * runs a single point lookup on `erpnext_docname` — the invoice number — which hits
 * `uq_invoice_cache_school_erpnext_docname` (migration 000015) as an index equality scan, no join,
 * no `ILIKE`. Only when that finds nothing does it fall back to a joined, paginated `ILIKE` search
 * over the student's name/admission number. The two are genuinely separate queries (not one `OR`
 * clause left to the planner), so "search by number" stays fast regardless of table size.
 */
export async function listInvoices(
  tx: TransactionSql,
  schoolId: string,
  params: ListInvoicesParams,
): Promise<{ rows: InvoiceRow[]; next_cursor: string | null }> {
  if (params.search) {
    const statusFilter = params.status ? tx` AND ic.erpnext_status = ${params.status}` : tx``;

    const [exact] = await tx<RawInvoiceRow[]>`
      SELECT ${tx.unsafe(INVOICE_COLUMNS)}
      FROM app.invoice_cache ic
      JOIN app.students s ON s.id = ic.student_id AND s.school_id = ic.school_id
      JOIN app.currencies cur ON cur.id = ic.currency_id
      WHERE ic.school_id = ${schoolId}::uuid
        AND ic.erpnext_docname = ${params.search}
        ${statusFilter}
    `;
    if (exact) {
      return { rows: [parseInvoiceRow(exact)], next_cursor: null };
    }
  }

  const statusFilter = params.status ? tx` AND ic.erpnext_status = ${params.status}` : tx``;
  const studentFilter = params.student_id
    ? tx` AND ic.student_id = ${params.student_id}::uuid`
    : tx``;
  const searchFilter = params.search
    ? tx` AND (
        s.first_name ILIKE ${`%${params.search}%`}
        OR s.last_name ILIKE ${`%${params.search}%`}
        OR s.admission_number ILIKE ${`%${params.search}%`}
      )`
    : tx``;
  const cursorFilter = params.cursor
    ? (() => {
        const { created_at, id } = decodeKeysetCursor(params.cursor!);
        return tx` AND (ic.last_synced_at, ic.id) < (${created_at}::timestamptz, ${id}::uuid)`;
      })()
    : tx``;

  const limit = params.limit + 1;

  const rows = await tx<RawInvoiceRow[]>`
    SELECT ${tx.unsafe(INVOICE_COLUMNS)}
    FROM app.invoice_cache ic
    JOIN app.students s ON s.id = ic.student_id AND s.school_id = ic.school_id
    JOIN app.currencies cur ON cur.id = ic.currency_id
    WHERE ic.school_id = ${schoolId}::uuid
      ${statusFilter}
      ${studentFilter}
      ${searchFilter}
      ${cursorFilter}
    ORDER BY ic.last_synced_at DESC, ic.id DESC
    LIMIT ${limit}
  `;

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, params.limit) : rows;
  const lastRow = sliced[sliced.length - 1];
  const next_cursor =
    hasMore && lastRow ? encodeKeysetCursor(lastRow.last_synced_at, lastRow.id) : null;

  return { rows: sliced.map(parseInvoiceRow), next_cursor };
}

export async function getInvoiceDetail(
  tx: TransactionSql,
  schoolId: string,
  invoiceId: string,
): Promise<InvoiceDetail> {
  const [row] = await tx<RawInvoiceRow[]>`
    SELECT ${tx.unsafe(INVOICE_COLUMNS)}
    FROM app.invoice_cache ic
    JOIN app.students s ON s.id = ic.student_id AND s.school_id = ic.school_id
    JOIN app.currencies cur ON cur.id = ic.currency_id
    WHERE ic.id = ${invoiceId}::uuid AND ic.school_id = ${schoolId}::uuid
  `;

  if (!row) {
    throw new CodedHttpException(404, ERROR_CODES.INVOICE_NOT_FOUND, "Invoice not found");
  }

  return { ...parseInvoiceRow(row), lines: parseInvoiceLines(row.erpnext_payload) };
}

// ---------------------------------------------------------------------------
// Batch generation
// ---------------------------------------------------------------------------

/**
 * Resolve the target student ids for a batch, without the broken `class_id`/`grade_id` filter the
 * worker's old inline query assumed existed on `app.students` (it never did — class membership
 * lives in `app.enrollments`; see migration 000009). Only actively `enrolled` students, and only
 * students actively enrolled in one of the given classes when `classIds` is provided.
 */
async function resolveTargetStudentIds(
  tx: TransactionSql,
  schoolId: string,
  classIds: string[] | undefined,
): Promise<string[]> {
  if (classIds && classIds.length > 0) {
    const rows = await tx<{ id: string }[]>`
      SELECT DISTINCT s.id
      FROM app.students s
      JOIN app.enrollments e
        ON e.student_id = s.id AND e.school_id = s.school_id AND e.status = 'active'
      WHERE s.school_id = ${schoolId}::uuid
        AND s.status = 'enrolled'
        AND e.class_id = ANY(${classIds}::uuid[])
    `;
    return rows.map((r) => r.id);
  }

  const rows = await tx<{ id: string }[]>`
    SELECT id FROM app.students
    WHERE school_id = ${schoolId}::uuid AND status = 'enrolled'
  `;
  return rows.map((r) => r.id);
}

function parseBatchRow(row: Record<string, unknown>): InvoiceBatchRow {
  return {
    id: row.id as string,
    school_id: row.school_id as string,
    created_by: row.created_by as string,
    status: row.status as InvoiceBatchStatus,
    fee_structure_erpnext_name: row.fee_structure_erpnext_name as string,
    period_title: row.period_title as string,
    due_date: row.due_date as string | null,
    target_class_ids: row.target_class_ids as string[] | null,
    total_count: row.total_count as number,
    succeeded_count: row.succeeded_count as number,
    already_existed_count: row.already_existed_count as number,
    failed_count: row.failed_count as number,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
    completed_at: row.completed_at as Date | null,
  };
}

// `target_class_ids` is read via a correlated subquery against the junction table
// app.invoice_batch_target_classes (see migration 000107's doc comment for why it's a junction
// table rather than an array column) — only valid once that table's rows exist, so this is used by
// the read queries below, never by the INSERT...RETURNING in createInvoiceBatch.
const BATCH_COLUMNS = `
  ib.id, ib.school_id, ib.created_by, ib.status, ib.fee_structure_erpnext_name, ib.period_title,
  ib.due_date::text AS due_date,
  (SELECT array_agg(itc.class_id ORDER BY itc.class_id)
     FROM app.invoice_batch_target_classes itc
     WHERE itc.batch_id = ib.id) AS target_class_ids,
  ib.total_count, ib.succeeded_count, ib.already_existed_count, ib.failed_count,
  ib.created_at, ib.updated_at, ib.completed_at
`;

/**
 * Create a batch generation run: resolves the target students, inserts the `invoice_batches`
 * header, one `invoice_batch_target_classes` row per targeted class (if any), and one `pending`
 * `invoice_batch_items` row per student, then returns the batch. Does not enqueue the worker job —
 * the route does that after this transaction commits, so a job is never dispatched for a batch
 * whose insert then rolls back.
 */
export async function createInvoiceBatch(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  params: CreateInvoiceBatchParams,
): Promise<InvoiceBatchRow> {
  const studentIds = await resolveTargetStudentIds(tx, schoolId, params.target_class_ids);

  if (studentIds.length === 0) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.INVOICE_BATCH_NO_STUDENTS,
      "No students matched the batch's target filters",
    );
  }
  if (studentIds.length > MAX_BATCH_TARGET_STUDENTS) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.INVOICE_BATCH_TOO_LARGE,
      `Batch would target ${studentIds.length} students; the maximum is ${MAX_BATCH_TARGET_STUDENTS}`,
    );
  }

  const [batch] = await tx<Record<string, unknown>[]>`
    INSERT INTO app.invoice_batches (
      school_id, created_by, fee_structure_erpnext_name, period_title, due_date, total_count
    ) VALUES (
      ${schoolId}::uuid,
      ${userId}::uuid,
      ${params.fee_structure_erpnext_name},
      ${params.period_title},
      ${params.due_date ?? null},
      ${studentIds.length}
    )
    RETURNING id, school_id, created_by, status, fee_structure_erpnext_name, period_title,
              due_date::text AS due_date,
              total_count, succeeded_count, already_existed_count, failed_count,
              created_at, updated_at, completed_at
  `;
  if (!batch) {
    throw new CodedHttpException(500, ERROR_CODES.VALIDATION_FAILED, "Failed to create batch");
  }
  const batchId = batch.id as string;

  if (params.target_class_ids && params.target_class_ids.length > 0) {
    await tx`
      INSERT INTO app.invoice_batch_target_classes (batch_id, school_id, class_id)
      SELECT ${batchId}::uuid, ${schoolId}::uuid, class_id
      FROM unnest(${params.target_class_ids}::uuid[]) AS class_id
    `;
  }

  await tx`
    INSERT INTO app.invoice_batch_items (batch_id, school_id, student_id)
    SELECT ${batchId}::uuid, ${schoolId}::uuid, student_id
    FROM unnest(${studentIds}::uuid[]) AS student_id
  `;

  return { ...parseBatchRow(batch), target_class_ids: params.target_class_ids ?? null };
}

export async function listInvoiceBatches(
  tx: TransactionSql,
  schoolId: string,
  params: { limit: number; cursor?: string },
): Promise<{ rows: InvoiceBatchRow[]; next_cursor: string | null }> {
  const cursorFilter = params.cursor
    ? (() => {
        const { created_at, id } = decodeKeysetCursor(params.cursor!);
        return tx` AND (created_at, id) < (${created_at}::timestamptz, ${id}::uuid)`;
      })()
    : tx``;

  const limit = params.limit + 1;

  const rows = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(BATCH_COLUMNS)}
    FROM app.invoice_batches ib
    WHERE ib.school_id = ${schoolId}::uuid
      ${cursorFilter}
    ORDER BY ib.created_at DESC, ib.id DESC
    LIMIT ${limit}
  `;

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, params.limit) : rows;
  const lastRow = sliced[sliced.length - 1];
  const next_cursor =
    hasMore && lastRow
      ? encodeKeysetCursor(lastRow.created_at as Date, lastRow.id as string)
      : null;

  return { rows: sliced.map(parseBatchRow), next_cursor };
}

export async function getInvoiceBatch(
  tx: TransactionSql,
  schoolId: string,
  batchId: string,
): Promise<InvoiceBatchRow> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(BATCH_COLUMNS)}
    FROM app.invoice_batches ib
    WHERE ib.id = ${batchId}::uuid AND ib.school_id = ${schoolId}::uuid
  `;
  if (!row) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.INVOICE_BATCH_NOT_FOUND,
      "Invoice batch not found",
    );
  }
  return parseBatchRow(row);
}

export async function getInvoiceBatchItems(
  tx: TransactionSql,
  schoolId: string,
  batchId: string,
  params: { limit: number; cursor?: string; status?: InvoiceBatchItemStatus },
): Promise<{ rows: InvoiceBatchItemRow[]; next_cursor: string | null }> {
  // Confirms the batch exists (and belongs to this school) before paging its items, matching
  // `getBulkInviteRecipients`'s shape in bulk-invite-service.ts.
  await getInvoiceBatch(tx, schoolId, batchId);

  const statusFilter = params.status
    ? tx` AND ibi.status = ${params.status}::app.invoice_batch_item_status`
    : tx``;
  const cursorFilter = params.cursor
    ? (() => {
        const { created_at, id } = decodeKeysetCursor(params.cursor!);
        return tx` AND (ibi.created_at, ibi.id) < (${created_at}::timestamptz, ${id}::uuid)`;
      })()
    : tx``;

  const limit = params.limit + 1;

  const rows = await tx<
    {
      id: string;
      batch_id: string;
      student_id: string;
      first_name: string;
      last_name: string;
      admission_number: string;
      status: InvoiceBatchItemStatus;
      erpnext_docname: string | null;
      error_message: string | null;
      created_at: Date;
      updated_at: Date;
    }[]
  >`
    SELECT ibi.id, ibi.batch_id, ibi.student_id,
           s.first_name, s.last_name, s.admission_number,
           ibi.status, ibi.erpnext_docname, ibi.error_message,
           ibi.created_at, ibi.updated_at
    FROM app.invoice_batch_items ibi
    JOIN app.students s ON s.id = ibi.student_id AND s.school_id = ibi.school_id
    WHERE ibi.batch_id = ${batchId}::uuid
      AND ibi.school_id = ${schoolId}::uuid
      ${statusFilter}
      ${cursorFilter}
    ORDER BY ibi.created_at DESC, ibi.id DESC
    LIMIT ${limit}
  `;

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, params.limit) : rows;
  const lastRow = sliced[sliced.length - 1];
  const next_cursor =
    hasMore && lastRow ? encodeKeysetCursor(lastRow.created_at, lastRow.id) : null;

  return {
    rows: sliced.map((row) => ({
      id: row.id,
      batch_id: row.batch_id,
      student_id: row.student_id,
      student_name: [row.first_name, row.last_name].filter(Boolean).join(" "),
      admission_number: row.admission_number,
      status: row.status,
      erpnext_docname: row.erpnext_docname,
      error_message: row.error_message,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
    next_cursor,
  };
}
