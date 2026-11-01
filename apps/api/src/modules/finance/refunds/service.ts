import { createHash } from "node:crypto";

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { ErpNextError } from "../../../erpnext/client";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { formatMinorUnits, getCurrencyByCode, toMinorUnits } from "../currency";

import type { Database } from "../../../db/client";
import type { TenantContext } from "../../../db/tenant-tx";
import type { TenantErpNext } from "../client/tenant-client";
import type { TransactionSql } from "postgres";

const SALES_INVOICE_RESOURCE = "/api/resource/Sales%20Invoice";

export type ReasonCode =
  "overpayment" | "withdrawal" | "discount_adjustment" | "error_correction" | "write_off";
/**
 * What the approval does in ERPNext (000172). `credit_note`: a Sales Invoice return (a refund, a
 * fee correction, a write-off). `invoice_cancellation`: cancel an invoice nothing was paid against.
 * `payment_reversal`: cancel a payment recorded by mistake, so its invoice is owed again.
 */
export type RefundKind = "credit_note" | "invoice_cancellation" | "payment_reversal";
export type RefundStatus =
  "pending_approval" | "approved" | "rejected" | "submitted_to_erpnext" | "completed" | "failed";

export interface InitiateRefundParams {
  student_id: string;
  erpnext_invoice_id: string;
  amount: number;
  currency: string;
  reason_code: ReasonCode;
  reason_notes?: string;
}

export interface RefundRow {
  id: string;
  school_id: string;
  kind: RefundKind;
  payment_entry_id: string | null;
  erpnext_invoice_id: string;
  erpnext_credit_note_id: string | null;
  student_id: string;
  amount: string;
  amount_minor: number;
  currency: string;
  currency_minor_unit: number;
  reason_code: ReasonCode;
  reason_notes: string | null;
  status: RefundStatus;
  maker_id: string;
  checker_id: string | null;
  idempotency_key: string;
  approved_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListRefundsParams {
  student_id?: string;
  status?: RefundStatus;
  kind?: RefundKind;
  limit: number;
  offset: number;
}

const REFUND_COLUMNS = `
  rr.id,
  rr.school_id,
  rr.kind,
  rr.payment_entry_id,
  rr.erpnext_invoice_id,
  rr.erpnext_credit_note_id,
  rr.student_id,
  rr.amount_minor,
  rr.reason_code,
  rr.reason_notes,
  rr.status,
  rr.maker_id,
  rr.checker_id,
  rr.idempotency_key,
  rr.approved_at,
  rr.completed_at,
  rr.created_at,
  rr.updated_at,
  c.code AS currency,
  c.minor_unit AS currency_minor_unit
`;

function parseRefundRow(row: Record<string, unknown>): RefundRow {
  const minorUnit = row.currency_minor_unit as number;
  const minor = BigInt(row.amount_minor as string | number);

  return {
    id: row.id as string,
    school_id: row.school_id as string,
    kind: row.kind as RefundKind,
    payment_entry_id: row.payment_entry_id as string | null,
    erpnext_invoice_id: row.erpnext_invoice_id as string,
    erpnext_credit_note_id: row.erpnext_credit_note_id as string | null,
    student_id: row.student_id as string,
    amount: formatMinorUnits(minor, minorUnit),
    amount_minor: Number(minor),
    currency: row.currency as string,
    currency_minor_unit: minorUnit,
    reason_code: row.reason_code as ReasonCode,
    reason_notes: row.reason_notes as string | null,
    status: row.status as RefundStatus,
    maker_id: row.maker_id as string,
    checker_id: row.checker_id as string | null,
    idempotency_key: row.idempotency_key as string,
    approved_at: (row.approved_at as Date | null)?.toISOString() ?? null,
    completed_at: (row.completed_at as Date | null)?.toISOString() ?? null,
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
  };
}

function translateErpNextRefundError(error: unknown): never {
  if (!(error instanceof ErpNextError)) throw error;

  if (error.kind === "circuit_open") {
    throw new CodedHttpException(
      503,
      ERROR_CODES.ERPNEXT_CIRCUIT_OPEN,
      "ERPNext is unreachable; refunds are paused while it recovers",
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

  if (error.status === 409) {
    throw new CodedHttpException(409, ERROR_CODES.CONFLICT_DUPLICATE_ENTRY, error.message);
  }

  throw new CodedHttpException(
    error.status === 429 ? 429 : 400,
    error.status === 429 ? ERROR_CODES.RATE_LIMIT_EXCEEDED : ERROR_CODES.VALIDATION_FAILED,
    error.message,
  );
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

export function hashRefundRequest(params: InitiateRefundParams): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

interface IdempotencyRow {
  request_hash: string;
}

type ReservationOutcome = { kind: "reserved" } | { kind: "replay" };

async function reserveRefundIdempotencyKey(
  tx: TransactionSql,
  schoolId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<ReservationOutcome> {
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO app.refund_idempotency_logs (school_id, idempotency_key, request_hash)
    VALUES (${schoolId}::uuid, ${idempotencyKey}, ${requestHash})
    ON CONFLICT (school_id, idempotency_key) DO NOTHING
    RETURNING id
  `;

  if (inserted.length > 0) return { kind: "reserved" };

  const [existing] = await tx<IdempotencyRow[]>`
    SELECT request_hash
    FROM app.refund_idempotency_logs
    WHERE school_id = ${schoolId}::uuid AND idempotency_key = ${idempotencyKey}
  `;

  if (!existing) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.REFUND_IN_PROGRESS,
      "This idempotency key is being processed; retry shortly",
    );
  }

  if (existing.request_hash !== requestHash) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_IDEMPOTENCY_KEY_MISMATCH,
      "This Idempotency-Key was already used for a different refund request",
    );
  }

  // The maker step only records a pending request; the credit note is created later, at approval.
  // A matching hash is therefore a replay whether or not the request has been approved yet.
  return { kind: "replay" };
}

// ---------------------------------------------------------------------------
// ERPNext payload builder
// ---------------------------------------------------------------------------

export function buildCreditNotePayload(
  params: InitiateRefundParams,
  schoolId: string,
): Record<string, unknown> {
  return {
    doctype: "Sales Invoice",
    is_return: 1,
    return_against: params.erpnext_invoice_id,
    customer: "",
    items: [],
    total: -params.amount,
    grand_total: -params.amount,
    outstanding_amount: -params.amount,
    is_pos: 0,
    update_stock: 0,
    custom_school_id: schoolId,
    custom_student_id: params.student_id,
    custom_reason_code: params.reason_code,
    ...(params.reason_notes ? { custom_reason_notes: params.reason_notes } : {}),
    docstatus: 1,
  };
}

// ---------------------------------------------------------------------------
// Maker step — initiate a refund
// ---------------------------------------------------------------------------

export interface InitiateRefundResult {
  row: RefundRow;
  replayed: boolean;
}

export async function initiateRefund(
  database: Database,
  context: TenantContext,
  params: InitiateRefundParams,
  idempotencyKey: string,
): Promise<InitiateRefundResult> {
  const schoolId = context.schoolId;
  const requestHash = hashRefundRequest(params);

  const prepared = await withTenantTx(database, context, async (tx) => {
    const outcome = await reserveRefundIdempotencyKey(tx, schoolId, idempotencyKey, requestHash);

    if (outcome.kind === "replay") {
      const existing = await findRefundByIdempotencyKey(tx, schoolId, idempotencyKey);
      if (!existing) {
        throw new CodedHttpException(
          409,
          ERROR_CODES.REFUND_IN_PROGRESS,
          "An earlier request with this Idempotency-Key is still being recorded; retry shortly",
        );
      }
      return { kind: "replay" as const, row: existing };
    }

    const currency = await getCurrencyByCode(tx, params.currency);
    if (!currency) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        `Unknown or inactive currency: ${params.currency}`,
      );
    }

    const amountMinor = toMinorUnits(params.amount, currency.minorUnit);

    // A write-off clears a balance that will not be collected, so it can never exceed what is
    // still owed. ERPNext would accept a larger return and leave the family in credit.
    if (params.reason_code === "write_off") {
      const [invoice] = await tx<{ outstanding_amount_minor: string }[]>`
        SELECT outstanding_amount_minor::text AS outstanding_amount_minor
        FROM app.invoice_cache
        WHERE school_id = ${schoolId}::uuid AND erpnext_docname = ${params.erpnext_invoice_id}
          AND lower(erpnext_status) NOT IN ('draft', 'cancelled')
      `;
      if (!invoice) {
        throw new CodedHttpException(404, ERROR_CODES.INVOICE_NOT_FOUND, "Invoice not found");
      }
      if (amountMinor > BigInt(invoice.outstanding_amount_minor)) {
        throw new CodedHttpException(
          400,
          ERROR_CODES.WRITE_OFF_EXCEEDS_OUTSTANDING,
          "A write-off cannot be more than the invoice's outstanding balance",
        );
      }
    }

    const makerUserId = context.userId!;

    const [inserted] = await tx<Record<string, unknown>[]>`
      INSERT INTO app.refund_requests (
        school_id, student_id, erpnext_invoice_id, amount_minor, currency_id,
        reason_code, reason_notes, status, maker_id, idempotency_key
      ) VALUES (
        ${schoolId}::uuid,
        ${params.student_id}::uuid,
        ${params.erpnext_invoice_id},
        ${amountMinor.toString()}::bigint,
        ${currency.id}::uuid,
        ${params.reason_code as string},
        ${params.reason_notes ?? null},
        'pending_approval',
        ${makerUserId}::uuid,
        ${idempotencyKey}
      )
      RETURNING id, school_id, payment_entry_id, erpnext_invoice_id,
                erpnext_credit_note_id, student_id, amount_minor, reason_code,
                reason_notes, status, maker_id, checker_id, approved_at,
                completed_at, created_at, updated_at
    `;

    const fullRow = await getRefundById(tx, schoolId, inserted!.id as string);
    if (!fullRow) throw new Error("refund row vanished immediately after insert");

    await emitAuditLog(tx, {
      action: "insert",
      targetTable: "refund_requests",
      targetId: inserted!.id as string,
      newValues: {
        student_id: params.student_id,
        erpnext_invoice_id: params.erpnext_invoice_id,
        amount_minor: Number(amountMinor),
        currency: currency.code,
        reason_code: params.reason_code,
        status: "pending_approval",
        maker_id: makerUserId,
      },
    });

    return { kind: "created" as const, row: fullRow };
  });

  if (prepared.kind === "replay") {
    return { row: prepared.row, replayed: true };
  }

  return { row: prepared.row, replayed: false };
}

// ---------------------------------------------------------------------------
// Checker step — approve a refund
// ---------------------------------------------------------------------------

export async function approveRefund(
  tx: TransactionSql,
  erpnext: TenantErpNext,
  schoolId: string,
  userId: string,
  refundId: string,
  acceptLanguage?: string,
): Promise<RefundRow> {
  const refund = await getRefundById(tx, schoolId, refundId);
  if (!refund) {
    throw new CodedHttpException(404, ERROR_CODES.REFUND_NOT_FOUND, "Refund request not found");
  }

  if (refund.status !== "pending_approval") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.REFUND_INVALID_STATUS,
      `Cannot approve a refund with status '${refund.status}'`,
    );
  }

  if (refund.maker_id === userId) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.REFUND_CONFIRM_SELF,
      "The maker and checker must be different users",
    );
  }

  if (refund.kind !== "credit_note") {
    return approveCancellation(tx, erpnext, schoolId, userId, refund, acceptLanguage);
  }

  const currency = await getCurrencyByCode(tx, refund.currency);
  if (!currency) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      `Currency for refund no longer active: ${refund.currency}`,
    );
  }

  const amountDecimal = Number(refund.amount_minor) / Math.pow(10, currency.minorUnit);

  const erpnextDoc: Record<string, unknown> = {
    doctype: "Sales Invoice",
    is_return: 1,
    return_against: refund.erpnext_invoice_id,
    customer: "",
    items: [],
    total: -amountDecimal,
    grand_total: -amountDecimal,
    outstanding_amount: -amountDecimal,
    is_pos: 0,
    update_stock: 0,
    custom_school_id: schoolId,
    custom_student_id: refund.student_id,
    custom_reason_code: refund.reason_code,
    ...(refund.reason_notes ? { custom_reason_notes: refund.reason_notes } : {}),
    docstatus: 1,
  };

  let erpnextResult: { name?: string };
  try {
    const response = await erpnext.post<{ data: Record<string, unknown> }>(
      SALES_INVOICE_RESOURCE,
      erpnextDoc,
      { acceptLanguage },
    );
    erpnextResult = response.data.data as { name?: string };
  } catch (error) {
    translateErpNextRefundError(error);
  }

  const creditNoteId = erpnextResult.name?.trim();
  if (!creditNoteId) {
    throw new CodedHttpException(
      502,
      ERROR_CODES.ERPNEXT_UNAVAILABLE,
      "ERPNext accepted the return but returned no document name",
    );
  }

  await tx`
    UPDATE app.refund_requests
    SET status = 'submitted_to_erpnext',
        checker_id = ${userId}::uuid,
        erpnext_credit_note_id = ${creditNoteId},
        approved_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${refundId}::uuid
  `;

  await tx`
    UPDATE app.refund_idempotency_logs
    SET erpnext_credit_note_id = ${creditNoteId}
    WHERE school_id = ${schoolId}::uuid
      AND idempotency_key = ${refund.idempotency_key}
  `;

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "refund_requests",
    targetId: refundId,
    oldValues: {
      status: "pending_approval",
    },
    newValues: {
      status: "submitted_to_erpnext",
      checker_id: userId,
      erpnext_credit_note_id: creditNoteId,
      reason_code: refund.reason_code,
      amount_minor: refund.amount_minor,
    },
  });

  const row = await getRefundById(tx, schoolId, refundId);
  if (!row) throw new Error("refund row vanished after update");
  return row;
}

// ---------------------------------------------------------------------------
// Maker step — ask to cancel an invoice or reverse a payment (000172)
// ---------------------------------------------------------------------------

const FRAPPE_CANCEL = "/api/method/frappe.client.cancel";

export interface CorrectionRequest {
  reason_code: ReasonCode;
  reason_notes: string;
}

function isOpenRequestConflict(error: unknown): boolean {
  const pg = error as { code?: string; constraint_name?: string };
  return (
    pg.code === "23505" &&
    (pg.constraint_name === "uq_refund_requests_open_cancellation" ||
      pg.constraint_name === "uq_refund_requests_open_reversal")
  );
}

async function insertCorrection(
  tx: TransactionSql,
  context: TenantContext,
  fields: {
    kind: Exclude<RefundKind, "credit_note">;
    student_id: string;
    erpnext_invoice_id: string;
    payment_entry_id: string | null;
    amount_minor: string;
    currency_id: string;
  },
  request: CorrectionRequest,
): Promise<RefundRow> {
  const schoolId = context.schoolId;
  let id: string;
  try {
    // A savepoint, so a duplicate turns into a clean 409 instead of aborting the transaction.
    const [inserted] = await tx.savepoint(
      (sp) => sp<{ id: string }[]>`
        INSERT INTO app.refund_requests (
          school_id, kind, student_id, erpnext_invoice_id, payment_entry_id, amount_minor,
          currency_id, reason_code, reason_notes, status, maker_id, idempotency_key
        ) VALUES (
          ${schoolId}::uuid, ${fields.kind}, ${fields.student_id}::uuid, ${fields.erpnext_invoice_id},
          ${fields.payment_entry_id}::uuid, ${fields.amount_minor}::bigint, ${fields.currency_id}::uuid,
          ${request.reason_code}, ${request.reason_notes}, 'pending_approval', ${context.userId!}::uuid,
          ${`${fields.kind}:${crypto.randomUUID()}`}
        )
        RETURNING id
      `,
    );
    id = inserted!.id;
  } catch (error) {
    if (isOpenRequestConflict(error)) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.ADJUSTMENT_ALREADY_REQUESTED,
        fields.kind === "invoice_cancellation"
          ? "A cancellation for this invoice is already waiting for approval or done"
          : "A reversal for this payment is already waiting for approval or done",
      );
    }
    throw error;
  }

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "refund_requests",
    targetId: id,
    newValues: {
      kind: fields.kind,
      student_id: fields.student_id,
      erpnext_invoice_id: fields.erpnext_invoice_id,
      payment_entry_id: fields.payment_entry_id,
      amount_minor: Number(fields.amount_minor),
      reason_code: request.reason_code,
      status: "pending_approval",
      maker_id: context.userId,
    },
  });

  const row = await getRefundById(tx, schoolId, id);
  if (!row) throw new Error("refund row vanished immediately after insert");
  return row;
}

/**
 * Ask to cancel an invoice. Only a submitted invoice with nothing against it: no payment (pending
 * or confirmed) and no credit note that is not rejected or failed. Anything else is corrected with
 * a credit note, which keeps the payment history ERPNext's cancel would unlink.
 */
export async function requestInvoiceCancellation(
  database: Database,
  context: TenantContext,
  invoiceId: string,
  request: CorrectionRequest,
): Promise<RefundRow> {
  return withTenantTx(database, context, async (tx) => {
    const schoolId = context.schoolId;
    const [invoice] = await tx<
      {
        student_id: string;
        erpnext_docname: string;
        erpnext_status: string;
        total_amount_minor: string;
        outstanding_amount_minor: string;
        currency_id: string;
        payments: number;
        credit_notes: number;
      }[]
    >`
      SELECT ic.student_id, ic.erpnext_docname, ic.erpnext_status,
             ic.total_amount_minor::text AS total_amount_minor,
             ic.outstanding_amount_minor::text AS outstanding_amount_minor, ic.currency_id,
             (SELECT count(*)::int FROM app.payment_cache AS pc
              WHERE pc.school_id = ic.school_id AND pc.erpnext_invoice_id = ic.erpnext_docname
                AND pc.status IN ('pending', 'confirmed')) AS payments,
             (SELECT count(*)::int FROM app.refund_requests AS rr
              WHERE rr.school_id = ic.school_id AND rr.erpnext_invoice_id = ic.erpnext_docname
                AND rr.kind = 'credit_note' AND rr.status NOT IN ('rejected', 'failed')) AS credit_notes
      FROM app.invoice_cache AS ic
      WHERE ic.school_id = ${schoolId}::uuid AND ic.id = ${invoiceId}::uuid
    `;
    if (!invoice) {
      throw new CodedHttpException(404, ERROR_CODES.INVOICE_NOT_FOUND, "Invoice not found");
    }
    if (invoice.erpnext_status.toLowerCase() !== "submitted") {
      throw new CodedHttpException(
        409,
        ERROR_CODES.INVOICE_NOT_CANCELLABLE,
        "Only a submitted invoice can be cancelled",
      );
    }
    if (
      invoice.payments > 0 ||
      invoice.credit_notes > 0 ||
      invoice.outstanding_amount_minor !== invoice.total_amount_minor
    ) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.INVOICE_NOT_CANCELLABLE,
        "Money or a credit note is already against this invoice; issue a credit note instead",
      );
    }

    return insertCorrection(
      tx,
      context,
      {
        kind: "invoice_cancellation",
        student_id: invoice.student_id,
        erpnext_invoice_id: invoice.erpnext_docname,
        payment_entry_id: null,
        amount_minor: invoice.total_amount_minor,
        currency_id: invoice.currency_id,
      },
      request,
    );
  });
}

/** Ask to reverse a confirmed payment. Its invoice is owed again once the reversal is approved. */
export async function requestPaymentReversal(
  database: Database,
  context: TenantContext,
  paymentId: string,
  request: CorrectionRequest,
): Promise<RefundRow> {
  return withTenantTx(database, context, async (tx) => {
    const [payment] = await tx<
      {
        id: string;
        student_id: string;
        erpnext_invoice_id: string | null;
        status: string;
        amount_minor: string;
        currency_id: string;
      }[]
    >`
      SELECT id, student_id, erpnext_invoice_id, status, amount_minor::text AS amount_minor,
             currency_id
      FROM app.payment_cache
      WHERE school_id = ${context.schoolId}::uuid AND id = ${paymentId}::uuid
    `;
    if (!payment) {
      throw new CodedHttpException(404, ERROR_CODES.PAYMENT_NOT_FOUND, "Payment not found");
    }
    if (payment.status !== "confirmed" || !payment.erpnext_invoice_id) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.PAYMENT_NOT_REVERSIBLE,
        payment.status !== "confirmed"
          ? "Only a confirmed payment can be reversed"
          : "This payment names no invoice; reverse it in ERPNext",
      );
    }

    return insertCorrection(
      tx,
      context,
      {
        kind: "payment_reversal",
        student_id: payment.student_id,
        erpnext_invoice_id: payment.erpnext_invoice_id,
        payment_entry_id: payment.id,
        amount_minor: payment.amount_minor,
        currency_id: payment.currency_id,
      },
      request,
    );
  });
}

/**
 * The checker step for a cancellation or reversal: cancel the document in ERPNext (docstatus 2),
 * then bring the local read models in line at once rather than waiting for a webhook ERPNext does
 * not send on cancel. A reversal makes its invoice owed again by the payment's amount, capped at
 * the invoice total; the next reconciliation corrects any drift.
 */
async function approveCancellation(
  tx: TransactionSql,
  erpnext: TenantErpNext,
  schoolId: string,
  userId: string,
  refund: RefundRow,
  acceptLanguage?: string,
): Promise<RefundRow> {
  let docname = refund.erpnext_invoice_id;
  if (refund.kind === "payment_reversal") {
    const [payment] = await tx<{ erpnext_docname: string; status: string }[]>`
      SELECT erpnext_docname, status FROM app.payment_cache
      WHERE school_id = ${schoolId}::uuid AND id = ${refund.payment_entry_id}::uuid
    `;
    if (!payment || payment.status !== "confirmed") {
      throw new CodedHttpException(
        409,
        ERROR_CODES.PAYMENT_NOT_REVERSIBLE,
        "The payment is no longer confirmed",
      );
    }
    docname = payment.erpnext_docname;
  }

  try {
    await erpnext.post(
      FRAPPE_CANCEL,
      {
        doctype: refund.kind === "invoice_cancellation" ? "Sales Invoice" : "Payment Entry",
        name: docname,
      },
      { acceptLanguage },
    );
  } catch (error) {
    translateErpNextRefundError(error);
  }

  if (refund.kind === "invoice_cancellation") {
    await tx`
      UPDATE app.invoice_cache
      SET erpnext_status = 'cancelled', outstanding_amount_minor = 0,
          last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE school_id = ${schoolId}::uuid AND erpnext_docname = ${refund.erpnext_invoice_id}
    `;
  } else {
    await tx`
      UPDATE app.payment_cache
      SET status = 'reversed', erpnext_status = 'cancelled',
          last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE school_id = ${schoolId}::uuid AND id = ${refund.payment_entry_id}::uuid
    `;
    await tx`
      UPDATE app.invoice_cache
      SET outstanding_amount_minor = LEAST(total_amount_minor,
                                           outstanding_amount_minor + ${refund.amount_minor}),
          last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE school_id = ${schoolId}::uuid AND erpnext_docname = ${refund.erpnext_invoice_id}
    `;
  }

  await tx`
    UPDATE app.refund_requests
    SET status = 'completed', checker_id = ${userId}::uuid, approved_at = CURRENT_TIMESTAMP,
        completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${refund.id}::uuid
  `;

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "refund_requests",
    targetId: refund.id,
    oldValues: { status: "pending_approval" },
    newValues: {
      status: "completed",
      kind: refund.kind,
      checker_id: userId,
      erpnext_document: docname,
      amount_minor: refund.amount_minor,
    },
  });

  const row = await getRefundById(tx, schoolId, refund.id);
  if (!row) throw new Error("refund row vanished after update");
  return row;
}

// ---------------------------------------------------------------------------
// Checker step — reject a refund
// ---------------------------------------------------------------------------

export async function rejectRefund(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  refundId: string,
  reasonNotes: string,
): Promise<RefundRow> {
  const refund = await getRefundById(tx, schoolId, refundId);
  if (!refund) {
    throw new CodedHttpException(404, ERROR_CODES.REFUND_NOT_FOUND, "Refund request not found");
  }

  if (refund.status !== "pending_approval") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.REFUND_INVALID_STATUS,
      `Cannot reject a refund with status '${refund.status}'`,
    );
  }

  if (refund.maker_id === userId) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.REFUND_CONFIRM_SELF,
      "The maker and checker must be different users",
    );
  }

  await tx`
    UPDATE app.refund_requests
    SET status = 'rejected',
        checker_id = ${userId}::uuid,
        reason_notes = ${reasonNotes},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${refundId}::uuid
  `;

  // Release the idempotency key so the caller can correct and retry.
  const refundKey = refund.idempotency_key;
  if (refundKey) {
    await tx`
      DELETE FROM app.refund_idempotency_logs
      WHERE school_id = ${schoolId}::uuid
        AND idempotency_key = ${refundKey}
    `;
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "refund_requests",
    targetId: refundId,
    oldValues: {
      status: "pending_approval",
    },
    newValues: {
      status: "rejected",
      checker_id: userId,
      reason_notes: reasonNotes,
    },
  });

  const row = await getRefundById(tx, schoolId, refundId);
  if (!row) throw new Error("refund row vanished after update");
  return row;
}

// ---------------------------------------------------------------------------
// Webhook completion — apply the confirmed credit note
// ---------------------------------------------------------------------------

export async function applyRefundCompleted(
  tx: TransactionSql,
  schoolId: string,
  creditNoteId: string,
  _doc: Record<string, unknown>,
): Promise<void> {
  const [refund] = await tx<Record<string, unknown>[]>`
    SELECT id, status, student_id, amount_minor
    FROM app.refund_requests
    WHERE school_id = ${schoolId}::uuid
      AND erpnext_credit_note_id = ${creditNoteId}
  `;

  if (!refund) {
    return;
  }

  if (refund.status !== "submitted_to_erpnext") {
    return;
  }

  await tx`
    UPDATE app.refund_requests
    SET status = 'completed',
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${refund.id as string}::uuid
  `;

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "refund_requests",
    targetId: refund.id as string,
    oldValues: {
      status: "submitted_to_erpnext",
    },
    newValues: {
      status: "completed",
      erpnext_credit_note_id: creditNoteId,
      completed_at: new Date().toISOString(),
    },
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function getRefundById(
  tx: TransactionSql,
  schoolId: string,
  refundId: string,
): Promise<RefundRow | null> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(REFUND_COLUMNS)}
    FROM app.refund_requests AS rr
    JOIN app.currencies AS c ON c.id = rr.currency_id
    WHERE rr.school_id = ${schoolId}::uuid AND rr.id = ${refundId}::uuid
  `;
  if (!row) return null;
  return parseRefundRow(row);
}

// A rejection releases the key (see rejectRefund), so an earlier rejected request may share it; the
// replay is of the newest request made under the key.
async function findRefundByIdempotencyKey(
  tx: TransactionSql,
  schoolId: string,
  idempotencyKey: string,
): Promise<RefundRow | null> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(REFUND_COLUMNS)}
    FROM app.refund_requests AS rr
    JOIN app.currencies AS c ON c.id = rr.currency_id
    WHERE rr.school_id = ${schoolId}::uuid
      AND rr.kind = 'credit_note'
      AND rr.idempotency_key = ${idempotencyKey}
    ORDER BY rr.created_at DESC, rr.id DESC
    LIMIT 1
  `;
  if (!row) return null;
  return parseRefundRow(row);
}

export async function getRefund(
  tx: TransactionSql,
  schoolId: string,
  refundId: string,
): Promise<RefundRow> {
  const row = await getRefundById(tx, schoolId, refundId);
  if (!row) {
    throw new CodedHttpException(404, ERROR_CODES.REFUND_NOT_FOUND, "Refund request not found");
  }
  return row;
}

export async function listRefunds(
  tx: TransactionSql,
  schoolId: string,
  params: ListRefundsParams,
): Promise<{ rows: RefundRow[]; total: number }> {
  const conditions = tx`rr.school_id = ${schoolId}::uuid`;
  const studentFilter = params.student_id
    ? tx` AND rr.student_id = ${params.student_id}::uuid`
    : tx``;
  const statusFilter = params.status ? tx` AND rr.status = ${params.status}` : tx``;
  const kindFilter = params.kind ? tx` AND rr.kind = ${params.kind}` : tx``;

  const [rows, [count]] = await Promise.all([
    tx<Record<string, unknown>[]>`
      SELECT ${tx.unsafe(REFUND_COLUMNS)}
      FROM app.refund_requests AS rr
      JOIN app.currencies AS c ON c.id = rr.currency_id
      WHERE ${conditions}${studentFilter}${statusFilter}${kindFilter}
      ORDER BY rr.created_at DESC
      LIMIT ${params.limit} OFFSET ${params.offset}
    `,
    tx<{ total: number }[]>`
      SELECT count(*)::int AS total
      FROM app.refund_requests AS rr
      WHERE ${conditions}${studentFilter}${statusFilter}${kindFilter}
    `,
  ]);

  return { rows: rows.map(parseRefundRow), total: count?.total ?? 0 };
}
