/**
 * The one correct way to write an ERPNext Fee Schedule into `app.fee_schedule_cache` (ST-121
 * follow-on).
 *
 * The fee arm of `projectToCache` in `erpnext/webhook.ts` had the same bugs the invoice and payment
 * arms had: an ISO currency *code* passed into the `currency_id` uuid foreign key and a raw decimal
 * `total_amount` into the bigint `total_amount_minor`, plus an admission number passed straight into
 * the nullable `academic_year_id`/`term_id` uuids. Every real payload tripped one of those. This arm
 * now delegates here and follows the shared ST-121 contract:
 *
 *   1. `currency` is a code; `fee_schedule_cache.currency_id` is a uuid. Resolve through
 *      `app.currencies`.
 *   2. `total_amount` is a decimal; `total_amount_minor` is an integer count of minor units.
 *      Convert with the currency's *own* exponent — JOD's is 3, so a `* 100` would silently divide
 *      by ten.
 *   3. `academic_year`/`term` are ERPNext names; the cache holds local uuids. Resolve them through
 *      `app.academic_years`/`app.terms` by code or name within the school — and drop a term whose
 *      year cannot be established, because `ck_fee_schedule_cache_term_requires_year` forbids it.
 *
 * Runs on a caller-supplied tenant transaction, like the invoice and payment projections, so the
 * write shares the RLS context and commit boundary of the outbox and audit rows around it.
 */

import { getCurrencyByCode, toMinorUnits } from "../currency";
import { upsertMapping } from "../id-mappings/service";
import { erpNextStatusFromDocstatus } from "../payments/projection";

import type { Logger } from "../../../logger";
import type { JSONValue, TransactionSql } from "postgres";

/**
 * The subset of an ERPNext Fee Schedule this projection reads. Loose on purpose: the document is
 * ERPNext's, it grows fields between versions, and the full payload is stored as JSONB anyway.
 */
export interface ErpNextFeeSchedule {
  name?: string | null;
  docstatus?: number | null;
  status?: string | null;
  currency?: string | null;
  total_amount?: number | string | null;
  grand_total?: number | string | null;
  fee_name?: string | null;
  title?: string | null;
  academic_year_id?: string | null;
  academic_year?: string | null;
  term_id?: string | null;
  term?: string | null;
  academic_term?: string | null;
  posting_date?: string | null;
  due_date?: string | null;
  custom_school_id?: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the local academic year a fee schedule belongs to, or `null` when the payload names none
 * and carries no local uuid. A uuid is trusted as-is; a name is matched by code or display name
 * within the school.
 */
async function resolveAcademicYear(
  tx: TransactionSql,
  schoolId: string,
  doc: ErpNextFeeSchedule,
): Promise<string | null> {
  const explicit = doc.academic_year_id?.trim();
  if (explicit && UUID_PATTERN.test(explicit)) return explicit;

  const code = doc.academic_year?.trim();
  if (!code) return null;

  const [row] = await tx<{ id: string }[]>`
    SELECT id
    FROM app.academic_years
    WHERE school_id = ${schoolId}::uuid AND (code = ${code} OR name = ${code})
  `;
  return row?.id ?? null;
}

/**
 * Resolve the local term, or `null`. A uuid must belong to the school — and, when a year was
 * resolved, to that year — or it is dropped rather than left to fail the composite foreign key.
 * A name is matched by code or display name within the school and, when known, the year.
 */
async function resolveTerm(
  tx: TransactionSql,
  schoolId: string,
  academicYearId: string | null,
  doc: ErpNextFeeSchedule,
): Promise<{ id: string; academic_year_id: string } | null> {
  const explicit = doc.term_id?.trim();
  if (explicit && UUID_PATTERN.test(explicit)) {
    const [row] = await tx<{ id: string; academic_year_id: string }[]>`
      SELECT id, academic_year_id
      FROM app.terms
      WHERE school_id = ${schoolId}::uuid
        AND id = ${explicit}::uuid
        AND (${academicYearId ?? null}::uuid IS NULL OR academic_year_id = ${academicYearId}::uuid)
    `;
    return row ?? null;
  }

  const byCode = doc.term?.trim() ?? doc.academic_term?.trim();
  if (!byCode) return null;

  const [row] = await tx<{ id: string; academic_year_id: string }[]>`
    SELECT id, academic_year_id
    FROM app.terms
    WHERE school_id = ${schoolId}::uuid
      AND (code = ${byCode} OR name = ${byCode})
      AND (${academicYearId ?? null}::uuid IS NULL OR academic_year_id = ${academicYearId}::uuid)
  `;
  return row ?? null;
}

export interface ProjectFeeScheduleResult {
  id: string;
  erpnext_docname: string;
  erpnext_status: string;
  title: string;
  /** Integer minor units, so callers can audit the amount without re-reading the row. */
  total_amount_minor: number;
  /** ISO 4217 code the amount is denominated in. */
  currency: string;
  academic_year_id: string | null;
  term_id: string | null;
}

/**
 * Upsert one ERPNext Fee Schedule into `app.fee_schedule_cache`.
 *
 * Returns `null` when the payload cannot be projected — no document name, an unknown currency, or
 * unusable amounts. A fee schedule is a template applied to a group of students, so an unresolvable
 * year or term does not block it: those stay null and only the term is dropped if its year cannot
 * be established (the schema forbids a term without a year). Callers answer the webhook 200 anyway;
 * the `erpnext_payload` JSONB keeps the raw document recoverable for a later backfill.
 */
export async function projectFeeScheduleEntry(
  tx: TransactionSql,
  schoolId: string,
  doc: ErpNextFeeSchedule,
  logger?: Logger,
): Promise<ProjectFeeScheduleResult | null> {
  const docname = doc.name?.trim();
  if (!docname) {
    logger?.warn(
      { school_id: schoolId },
      "fee schedule projection skipped: ERPNext document has no name",
    );
    return null;
  }

  const currencyCode = (doc.currency ?? "JOD").toUpperCase();
  const currency = await getCurrencyByCode(tx, currencyCode);
  if (!currency) {
    logger?.warn(
      { school_id: schoolId, erpnext_docname: docname, currency: currencyCode },
      "fee schedule projection skipped: unknown or inactive currency",
    );
    return null;
  }

  const totalAmount = Number(doc.total_amount ?? doc.grand_total ?? 0);
  if (!Number.isFinite(totalAmount) || totalAmount < 0) {
    logger?.warn(
      { school_id: schoolId, erpnext_docname: docname, totalAmount },
      "fee schedule projection skipped: unusable total_amount",
    );
    return null;
  }
  const totalMinor = toMinorUnits(totalAmount, currency.minorUnit);

  // title falls back to the document name, so it can never be empty (the CHECK forbids that).
  const title = String(doc.fee_name ?? doc.title ?? docname).trim();

  // The event that calls this is "submitted"-class; the default keeps the status CHECK satisfiable
  // when the payload carries neither docstatus nor a status word.
  const erpnextStatus =
    typeof doc.docstatus === "number"
      ? erpNextStatusFromDocstatus(doc.docstatus)
      : doc.status?.trim() || "submitted";

  const academicYearId = await resolveAcademicYear(tx, schoolId, doc);
  const term = await resolveTerm(tx, schoolId, academicYearId, doc);
  // A term's own year wins when the payload left the year ambiguous, so a term never trips
  // ck_fee_schedule_cache_term_requires_year.
  const termId = term?.id ?? null;
  const yearId = term?.academic_year_id ?? academicYearId;

  const [inserted] = await tx<{ id: string }[]>`
    INSERT INTO app.fee_schedule_cache (
      school_id, academic_year_id, term_id, currency_id, erpnext_docname,
      erpnext_status, title, total_amount_minor, erpnext_payload, last_synced_at
    ) VALUES (
      ${schoolId}::uuid,
      ${yearId ?? null}::uuid,
      ${termId ?? null}::uuid,
      ${currency.id}::uuid,
      ${docname},
      ${erpnextStatus},
      ${title},
      ${totalMinor.toString()}::bigint,
      ${tx.json(doc as unknown as JSONValue)}::jsonb,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT (school_id, erpnext_docname) DO UPDATE
      SET erpnext_status    = EXCLUDED.erpnext_status,
          title             = EXCLUDED.title,
          total_amount_minor = EXCLUDED.total_amount_minor,
          erpnext_payload   = EXCLUDED.erpnext_payload,
          last_synced_at    = EXCLUDED.last_synced_at,
          updated_at        = CURRENT_TIMESTAMP
    RETURNING id
  `;

  await upsertMapping(tx, schoolId, "fee_schedule", inserted!.id, docname);

  return {
    id: inserted!.id,
    erpnext_docname: docname,
    erpnext_status: erpnextStatus,
    title,
    total_amount_minor: Number(totalMinor),
    currency: currency.code,
    academic_year_id: yearId,
    term_id: termId,
  };
}
