/**
 * The payment forwarder (ST-121).
 *
 * One endpoint, one job: put a payment into ERPNext exactly once. Everything interesting here is
 * about that "exactly once", because the failure it prevents is charging a parent twice.
 *
 * ## Why three transactions and not one
 *
 * The obvious implementation — open a transaction, check the idempotency key, POST to ERPNext, write
 * the cache row, commit — is wrong in a way that is easy to miss. If the process dies after ERPNext
 * commits its `Payment Entry` but before our transaction commits, the reservation rolls back with
 * everything else. The next retry finds no reservation, posts again, and ERPNext now holds two
 * payments. A guard that vanishes alongside the thing it was guarding is not a guard.
 *
 * So the reservation is committed *before* the call goes out, and filled in *after* it returns:
 *
 *   Phase 1  reserve   (committed)  INSERT the key, or answer from the existing row
 *   Phase 2  forward   (no tx)      POST to ERPNext
 *   Phase 3  record    (committed)  fill in the entry id, project the cache row, audit
 *
 * A crash between phases 2 and 3 leaves a reserved row with a NULL `erpnext_payment_entry_id`. That
 * state means "we do not know whether ERPNext wrote this", and the only safe answer to a retry is to
 * refuse it (409 `PAYMENT_IN_PROGRESS`) rather than post again. An operator reconciles from
 * `idx_payment_cache_status`; the alternative is a silent double charge.
 *
 * ## What is not here
 *
 * No balance check, no overpayment rule, no allocation across invoices, no rounding policy. ERPNext
 * owns all of it — see `docs/modules/finance-payments-guide.md`. The document is submitted
 * (`docstatus: 1`) rather than left as a draft precisely so ERPNext's own validation runs and its
 * refusal reaches the caller; a draft would be accepted silently and settle nothing.
 */

import { createHash } from "node:crypto";

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { formatMinorUnits, getCurrencyByCode, toMinorUnits } from "../currency";
import { erpNextDefinitelyDidNotWrite, translateErpNextError } from "../erpnext-errors";
import { upsertMapping } from "../id-mappings/service";

import type { ErpNextPaymentEntry, PaymentStatus } from "./projection";
import type { Database } from "../../../db/client";
import type { TenantContext } from "../../../db/tenant-tx";
import type { TenantErpNext, TenantErpNextFactory } from "../client/tenant-client";
import type { JSONValue, TransactionSql } from "postgres";

const PAYMENT_ENTRY_RESOURCE = "/api/resource/Payment%20Entry";
const SALES_INVOICE_RESOURCE = "/api/resource/Sales%20Invoice";

export type PaymentMode = "cash" | "bank_transfer" | "card_external";

/**
 * Our three modes to ERPNext `Mode of Payment` document names.
 *
 * These are the names ERPNext's own setup wizard creates, and ERPNext resolves the deposit account
 * from the Mode of Payment's per-company default — which is why the payload below sends the mode and
 * *not* an account. A school that renames these documents in ERPNext breaks the mapping, and the
 * resulting "Mode of Payment not found" comes back from ERPNext unchanged rather than being guessed
 * around here.
 */
export const PAYMENT_MODE_MAP: Record<PaymentMode, string> = {
  cash: "Cash",
  bank_transfer: "Wire Transfer",
  card_external: "Credit Card",
};

export interface CreatePaymentParams {
  student_id: string;
  invoice_id: string;
  amount: number;
  payment_mode: PaymentMode;
  currency: string;
  reference_no?: string;
  reference_date?: string;
  posting_date?: string;
  remarks?: string;
}

export interface PaymentRow {
  id: string;
  school_id: string;
  student_id: string;
  erpnext_payment_entry_id: string | null;
  erpnext_invoice_id: string | null;
  amount: string;
  amount_minor: number;
  currency: string;
  currency_minor_unit: number;
  payment_mode: PaymentMode | null;
  status: PaymentStatus;
  erpnext_status: string;
  receipt_url: string | null;
  payment_date: string;
  confirmed_at: string | null;
  last_synced_at: string;
}

export interface ListPaymentsParams {
  student_id?: string;
  invoice_id?: string;
  status?: PaymentStatus;
  limit: number;
  offset: number;
}

const CACHE_COLUMNS = `
  pc.id,
  pc.school_id,
  pc.student_id,
  pc.erpnext_docname AS erpnext_payment_entry_id,
  pc.erpnext_invoice_id,
  pc.amount_minor,
  pc.payment_mode,
  pc.status,
  pc.erpnext_status,
  pc.receipt_url,
  pc.payment_date::text AS payment_date,
  pc.confirmed_at,
  pc.last_synced_at,
  c.code AS currency,
  c.minor_unit AS currency_minor_unit
`;

function parseCacheRow(row: Record<string, unknown>): PaymentRow {
  const minorUnit = row.currency_minor_unit as number;
  const minor = BigInt(row.amount_minor as string | number);
  const confirmedAt = row.confirmed_at as Date | null;

  return {
    id: row.id as string,
    school_id: row.school_id as string,
    student_id: row.student_id as string,
    erpnext_payment_entry_id: row.erpnext_payment_entry_id as string | null,
    erpnext_invoice_id: row.erpnext_invoice_id as string | null,
    amount: formatMinorUnits(minor, minorUnit),
    amount_minor: Number(minor),
    currency: row.currency as string,
    currency_minor_unit: minorUnit,
    payment_mode: row.payment_mode as PaymentMode | null,
    status: row.status as PaymentStatus,
    erpnext_status: row.erpnext_status as string,
    receipt_url: row.receipt_url as string | null,
    payment_date: row.payment_date as string,
    confirmed_at: confirmedAt ? confirmedAt.toISOString() : null,
    last_synced_at: (row.last_synced_at as Date).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function readPaymentByDocname(
  tx: TransactionSql,
  schoolId: string,
  docname: string,
): Promise<PaymentRow | undefined> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(CACHE_COLUMNS)}
    FROM app.payment_cache AS pc
    JOIN app.currencies AS c ON c.id = pc.currency_id
    WHERE pc.school_id = ${schoolId}::uuid AND pc.erpnext_docname = ${docname}
  `;
  return row ? parseCacheRow(row) : undefined;
}

export async function getPayment(
  tx: TransactionSql,
  schoolId: string,
  paymentId: string,
): Promise<PaymentRow> {
  // The id may be a local uuid or an ERPNext docname; the uuid cast is guarded because
  // `<text> = <uuid>` would raise on a docname rather than simply not matching.
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(CACHE_COLUMNS)}
    FROM app.payment_cache AS pc
    JOIN app.currencies AS c ON c.id = pc.currency_id
    WHERE pc.school_id = ${schoolId}::uuid
      AND (
        pc.erpnext_docname = ${paymentId}
        OR (${paymentId} ~ '^[0-9a-f-]{36}$' AND pc.id = ${paymentId}::uuid)
      )
  `;

  if (!row) {
    throw new CodedHttpException(404, ERROR_CODES.PAYMENT_NOT_FOUND, "Payment not found");
  }
  return parseCacheRow(row);
}

export async function listPayments(
  tx: TransactionSql,
  schoolId: string,
  params: ListPaymentsParams,
): Promise<{ rows: PaymentRow[]; total: number }> {
  const conditions = tx`pc.school_id = ${schoolId}::uuid`;
  const studentFilter = params.student_id
    ? tx` AND pc.student_id = ${params.student_id}::uuid`
    : tx``;
  const invoiceFilter = params.invoice_id
    ? tx` AND pc.erpnext_invoice_id = ${params.invoice_id}`
    : tx``;
  const statusFilter = params.status ? tx` AND pc.status = ${params.status}` : tx``;

  const [rows, [count]] = await Promise.all([
    tx<Record<string, unknown>[]>`
      SELECT ${tx.unsafe(CACHE_COLUMNS)}
      FROM app.payment_cache AS pc
      JOIN app.currencies AS c ON c.id = pc.currency_id
      WHERE ${conditions}${studentFilter}${invoiceFilter}${statusFilter}
      ORDER BY pc.created_at DESC
      LIMIT ${params.limit} OFFSET ${params.offset}
    `,
    tx<{ total: number }[]>`
      SELECT count(*)::int AS total
      FROM app.payment_cache AS pc
      WHERE ${conditions}${studentFilter}${invoiceFilter}${statusFilter}
    `,
  ]);

  return { rows: rows.map(parseCacheRow), total: count?.total ?? 0 };
}

// ---------------------------------------------------------------------------
// Idempotency guard
// ---------------------------------------------------------------------------

/**
 * The hash that distinguishes a retry from a key collision.
 *
 * Keys are sorted so that two JSON bodies differing only in property order hash alike — a retry
 * through a proxy that reserialized the body is still a retry, and refusing it would be a false
 * positive on the one path that most needs to succeed.
 */
export function hashPaymentRequest(params: CreatePaymentParams): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

interface IdempotencyRow {
  request_hash: string;
  erpnext_payment_entry_id: string | null;
}

type ReservationOutcome =
  | { kind: "reserved" }
  /** A completed earlier attempt; its result is replayed verbatim. */
  | { kind: "replay"; docname: string };

async function reserveIdempotencyKey(
  tx: TransactionSql,
  schoolId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<ReservationOutcome> {
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO app.payment_idempotency_logs (school_id, idempotency_key, request_hash)
    VALUES (${schoolId}::uuid, ${idempotencyKey}, ${requestHash})
    ON CONFLICT (school_id, idempotency_key) DO NOTHING
    RETURNING id
  `;

  if (inserted.length > 0) return { kind: "reserved" };

  const [existing] = await tx<IdempotencyRow[]>`
    SELECT request_hash, erpnext_payment_entry_id
    FROM app.payment_idempotency_logs
    WHERE school_id = ${schoolId}::uuid AND idempotency_key = ${idempotencyKey}
  `;

  // The unique index just rejected our insert, so a row exists. If it is gone by the time we read,
  // a concurrent 4xx released it — treat that as a live conflict rather than reserving behind it.
  if (!existing) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.PAYMENT_IN_PROGRESS,
      "This idempotency key is being processed; retry shortly",
    );
  }

  if (existing.request_hash !== requestHash) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_IDEMPOTENCY_KEY_MISMATCH,
      "This Idempotency-Key was already used for a different payment request",
    );
  }

  if (!existing.erpnext_payment_entry_id) {
    // Either a concurrent request is mid-flight, or an earlier one died between posting and
    // recording. Indistinguishable from here, and both have the same safe answer: do not post.
    throw new CodedHttpException(
      409,
      ERROR_CODES.PAYMENT_IN_PROGRESS,
      "An earlier request with this Idempotency-Key has not finished; retry shortly",
    );
  }

  return { kind: "replay", docname: existing.erpnext_payment_entry_id };
}

// ---------------------------------------------------------------------------
// ERPNext payload
// ---------------------------------------------------------------------------

/**
 * The ERPNext Customer to bill, read from the locally cached invoice when possible.
 *
 * A Payment Entry needs a `party`, and the only authority on which Customer an invoice belongs to is
 * the invoice itself. `invoice_cache.erpnext_payload` already holds the whole Sales Invoice document
 * from when it was projected, so the common case costs no ERPNext round trip. When the invoice was
 * never cached, one GET answers it.
 *
 * Returning `undefined` is a valid outcome, not a failure: the payload then omits `party` and
 * ERPNext's own `set_missing_values` either resolves it or refuses the document. Refusing here
 * instead would be the gateway inventing a validation rule it does not own.
 */
async function resolveParty(
  tx: TransactionSql,
  erpnext: TenantErpNext,
  schoolId: string,
  invoiceId: string,
  acceptLanguage?: string,
): Promise<string | undefined> {
  const [cached] = await tx<{ customer: string | null }[]>`
    SELECT erpnext_payload->>'customer' AS customer
    FROM app.invoice_cache
    WHERE school_id = ${schoolId}::uuid AND erpnext_docname = ${invoiceId}
  `;
  if (cached?.customer) return cached.customer;

  try {
    const response = await erpnext.get<{ data?: { customer?: string | null } }>(
      `${SALES_INVOICE_RESOURCE}/${encodeURIComponent(invoiceId)}`,
      { acceptLanguage },
    );
    return response.data.data?.customer ?? undefined;
  } catch {
    // A failed lookup is not a failed payment. Fall through and let ERPNext decide on the POST,
    // where the error it returns is about the payment the caller actually asked for.
    return undefined;
  }
}

/** Exported for tests: the document shape is part of this endpoint's contract with ERPNext. */
export function buildPaymentEntryPayload(
  params: CreatePaymentParams,
  schoolId: string,
  party: string | undefined,
): Record<string, unknown> {
  const postingDate = params.posting_date ?? new Date().toISOString().slice(0, 10);

  return {
    doctype: "Payment Entry",
    payment_type: "Receive",
    party_type: "Customer",
    ...(party ? { party } : {}),
    posting_date: postingDate,
    mode_of_payment: PAYMENT_MODE_MAP[params.payment_mode],
    paid_amount: params.amount,
    received_amount: params.amount,
    // Both currency fields are set from one input: this gateway never converts between currencies,
    // so a differing source/target rate is not a case it can produce.
    paid_from_account_currency: params.currency,
    ...(params.reference_no ? { reference_no: params.reference_no } : {}),
    ...(params.reference_date ? { reference_date: params.reference_date } : {}),
    ...(params.remarks ? { remarks: params.remarks } : {}),
    // Carried so ERPNext-side automation and the confirmation webhook can route back to this tenant
    // and student without re-deriving either. projection.ts reads custom_student_id.
    custom_school_id: schoolId,
    custom_student_id: params.student_id,
    references: [
      {
        reference_doctype: "Sales Invoice",
        reference_name: params.invoice_id,
        allocated_amount: params.amount,
      },
    ],
    // Submit rather than save a draft. ERPNext's overpayment and outstanding-balance validation runs
    // on submit; a draft would be accepted, settle nothing, and hide the rejection this endpoint is
    // contractually required to surface.
    docstatus: 1,
  };
}

// No account fields are sent. ERPNext derives `paid_to` from the Mode of Payment's per-company
// default account and `paid_from` from the customer's receivable account. Sending our own guesses
// would put a chart-of-accounts opinion in the gateway, which is exactly what it must not hold.

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreatePaymentResult {
  row: PaymentRow;
  /** True when an earlier request with this key produced the row, so no ERPNext call was made. */
  replayed: boolean;
}

export async function createPayment(
  database: Database,
  erpnextFactory: TenantErpNextFactory,
  context: TenantContext,
  params: CreatePaymentParams,
  idempotencyKey: string,
  acceptLanguage?: string,
): Promise<CreatePaymentResult> {
  const schoolId = context.schoolId;
  const requestHash = hashPaymentRequest(params);

  // --- Phase 1: reserve the key, and resolve everything that needs a transaction ---------------
  // Tagged rather than probed with `in`: the two arms share no fields, and a discriminant keeps the
  // narrowing explicit instead of relying on inference over a merged optional-property type.
  type Prepared =
    | { kind: "replay"; row: PaymentRow }
    | {
        kind: "forward";
        erpnext: TenantErpNext;
        party: string | undefined;
        currency: { id: string; code: string; minorUnit: number };
      };

  const prepared = await withTenantTx<Prepared>(database, context, async (tx) => {
    const outcome = await reserveIdempotencyKey(tx, schoolId, idempotencyKey, requestHash);

    if (outcome.kind === "replay") {
      const existing = await readPaymentByDocname(tx, schoolId, outcome.docname);
      // The guard says a Payment Entry exists but its projection does not. Answering 200 with a
      // fabricated body would be worse than admitting the inconsistency.
      if (!existing) {
        throw new CodedHttpException(
          409,
          ERROR_CODES.PAYMENT_IN_PROGRESS,
          "An earlier request with this Idempotency-Key is still being recorded; retry shortly",
        );
      }
      return { kind: "replay", row: existing };
    }

    // The client object outlives this transaction safely — it holds a base URL, an API key, and the
    // tenant's site host, none of which are transaction-scoped.
    const erpnext = await erpnextFactory.forSchool(tx, schoolId);
    const party = await resolveParty(tx, erpnext, schoolId, params.invoice_id, acceptLanguage);
    const currency = await getCurrencyByCode(tx, params.currency);
    if (!currency) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        `Unknown or inactive currency: ${params.currency}`,
      );
    }
    return { kind: "forward", erpnext, party, currency };
  });

  if (prepared.kind === "replay") {
    return { row: prepared.row, replayed: true };
  }

  const { erpnext, party, currency } = prepared;

  // --- Phase 2: forward to ERPNext --------------------------------------------------------------
  let doc: ErpNextPaymentEntry;
  try {
    const response = await erpnext.post<{ data: ErpNextPaymentEntry }>(
      PAYMENT_ENTRY_RESOURCE,
      buildPaymentEntryPayload(params, schoolId, party),
      { acceptLanguage },
    );
    doc = response.data.data;
  } catch (error) {
    // Release the key only when ERPNext proved it wrote nothing. On a timeout, a dropped connection,
    // or a 5xx the outcome is unknown and the reservation must stand, so the retry is refused rather
    // than duplicating a payment we cannot see.
    if (erpNextDefinitelyDidNotWrite(error)) {
      await withTenantTx(database, context, async (tx) => {
        await tx`
          DELETE FROM app.payment_idempotency_logs
          WHERE school_id = ${schoolId}::uuid
            AND idempotency_key = ${idempotencyKey}
            AND erpnext_payment_entry_id IS NULL
        `;
      });
    }
    translateErpNextError(error, {
      notFound: {
        code: ERROR_CODES.PAYMENT_NOT_FOUND,
        message: "ERPNext could not find the invoice or party for this payment",
      },
    });
  }

  const docname = doc.name?.trim();
  if (!docname) {
    // ERPNext answered 2xx without naming the document. The reservation stays: something may exist
    // there, and we cannot identify it to reconcile against.
    throw new CodedHttpException(
      502,
      ERROR_CODES.ERPNEXT_UNAVAILABLE,
      "ERPNext accepted the payment but returned no document name",
    );
  }

  // --- Phase 3: fill in the reservation, project the cache row, audit ---------------------------
  const amountMinor = toMinorUnits(params.amount, currency.minorUnit);
  const postingDate = params.posting_date ?? new Date().toISOString().slice(0, 10);

  const row = await withTenantTx(database, context, async (tx) => {
    await tx`
      UPDATE app.payment_idempotency_logs
      SET erpnext_payment_entry_id = ${docname}
      WHERE school_id = ${schoolId}::uuid AND idempotency_key = ${idempotencyKey}
    `;

    // The forwarder INSERTs, `projection.ts` UPDATEs. The split is deliberate: only the request knows
    // the student, the mode, the requested invoice, and the key, while only ERPNext knows the
    // confirmed status and the receipt. Neither writes the other's columns.
    //
    // status is 'pending' even though the document was submitted: confirmation is the webhook's to
    // deliver, and it is also what supplies receipt_url. Trusting our own read of the POST response
    // would report money as settled before the system of record said so.
    const [inserted] = await tx<{ id: string }[]>`
      INSERT INTO app.payment_cache (
        school_id, student_id, currency_id, erpnext_docname, erpnext_status,
        amount_minor, payment_date, erpnext_invoice_id, payment_mode, status,
        idempotency_key, erpnext_payload, last_synced_at
      ) VALUES (
        ${schoolId}::uuid,
        ${params.student_id}::uuid,
        ${currency.id}::uuid,
        ${docname},
        ${doc.docstatus === 1 ? "submitted" : doc.docstatus === 2 ? "cancelled" : "draft"},
        ${amountMinor.toString()}::bigint,
        ${postingDate}::date,
        ${params.invoice_id},
        ${params.payment_mode},
        'pending',
        ${idempotencyKey},
        ${tx.json(doc as unknown as JSONValue)}::jsonb,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (school_id, erpnext_docname) DO UPDATE
        SET erpnext_status  = EXCLUDED.erpnext_status,
            amount_minor    = EXCLUDED.amount_minor,
            erpnext_payload = EXCLUDED.erpnext_payload,
            last_synced_at  = EXCLUDED.last_synced_at,
            updated_at      = CURRENT_TIMESTAMP
      RETURNING id
    `;

    await upsertMapping(tx, schoolId, "payment", inserted!.id, docname);

    // Deliberately narrow: the ERPNext document, the money, and the mode. No Idempotency-Key and no
    // reference_no — the first is a client credential for replay and the second is bank data, and
    // audit rows are read far more widely than either deserves.
    await emitAuditLog(tx, {
      action: "insert",
      targetTable: "payment_cache",
      targetId: inserted!.id,
      newValues: {
        erpnext_doctype: "Payment Entry",
        erpnext_payment_entry_id: docname,
        erpnext_invoice_id: params.invoice_id,
        student_id: params.student_id,
        amount_minor: Number(amountMinor),
        currency: currency.code,
        payment_mode: params.payment_mode,
        status: "pending",
      },
    });

    const projected = await readPaymentByDocname(tx, schoolId, docname);
    if (!projected) {
      throw new Error(`payment cache row vanished immediately after insert: ${docname}`);
    }
    return projected;
  });

  return { row, replayed: false };
}
