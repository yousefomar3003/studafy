/**
 * The one correct way to write an ERPNext Sales Invoice into `app.invoice_cache` (ST-121 follow-on).
 *
 * The invoice and fee arms of `projectToCache` in `erpnext/webhook.ts` had exactly the bugs the
 * payment arm had before ST-121 replaced it: `String(data.student_id ?? data.customer ?? "")` into
 * a `uuid NOT NULL` column, an ISO currency *code* into the `currency_id` uuid foreign key, and a
 * raw decimal `grand_total` into the bigint `total_amount_minor`. Every real payload tripped one of
 * those — the webhook could never have cached an invoice. Those arms now delegate here (and to
 * `fee-schedules/projection.ts`), so all three finance projections share the ST-121 contract:
 *
 *   1. `currency` is a code; `invoice_cache.currency_id` is a uuid. Resolve through `app.currencies`.
 *   2. `grand_total`/`outstanding_amount` are decimals; `*_amount_minor` are integer counts of minor
 *      units. Convert with the currency's *own* exponent — JOD's is 3, so a `* 100` would silently
 *      divide by ten.
 *   3. `customer` is an ERPNext Customer name; `student_id` is a local uuid. Unlike payments, this
 *      resolution is honest: this gateway *creates* the ERPNext Customer named after the student's
 *      admission number (`buildStudentCustomerId` in apps/workers/.../billing/invoice.service.ts),
 *      so a Sales Invoice's Customer resolves through `normalized_admission_number`. Refuse to guess.
 *
 * Runs on a caller-supplied tenant transaction — never on a bare pool connection — so the write is
 * covered by the same RLS context and commit boundary as the outbox and audit rows the caller writes
 * alongside it. The old inline version used `db.unsafe` outside that transaction, so a projection
 * could survive a rolled-back ingestion.
 */

import { getCurrencyByCode, toMinorUnits } from "../currency";
import { upsertMapping } from "../id-mappings/service";
import { erpNextStatusFromDocstatus } from "../payments/projection";

import type { Logger } from "../../../logger";
import type { JSONValue, TransactionSql } from "postgres";

/**
 * The subset of an ERPNext Sales Invoice this projection reads. Loose on purpose: the document is
 * ERPNext's, it grows fields between versions, and the full payload is stored as JSONB anyway.
 */
export interface ErpNextSalesInvoice {
  name?: string | null;
  docstatus?: number | null;
  status?: string | null;
  currency?: string | null;
  grand_total?: number | string | null;
  total?: number | string | null;
  outstanding_amount?: number | string | null;
  posting_date?: string | null;
  transaction_date?: string | null;
  due_date?: string | null;
  customer?: string | null;
  /** Set by this gateway when it forwards the document, so the student never needs guessing. */
  custom_student_id?: string | null;
  /** Accepted for callers that already pass the local student uuid under the ERPNext field name. */
  student_id?: string | null;
  custom_school_id?: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the local student an invoice belongs to, or `null` if it genuinely cannot be determined.
 *
 * Three sources, most trustworthy first. Returning `null` rather than a placeholder is deliberate:
 * `invoice_cache.student_id` is a NOT NULL foreign key to `app.students`, so a guess is not merely
 * inaccurate — it either fails the constraint or attributes a charge to the wrong student.
 */
async function resolveStudentId(
  tx: TransactionSql,
  schoolId: string,
  doc: ErpNextSalesInvoice,
): Promise<string | null> {
  // 1. The custom field this gateway can stamp when it forwards the document.
  const custom = doc.custom_student_id?.trim();
  if (custom && UUID_PATTERN.test(custom)) return custom;

  // 2. A caller that already knows the local uuid.
  const direct = doc.student_id?.trim();
  if (direct && UUID_PATTERN.test(direct)) return direct;

  // 3. The ERPNext Customer this gateway created — `buildStudentCustomerId` names it after the
  //    student's admission number, so the name resolves through the normalized admission number.
  //    app.students carries a restrictive role_scope_visibility SELECT policy (000037) that returns
  //    no rows to a userless studafy_app caller (a webhook has no authenticated user), so this runs
  //    through the SECURITY DEFINER helper app.find_student_id_by_admission_number (000076), which
  //    skips the scope policy while tenant_isolation still confines it to the current school.
  const customer = doc.customer?.trim();
  if (!customer) return null;
  const [row] = await tx<{ id: string | null }[]>`
    SELECT app.find_student_id_by_admission_number(${customer}) AS id
  `;
  return row?.id ?? null;
}

export interface ProjectInvoiceResult {
  id: string;
  erpnext_docname: string;
  erpnext_status: string;
  /** Integer minor units, so callers can audit the amount without re-reading the row. */
  total_amount_minor: number;
  outstanding_amount_minor: number;
  /** ISO 4217 code the amounts are denominated in. */
  currency: string;
  student_id: string;
}

/**
 * Upsert one ERPNext Sales Invoice into `app.invoice_cache`.
 *
 * Returns `null` when the payload cannot be projected — no document name, an unknown currency,
 * unusable amounts, or an unresolvable student. Callers answer the webhook 200 anyway: the delivery
 * was understood, and making ERPNext retry forever over a payload we will never be able to place is
 * worse than a logged gap. The `erpnext_payload` JSONB means the raw document is still recoverable
 * for a later backfill.
 */
export async function projectInvoiceEntry(
  tx: TransactionSql,
  schoolId: string,
  doc: ErpNextSalesInvoice,
  logger?: Logger,
): Promise<ProjectInvoiceResult | null> {
  const docname = doc.name?.trim();
  if (!docname) {
    logger?.warn(
      { school_id: schoolId },
      "invoice projection skipped: ERPNext document has no name",
    );
    return null;
  }

  const currencyCode = (doc.currency ?? "JOD").toUpperCase();
  const currency = await getCurrencyByCode(tx, currencyCode);
  if (!currency) {
    logger?.warn(
      { school_id: schoolId, erpnext_docname: docname, currency: currencyCode },
      "invoice projection skipped: unknown or inactive currency",
    );
    return null;
  }

  const totalAmount = Number(doc.grand_total ?? doc.total ?? 0);
  const outstandingAmount = Number(doc.outstanding_amount ?? doc.grand_total ?? doc.total ?? 0);
  // ck_invoice_cache_amounts already forbids outstanding > total; reject here with a log rather
  // than a constraint violation that surfaces as a 500 after the outbox committed.
  if (
    !Number.isFinite(totalAmount) ||
    totalAmount < 0 ||
    !Number.isFinite(outstandingAmount) ||
    outstandingAmount < 0 ||
    outstandingAmount > totalAmount
  ) {
    logger?.warn(
      { school_id: schoolId, erpnext_docname: docname, totalAmount, outstandingAmount },
      "invoice projection skipped: unusable amounts",
    );
    return null;
  }
  const totalMinor = toMinorUnits(totalAmount, currency.minorUnit);
  const outstandingMinor = toMinorUnits(outstandingAmount, currency.minorUnit);

  // The events that call this are "submitted"-class, so a payload with neither docstatus nor a
  // status word still means the invoice exists. The default keeps the CHECK (non-empty) satisfiable
  // without inventing a status that conflicts with ERPNext's own vocabulary.
  const erpnextStatus =
    typeof doc.docstatus === "number"
      ? erpNextStatusFromDocstatus(doc.docstatus)
      : doc.status?.trim() || "submitted";

  const issuedDate =
    doc.posting_date ?? doc.transaction_date ?? new Date().toISOString().slice(0, 10);
  const dueDate = doc.due_date?.trim() ? doc.due_date : null;

  const studentId = await resolveStudentId(tx, schoolId, doc);
  if (!studentId) {
    logger?.warn(
      { school_id: schoolId, erpnext_docname: docname, customer: doc.customer },
      "invoice projection skipped: could not resolve a local student for this invoice",
    );
    return null;
  }

  const [inserted] = await tx<{ id: string }[]>`
    INSERT INTO app.invoice_cache (
      school_id, student_id, currency_id, erpnext_docname, erpnext_status,
      total_amount_minor, outstanding_amount_minor, issued_date, due_date,
      erpnext_payload, last_synced_at
    ) VALUES (
      ${schoolId}::uuid,
      ${studentId}::uuid,
      ${currency.id}::uuid,
      ${docname},
      ${erpnextStatus},
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
    RETURNING id
  `;

  await upsertMapping(tx, schoolId, "invoice", inserted!.id, docname);

  return {
    id: inserted!.id,
    erpnext_docname: docname,
    erpnext_status: erpnextStatus,
    total_amount_minor: Number(totalMinor),
    outstanding_amount_minor: Number(outstandingMinor),
    currency: currency.code,
    student_id: studentId,
  };
}
