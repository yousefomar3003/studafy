/**
 * The one correct way to write an ERPNext Payment Entry into `app.payment_cache` (ST-121).
 *
 * This module exists because there were previously *zero* correct ways. The payment arm of
 * `projectToCache` in `erpnext/webhook.ts` passed `String(data.student_id ?? data.party ?? "")` into
 * a `uuid` column, an ISO currency *code* into the `currency_id` uuid foreign key, and a raw decimal
 * `paid_amount` into `amount_minor`. Each of those is a hard failure on any real payload — the
 * webhook could never have projected a payment successfully. That arm now delegates here, so there
 * is a single implementation shared by the generic receiver and the dedicated payment-confirmed
 * endpoint.
 *
 * Three conversions are the whole point, and all three were the bugs:
 *
 *   1. `currency` is a code; `payment_cache.currency_id` is a uuid. Resolve through `app.currencies`.
 *   2. `paid_amount` is a decimal; `amount_minor` is an integer count of minor units. Convert with
 *      the currency's *own* exponent — JOD's is 3, so a `* 100` would silently divide by ten.
 *   3. `party` is an ERPNext Customer name; `student_id` is a local uuid. Resolve through the
 *      referenced invoice or an explicit custom field, and refuse to guess.
 */

import { getCurrencyByCode, toMinorUnits } from "../currency";
import { upsertMapping } from "../id-mappings/service";

import type { Logger } from "../../../logger";
import type { JSONValue, TransactionSql } from "postgres";

/**
 * The subset of an ERPNext Payment Entry this projection reads. Loose on purpose: the document is
 * ERPNext's, it grows fields between versions, and the full payload is stored as JSONB anyway.
 */
export interface ErpNextPaymentEntry {
  name?: string | null;
  docstatus?: number | null;
  currency?: string | null;
  paid_amount?: number | string | null;
  received_amount?: number | string | null;
  posting_date?: string | null;
  reference_date?: string | null;
  mode_of_payment?: string | null;
  party?: string | null;
  /** Set by this gateway when it forwards a payment, so the student never needs guessing. */
  custom_student_id?: string | null;
  custom_school_id?: string | null;
  /** Frappe's own print/receipt link, when the webhook is configured to include one. */
  receipt_url?: string | null;
  printview_url?: string | null;
  references?: {
    reference_doctype?: string | null;
    reference_name?: string | null;
  }[];
}

export type PaymentStatus = "pending" | "confirmed" | "failed";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ERPNext's `docstatus` in our vocabulary.
 *
 * 0 (draft) maps to `pending` rather than a status of its own: from the gateway's side a draft entry
 * is exactly "accepted, not yet confirmed". 2 (cancelled) maps to `failed` — the money did not move,
 * and a cancelled entry must not read as settled on a reconciliation screen.
 */
export function paymentStatusFromDocstatus(docstatus: number | null | undefined): PaymentStatus {
  if (docstatus === 1) return "confirmed";
  if (docstatus === 2) return "failed";
  return "pending";
}

/** ERPNext's own word for the docstatus, mirroring `statusFromDocstatus` in expenses/service.ts. */
export function erpNextStatusFromDocstatus(docstatus: number | null | undefined): string {
  if (docstatus === 1) return "submitted";
  if (docstatus === 2) return "cancelled";
  return "draft";
}

/** The Sales Invoice this entry was allocated against, if the payload names one. */
export function invoiceFromReferences(doc: ErpNextPaymentEntry): string | null {
  const reference = doc.references?.find(
    (row) => row.reference_doctype === "Sales Invoice" && row.reference_name,
  );
  return reference?.reference_name ?? null;
}

/**
 * The receipt link for a confirmed payment.
 *
 * Prefers whatever link ERPNext supplied; otherwise builds Frappe's standard printview path. The
 * result is a *path*, not an absolute URL, when we construct it: the tenant's site is selected by the
 * Host header rather than embedded in a stored URL, so persisting an absolute origin here would
 * outlive the routing decision that produced it. Nothing signed and nothing credential-bearing is
 * ever stored, so the value is safe to hand to a client verbatim.
 */
export function receiptUrlFor(doc: ErpNextPaymentEntry, docname: string): string | null {
  const supplied = doc.receipt_url ?? doc.printview_url;
  if (supplied && supplied.trim() !== "") return supplied.trim();
  return `/printview?doctype=Payment%20Entry&name=${encodeURIComponent(docname)}`;
}

/**
 * Resolve the local student a payment belongs to, or `null` if it genuinely cannot be determined.
 *
 * Three sources, most trustworthy first. Returning `null` rather than a placeholder is deliberate:
 * `payment_cache.student_id` is a NOT NULL foreign key to `app.students`, so a guess is not merely
 * inaccurate — it either fails the constraint or attributes someone's money to the wrong student.
 */
async function resolveStudentId(
  tx: TransactionSql,
  schoolId: string,
  doc: ErpNextPaymentEntry,
): Promise<string | null> {
  // 1. The custom field this gateway stamps on every payment it forwards.
  const custom = doc.custom_student_id?.trim();
  if (custom && UUID_PATTERN.test(custom)) return custom;

  // 2. The invoice the payment settles — invoice_cache already resolved that invoice's student when
  //    it was projected, so this inherits a resolution that was already checked once.
  const invoiceName = invoiceFromReferences(doc);
  if (invoiceName) {
    const [row] = await tx<{ student_id: string }[]>`
      SELECT student_id
      FROM app.invoice_cache
      WHERE school_id = ${schoolId}::uuid AND erpnext_docname = ${invoiceName}
    `;
    if (row) return row.student_id;
  }

  // 3. Nothing. `party` is an ERPNext Customer name and is not a local identifier; there is no
  //    honest fourth option.
  return null;
}

export interface ProjectPaymentResult {
  id: string;
  erpnext_docname: string;
  status: PaymentStatus;
  /** Integer minor units, so callers can audit the amount without re-reading the row. */
  amount_minor: number;
  /** ISO 4217 code the amount is denominated in. */
  currency: string;
  confirmed_at: Date | null;
}

/**
 * Upsert one ERPNext Payment Entry into `app.payment_cache`.
 *
 * Runs on a caller-supplied tenant transaction — never on a bare pool connection — so the write is
 * covered by the same RLS context and the same commit boundary as the audit row the caller writes
 * alongside it. (The old inline version in `erpnext/webhook.ts` used `db.unsafe` outside the
 * transaction that recorded the event, so a projection could survive a rolled-back ingestion.)
 *
 * Returns `null` when the payload cannot be projected — no document name, an unknown currency, or an
 * unresolvable student. Callers answer the webhook 200 anyway: the delivery was understood, and
 * making ERPNext retry forever over a payload we will never be able to place is worse than a logged
 * gap. The `erpnext_payload` JSONB means the raw document is still recoverable for a later backfill.
 */
export async function projectPaymentEntry(
  tx: TransactionSql,
  schoolId: string,
  doc: ErpNextPaymentEntry,
  logger?: Logger,
): Promise<ProjectPaymentResult | null> {
  const docname = doc.name?.trim();
  if (!docname) {
    logger?.warn(
      { school_id: schoolId },
      "payment projection skipped: ERPNext document has no name",
    );
    return null;
  }

  const currencyCode = (doc.currency ?? "JOD").toUpperCase();
  const currency = await getCurrencyByCode(tx, currencyCode);
  if (!currency) {
    logger?.warn(
      { school_id: schoolId, erpnext_docname: docname, currency: currencyCode },
      "payment projection skipped: unknown or inactive currency",
    );
    return null;
  }

  const amount = Number(doc.paid_amount ?? doc.received_amount ?? 0);
  if (!Number.isFinite(amount) || amount < 0) {
    logger?.warn(
      { school_id: schoolId, erpnext_docname: docname },
      "payment projection skipped: paid_amount is not a usable number",
    );
    return null;
  }
  const amountMinor = toMinorUnits(amount, currency.minorUnit);

  const status = paymentStatusFromDocstatus(doc.docstatus);
  const erpnextStatus = erpNextStatusFromDocstatus(doc.docstatus);
  const paymentDate = doc.posting_date ?? new Date().toISOString().slice(0, 10);
  const invoiceId = invoiceFromReferences(doc);
  const receiptUrl = status === "confirmed" ? receiptUrlFor(doc, docname) : null;
  // ck_payment_cache_confirmed_state makes status and confirmed_at move together, so the timestamp is
  // derived from the status here rather than accepted as a parameter — the constraint cannot be
  // violated from this function.
  //
  // The value itself comes from the *database* clock, not `new Date()`. created_at defaults to the
  // server's CURRENT_TIMESTAMP, and ck_payment_cache_confirmed_after_created compares the two: an API
  // host whose clock trails the database by even a second would produce confirmed_at < created_at for
  // a webhook that arrives promptly, and the insert would fail on a constraint that has nothing to do
  // with the payment. One clock, no skew.
  const confirmedAtSql = status === "confirmed" ? tx`CURRENT_TIMESTAMP` : tx`NULL::timestamptz`;

  const existing = await tx<{ id: string }[]>`
    SELECT id FROM app.payment_cache
    WHERE school_id = ${schoolId}::uuid AND erpnext_docname = ${docname}
  `;

  if (existing.length > 0) {
    // The common confirm path: this gateway forwarded the payment, so the row already exists as
    // 'pending' with its student, mode, and requested invoice already correct. Only ERPNext-owned
    // facts are refreshed, and COALESCE preserves what only the original request knew.
    const [updated] = await tx<{ id: string; confirmed_at: Date | null }[]>`
      UPDATE app.payment_cache
      SET erpnext_status     = ${erpnextStatus},
          status             = ${status},
          amount_minor       = ${amountMinor.toString()}::bigint,
          currency_id        = ${currency.id}::uuid,
          payment_date       = ${paymentDate}::date,
          erpnext_invoice_id = COALESCE(${invoiceId}, erpnext_invoice_id),
          receipt_url        = COALESCE(${receiptUrl}, receipt_url),
          confirmed_at       = ${confirmedAtSql},
          erpnext_payload    = ${tx.json(doc as unknown as JSONValue)}::jsonb,
          last_synced_at     = CURRENT_TIMESTAMP,
          updated_at         = CURRENT_TIMESTAMP
      WHERE school_id = ${schoolId}::uuid AND erpnext_docname = ${docname}
      RETURNING id, confirmed_at
    `;
    await upsertMapping(tx, schoolId, "payment", updated!.id, docname);
    return {
      id: updated!.id,
      erpnext_docname: docname,
      status,
      amount_minor: Number(amountMinor),
      currency: currency.code,
      // Read back rather than reconstructed, so the audit row records the exact timestamp stored.
      confirmed_at: updated!.confirmed_at,
    };
  }

  // A payment recorded directly in ERPNext, with no local request behind it. payment_mode stays NULL
  // because ERPNext's Mode of Payment is a free-form document name that need not be one of ours.
  const studentId = await resolveStudentId(tx, schoolId, doc);
  if (!studentId) {
    logger?.warn(
      { school_id: schoolId, erpnext_docname: docname, invoice: invoiceId },
      "payment projection skipped: could not resolve a local student for this payment",
    );
    return null;
  }

  const [inserted] = await tx<{ id: string; confirmed_at: Date | null }[]>`
    INSERT INTO app.payment_cache (
      school_id, student_id, currency_id, erpnext_docname, erpnext_status,
      amount_minor, payment_date, erpnext_invoice_id, status, receipt_url,
      confirmed_at, erpnext_payload, last_synced_at
    ) VALUES (
      ${schoolId}::uuid,
      ${studentId}::uuid,
      ${currency.id}::uuid,
      ${docname},
      ${erpnextStatus},
      ${amountMinor.toString()}::bigint,
      ${paymentDate}::date,
      ${invoiceId},
      ${status},
      ${receiptUrl},
      ${confirmedAtSql},
      ${tx.json(doc as unknown as JSONValue)}::jsonb,
      CURRENT_TIMESTAMP
    )
    RETURNING id, confirmed_at
  `;

  await upsertMapping(tx, schoolId, "payment", inserted!.id, docname);
  return {
    id: inserted!.id,
    erpnext_docname: docname,
    status,
    amount_minor: Number(amountMinor),
    currency: currency.code,
    confirmed_at: inserted!.confirmed_at,
  };
}
