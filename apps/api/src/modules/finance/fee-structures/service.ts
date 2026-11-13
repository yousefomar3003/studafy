/**
 * Fee structure gateway (ST-119).
 *
 * A pass-through, in the strict sense: this module carries requests to ERPNext and answers back.
 * It does not validate amounts, compute totals, decide whether a fee category exists, or enforce
 * currency rules. ERPNext owns all of it, and a second opinion here would drift from the first.
 *
 * What this module *does* own is the three things ERPNext cannot know about:
 *
 *   1. **Which site to talk to** — via the tenant client, whose Host header selects the school.
 *   2. **The identity crosswalk** — ERPNext names documents `FS-2026-0001`; everything local is a
 *      UUID. `app.erpnext_id_mappings` relates them.
 *   3. **The read model** — `app.fee_structure_cache`, so the builder can list and filter without
 *      a round trip per keystroke, and so a list still renders when ERPNext is briefly down.
 *
 * Reads come from the cache. Writes go to ERPNext and then refresh the cache row for the document
 * that was just written, so the caller sees their own change immediately rather than waiting for
 * the webhook. The webhook remains the authority for changes made *in* ERPNext.
 *
 * ## Version immutability
 *
 * The ticket asks that updates not disturb previously issued invoices. That is ERPNext's own
 * amendment behaviour — a submitted Fee Structure is immutable, and changing it produces a new
 * document while existing Sales Invoices keep pointing at the old one. The correct implementation
 * here is therefore *not* to implement anything: forward the update, and let ERPNext refuse if the
 * document is submitted. Working around that refusal would be the bug.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { ErpNextError } from "../../../erpnext/client";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { formatMinorUnits, getCurrencyByCode, toMinorUnits } from "../currency";
import { upsertMapping } from "../id-mappings/service";

import type { TenantErpNext } from "../client/tenant-client";
import type { JSONValue, TransactionSql } from "postgres";

const FEE_STRUCTURE_DOCTYPE = "Fee Structure";
const RESOURCE_PATH = "/api/resource/Fee%20Structure";

export interface FeeStructureRow {
  erpnext_name: string;
  school_id: string;
  academic_year_id: string | null;
  program: string | null;
  title: string;
  total_amount: string;
  total_amount_minor: number;
  currency: string;
  currency_minor_unit: number;
  erpnext_status: string;
  is_active: boolean;
  last_synced_at: Date;
}

export interface ListFeeStructuresParams {
  academic_year_id?: string;
  program?: string;
  limit: number;
  offset: number;
}

export interface FeeComponentInput {
  fee_category: string;
  amount: number;
  description?: string;
}

export interface UpsertFeeStructureParams {
  title?: string;
  academic_year_id?: string;
  program?: string;
  currency?: string;
  components?: FeeComponentInput[];
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

/**
 * Turn an ErpNextError into the app's RFC 9457 envelope.
 *
 * 4xx keeps ERPNext's own message, because that message is the product: the Fee Structure Builder
 * shows it to the user, in their language, exactly as ERPNext phrased it. 5xx and transport
 * failures do not — they get a canonical code and no upstream detail, matching the app's rule that
 * a 5xx never carries `detail`.
 */
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
    throw new CodedHttpException(
      404,
      ERROR_CODES.FEE_STRUCTURE_NOT_FOUND,
      "Fee structure not found",
    );
  }
  if (error.status >= 500) {
    throw new CodedHttpException(503, ERROR_CODES.ERPNEXT_UNAVAILABLE, "ERPNext is unreachable");
  }

  // 4xx: ERPNext's verdict, forwarded intact. Its message has already been scrubbed of any
  // credential echo by the client.
  throw new CodedHttpException(
    error.status === 429 ? 429 : 400,
    error.status === 429 ? ERROR_CODES.RATE_LIMIT_EXCEEDED : ERROR_CODES.VALIDATION_FAILED,
    error.message,
  );
}

// ---------------------------------------------------------------------------
// Cache projection
// ---------------------------------------------------------------------------

const CACHE_COLUMNS = `
  fsc.erpnext_docname AS erpnext_name,
  fsc.school_id,
  fsc.academic_year_id,
  fsc.program_erpnext_name AS program,
  fsc.title,
  fsc.total_amount_minor,
  fsc.erpnext_status,
  fsc.is_active,
  fsc.last_synced_at,
  c.code AS currency,
  c.minor_unit AS currency_minor_unit
`;

function parseCacheRow(row: Record<string, unknown>): FeeStructureRow {
  const minorUnit = row.currency_minor_unit as number;
  const minor = BigInt(row.total_amount_minor as string | number);

  return {
    erpnext_name: row.erpnext_name as string,
    school_id: row.school_id as string,
    academic_year_id: row.academic_year_id as string | null,
    program: row.program as string | null,
    title: row.title as string,
    total_amount: formatMinorUnits(minor, minorUnit),
    total_amount_minor: Number(minor),
    currency: row.currency as string,
    currency_minor_unit: minorUnit,
    erpnext_status: row.erpnext_status as string,
    is_active: row.is_active as boolean,
    last_synced_at: row.last_synced_at as Date,
  };
}

interface ErpNextFeeStructureDoc {
  name?: string;
  program?: string | null;
  total_amount?: number | string | null;
  currency?: string | null;
  docstatus?: number | null;
  disabled?: number | boolean | null;
}

/** ERPNext docstatus: 0 draft, 1 submitted, 2 cancelled. */
function statusFromDocstatus(docstatus: number | null | undefined): string {
  if (docstatus === 1) return "submitted";
  if (docstatus === 2) return "cancelled";
  return "draft";
}

/**
 * Write the cache row for a document ERPNext just confirmed, and record the crosswalk.
 *
 * Keyed on `(school_id, erpnext_docname)` — the unique constraint from migration 000061 — so a
 * re-sync updates in place. `last_synced_at` is set from the database clock rather than the
 * application's, so cache freshness is comparable across API tasks.
 */
async function projectToCache(
  tx: TransactionSql,
  schoolId: string,
  doc: ErpNextFeeStructureDoc,
  params: { title: string; academicYearId: string | null },
): Promise<FeeStructureRow> {
  const erpnextName = doc.name;
  if (!erpnextName) {
    throw new CodedHttpException(
      502,
      ERROR_CODES.ERPNEXT_UNAVAILABLE,
      "ERPNext returned a fee structure with no document name",
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
  const totalMinor = toMinorUnits(totalAmount, currency.minorUnit);
  const isActive = !(doc.disabled === 1 || doc.disabled === true);

  const [row] = await tx<Record<string, unknown>[]>`
    INSERT INTO app.fee_structure_cache (
      school_id, academic_year_id, program_erpnext_name, currency_id,
      erpnext_docname, erpnext_status, title, total_amount_minor, is_active,
      erpnext_payload, last_synced_at
    ) VALUES (
      ${schoolId}::uuid,
      ${params.academicYearId}::uuid,
      ${doc.program ?? null},
      ${currency.id}::uuid,
      ${erpnextName},
      ${statusFromDocstatus(doc.docstatus)},
      ${params.title},
      ${totalMinor.toString()}::bigint,
      ${isActive},
      ${tx.json(doc as unknown as JSONValue)}::jsonb,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT (school_id, erpnext_docname) DO UPDATE
      SET academic_year_id     = EXCLUDED.academic_year_id,
          program_erpnext_name = EXCLUDED.program_erpnext_name,
          currency_id          = EXCLUDED.currency_id,
          erpnext_status       = EXCLUDED.erpnext_status,
          title                = EXCLUDED.title,
          total_amount_minor   = EXCLUDED.total_amount_minor,
          is_active            = EXCLUDED.is_active,
          erpnext_payload      = EXCLUDED.erpnext_payload,
          last_synced_at       = EXCLUDED.last_synced_at,
          updated_at           = CURRENT_TIMESTAMP
    RETURNING id
  `;

  // The crosswalk keys on a local UUID; the cache row's id is the local identity of an
  // ERPNext-owned document, which is exactly what the mapping is for.
  await upsertMapping(tx, schoolId, "fee_structure", row!.id as string, erpnextName);

  const [projected] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(CACHE_COLUMNS)}
    FROM app.fee_structure_cache AS fsc
    JOIN app.currencies AS c ON c.id = fsc.currency_id
    WHERE fsc.school_id = ${schoolId}::uuid AND fsc.erpnext_docname = ${erpnextName}
  `;

  return parseCacheRow(projected!);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listFeeStructures(
  tx: TransactionSql,
  schoolId: string,
  params: ListFeeStructuresParams,
): Promise<{ rows: FeeStructureRow[]; total: number }> {
  const yearFilter = params.academic_year_id
    ? tx` AND fsc.academic_year_id = ${params.academic_year_id}::uuid`
    : tx``;
  const programFilter = params.program
    ? tx` AND fsc.program_erpnext_name = ${params.program}`
    : tx``;

  const [rows, [count]] = await Promise.all([
    tx<Record<string, unknown>[]>`
      SELECT ${tx.unsafe(CACHE_COLUMNS)}
      FROM app.fee_structure_cache AS fsc
      JOIN app.currencies AS c ON c.id = fsc.currency_id
      WHERE fsc.school_id = ${schoolId}::uuid${yearFilter}${programFilter}
      ORDER BY fsc.last_synced_at DESC, fsc.erpnext_docname
      LIMIT ${params.limit} OFFSET ${params.offset}
    `,
    tx<{ total: number }[]>`
      SELECT count(*)::int AS total
      FROM app.fee_structure_cache AS fsc
      WHERE fsc.school_id = ${schoolId}::uuid${yearFilter}${programFilter}
    `,
  ]);

  return { rows: rows.map(parseCacheRow), total: count?.total ?? 0 };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

function toErpNextComponents(components: FeeComponentInput[]): Record<string, unknown>[] {
  return components.map((component) => ({
    fees_category: component.fee_category,
    amount: component.amount,
    description: component.description ?? undefined,
  }));
}

export async function createFeeStructure(
  tx: TransactionSql,
  erpnext: TenantErpNext,
  schoolId: string,
  params: UpsertFeeStructureParams & { title: string; components: FeeComponentInput[] },
  acceptLanguage?: string,
): Promise<FeeStructureRow> {
  // custom_school_id is what the webhook path reads back to attribute an event to a tenant; a
  // document created without it would round-trip as orphaned.
  const payload: Record<string, unknown> = {
    fee_structure_name: params.title,
    currency: params.currency ?? "JOD",
    custom_school_id: schoolId,
    components: toErpNextComponents(params.components),
  };
  if (params.program) payload.program = params.program;

  let doc: ErpNextFeeStructureDoc;
  try {
    const response = await erpnext.post<{ data: ErpNextFeeStructureDoc }>(RESOURCE_PATH, payload, {
      acceptLanguage,
    });
    doc = response.data.data;
  } catch (error) {
    translateErpNextError(error);
  }

  const row = await projectToCache(tx, schoolId, doc, {
    title: params.title,
    academicYearId: params.academic_year_id ?? null,
  });

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "fee_structure_cache",
    targetId: schoolId,
    newValues: {
      erpnext_doctype: FEE_STRUCTURE_DOCTYPE,
      erpnext_name: row.erpnext_name,
      title: row.title,
      total_amount_minor: row.total_amount_minor,
      currency: row.currency,
    },
  });

  return row;
}

export async function updateFeeStructure(
  tx: TransactionSql,
  erpnext: TenantErpNext,
  schoolId: string,
  erpnextName: string,
  params: UpsertFeeStructureParams,
  acceptLanguage?: string,
): Promise<FeeStructureRow> {
  const [before] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(CACHE_COLUMNS)}
    FROM app.fee_structure_cache AS fsc
    JOIN app.currencies AS c ON c.id = fsc.currency_id
    WHERE fsc.school_id = ${schoolId}::uuid AND fsc.erpnext_docname = ${erpnextName}
  `;

  const payload: Record<string, unknown> = {};
  if (params.title !== undefined) payload.fee_structure_name = params.title;
  if (params.currency !== undefined) payload.currency = params.currency;
  if (params.program !== undefined) payload.program = params.program;
  if (params.components !== undefined) {
    payload.components = toErpNextComponents(params.components);
  }

  let doc: ErpNextFeeStructureDoc;
  try {
    // PUT on the resource path. A submitted document will be refused by ERPNext, and that refusal
    // is forwarded rather than worked around — see the note at the head of this file.
    const response = await erpnext.put<{ data: ErpNextFeeStructureDoc }>(
      `${RESOURCE_PATH}/${encodeURIComponent(erpnextName)}`,
      payload,
      { acceptLanguage },
    );
    doc = response.data.data;
  } catch (error) {
    translateErpNextError(error);
  }

  const previous = before ? parseCacheRow(before) : undefined;

  const row = await projectToCache(tx, schoolId, doc, {
    title: params.title ?? previous?.title ?? doc.name ?? erpnextName,
    academicYearId: params.academic_year_id ?? previous?.academic_year_id ?? null,
  });

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "fee_structure_cache",
    targetId: schoolId,
    // Never null: app.audit_logs' ck_audit_logs_payload requires an 'update' to carry both sides.
    // A missing cache row is itself the fact worth recording — it means this school had never
    // synced the document before the edit.
    oldValues: previous
      ? {
          erpnext_name: previous.erpnext_name,
          title: previous.title,
          total_amount_minor: previous.total_amount_minor,
          currency: previous.currency,
          erpnext_status: previous.erpnext_status,
        }
      : { erpnext_name: erpnextName, cached: false },
    newValues: {
      erpnext_name: row.erpnext_name,
      title: row.title,
      total_amount_minor: row.total_amount_minor,
      currency: row.currency,
      erpnext_status: row.erpnext_status,
    },
  });

  return row;
}
