import { createHash } from "node:crypto";

import { ERROR_CODES } from "@studafy/constants";
import { captureError } from "@studafy/observability";

import { CodedHttpException } from "../../../coded-http-exception";
import { tenantTxRunner, withTenantTx } from "../../../db/tenant-tx";
import { ErpNextError } from "../../../erpnext/client";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { formatMinorUnits, getCurrencyByCode, toMinorUnits } from "../currency";

import type { Database } from "../../../db/client";
import type { TenantContext, TxRunner } from "../../../db/tenant-tx";
import type { Logger } from "../../../logger";
import type { TenantErpNext, TenantErpNextFactory } from "../client/tenant-client";
import type { TransactionSql } from "postgres";

const SALES_INVOICE_RESOURCE = "/api/resource/Sales%20Invoice";

export type ReasonCode =
  "overpayment" | "withdrawal" | "discount_adjustment" | "error_correction" | "write_off";
/**
 * What the approval does in ERPNext (000177). `credit_note`: a Sales Invoice return (a refund, a
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

/** The one ERPNext write an approval makes, decided while the request is claimed. */
interface ApprovalCall {
  path: string;
  body: Record<string, unknown>;
  /** The ERPNext document the call acts on (a cancellation's invoice or Payment Entry). */
  docname: string | null;
}

/** Where an approval's ERPNext write stands, as far as ERPNext itself says. */
type ErpNextOutcome =
  /** Applied: the credit note exists (its name), or the document is cancelled (null). */
  | { applied: true; creditNoteId: string | null }
  /** Confirmed not applied: safe to hand the claim back. */
  | { applied: false };

/** A claim older than this is no longer in flight: its approval request has long ended. */
export const STALE_REFUND_CLAIM_MINUTES = 15;

/** Logs where an approval's outcome could not be settled. Defaults to nothing (tests). */
export type RefundLog = Pick<Logger, "error" | "warn" | "info">;

/**
 * The text a credit note carries in its standard `remarks` field so it can be found again after an
 * ambiguous failure. `remarks` is a stock Sales Invoice field on every ERPNext site, so the lookup
 * needs no custom field (unknown `custom_*` fields are dropped silently by Frappe on insert).
 */
export function refundTag(refundId: string): string {
  return `Studafy refund request ${refundId}`;
}

/**
 * The checker step: approve a pending request and make its ERPNext write exactly once, as
 * claim -> call -> finalize, with no transaction open while ERPNext is called:
 *
 *   1. claim    -- one short transaction re-checks the request (pending, a different checker, a
 *                  still-confirmed payment for a reversal) and moves it to `approved`. The UPDATE is
 *                  conditional on `pending_approval`, so of two concurrent approvals exactly one
 *                  wins and ERPNext is called once.
 *   2. call     -- the ERPNext POST, one attempt (`retry: false`: a retried write could apply twice).
 *   3. finalize -- one short transaction records the outcome and the audit entry.
 *
 * When the call fails, what happens depends on whether ERPNext could have applied it:
 *   - definitive refusal (ERPNext answered 4xx, or the circuit was open so nothing was sent): the
 *     claim is handed back (`pending_approval` again) and ERPNext's error is returned.
 *   - ambiguous (timeout, connection lost, 5xx -- or a 2xx without the credit note's name): ERPNext
 *     is asked once whether the write landed (lookUpOutcome). Applied -> finalized as a success.
 *     Confirmed absent -> handed back, as a refusal. The lookup fails too -> the request stays
 *     `approved` (it can never be approved, and posted, twice), the failure is reported, and
 *     reconcileStaleRefundClaims settles it later; the caller gets 503.
 *
 * Approving a request whose claim went stale (`approved` for over STALE_REFUND_CLAIM_MINUTES)
 * first settles that claim the same way, then approves it normally only if ERPNext has nothing.
 */
export async function approveRefund(
  runTx: TxRunner,
  erpnextFor: (tx: TransactionSql) => Promise<TenantErpNext>,
  schoolId: string,
  userId: string,
  refundId: string,
  acceptLanguage?: string,
  log?: RefundLog,
): Promise<RefundRow> {
  const settled = await settleStaleClaim(runTx, erpnextFor, schoolId, refundId, log);
  if (settled) return settled;

  const claim = await runTx(async (tx) => {
    const refund = await getRefundById(tx, schoolId, refundId);
    if (!refund) {
      throw new CodedHttpException(404, ERROR_CODES.REFUND_NOT_FOUND, "Refund request not found");
    }
    assertApprovable(refund, userId);

    const call =
      refund.kind === "credit_note"
        ? await creditNoteCall(tx, schoolId, refund)
        : await cancellationCall(tx, schoolId, refund);

    const claimed = await tx`
      UPDATE app.refund_requests
      SET status = 'approved', checker_id = ${userId}::uuid, approved_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE school_id = ${schoolId}::uuid AND id = ${refundId}::uuid
        AND status = 'pending_approval'
    `;
    if (claimed.count === 0) {
      // A concurrent approval or rejection got there first.
      throw new CodedHttpException(
        409,
        ERROR_CODES.REFUND_INVALID_STATUS,
        "This request was approved or rejected by someone else",
      );
    }

    return {
      refund: { ...refund, checker_id: userId },
      call,
      erpnext: await erpnextFor(tx),
    };
  });
  const { refund, call, erpnext } = claim;

  // Only the POST is inside the try: a lookup's own 503 must not be mistaken for the call failing.
  let created: { name?: string } | undefined;
  let callError: unknown = null;
  try {
    const response = await erpnext.post<{ data?: { name?: string } }>(call.path, call.body, {
      acceptLanguage,
      retry: false,
    });
    created = response.data.data ?? {};
  } catch (error) {
    callError = error;
  }

  let outcome: ErpNextOutcome;
  if (created) {
    const creditNoteId = created.name?.trim() || null;
    outcome =
      refund.kind !== "credit_note" || creditNoteId
        ? { applied: true, creditNoteId }
        : await resolveAccepted(erpnext, refund, log);
  } else {
    outcome = isDefinitiveRefusal(callError)
      ? { applied: false }
      : await resolveAmbiguous(erpnext, refund, call.docname, callError, log);
  }

  if (!outcome.applied) {
    await releaseClaim(runTx, schoolId, refundId, userId);
    translateErpNextRefundError(callError);
  }

  return runTx((tx) => finalizeApproval(tx, schoolId, refund, call.docname, outcome));
}

/**
 * A definitive refusal: ERPNext answered with a verdict (4xx) or was never called (open circuit).
 * Anything else -- timeout, connection lost, 5xx, an unexpected throw -- may have been applied.
 */
function isDefinitiveRefusal(error: unknown): boolean {
  if (!(error instanceof ErpNextError)) return false;
  if (error.kind === "circuit_open") return true;
  return error.kind === "http" && error.status < 500;
}

/** Thrown when ERPNext could not say whether a refund's write landed. The request stays approved. */
function outcomeUnknown(): CodedHttpException {
  return new CodedHttpException(
    503,
    ERROR_CODES.ERPNEXT_UNAVAILABLE,
    "ERPNext did not confirm the refund. It stays approved and is checked against ERPNext " +
      "automatically; do not post it again in ERPNext.",
  );
}

/**
 * ERPNext accepted the return (2xx) but did not say its name. It was accepted, so "not found" is
 * not proof of absence: only a found note is recorded; anything else stays approved (503).
 */
async function resolveAccepted(
  erpnext: TenantErpNext,
  refund: RefundRow,
  log?: RefundLog,
): Promise<ErpNextOutcome> {
  let outcome: ErpNextOutcome;
  try {
    outcome = await lookUpOutcome(erpnext, refund, null);
  } catch (lookupError) {
    reportUnsettled(refund, "approval", lookupError, null, log);
    throw outcomeUnknown();
  }
  if (!outcome.applied) {
    reportUnsettled(refund, "approval", new Error("accepted credit note not found"), null, log);
    throw outcomeUnknown();
  }
  return outcome;
}

/**
 * After an ambiguous failure, ask ERPNext once whether the write landed. If even that fails the
 * request stays approved: report it and answer 503 (outcomeUnknown).
 */
async function resolveAmbiguous(
  erpnext: TenantErpNext,
  refund: RefundRow,
  docname: string | null,
  callError: unknown,
  log?: RefundLog,
): Promise<ErpNextOutcome> {
  try {
    return await lookUpOutcome(erpnext, refund, docname);
  } catch (lookupError) {
    reportUnsettled(refund, "approval", lookupError, callError, log);
    throw outcomeUnknown();
  }
}

function reportUnsettled(
  refund: Pick<RefundRow, "id" | "school_id" | "kind">,
  stage: "approval" | "reconciliation",
  lookupError: unknown,
  callError: unknown,
  log?: RefundLog,
): void {
  const context = {
    refund_request_id: refund.id,
    school_id: refund.school_id,
    kind: refund.kind,
    stage,
  };
  log?.error(
    {
      ...context,
      lookup_error: lookupError instanceof Error ? lookupError.message : String(lookupError),
      call_error:
        callError instanceof Error ? callError.message : callError ? String(callError) : null,
    },
    "refund outcome unknown: ERPNext could not be checked; the request stays approved",
  );
  captureError(lookupError, {
    tags: { refund_request_id: refund.id, school_id: refund.school_id, stage },
    extra: { kind: refund.kind },
  });
}

/**
 * Whether an approval's ERPNext write landed, read from ERPNext with GETs only (it never posts):
 *   - credit note: a submitted return Sales Invoice against the invoice whose `remarks` carry the
 *     refund's tag (refundTag).
 *   - cancellation / reversal: the target document's docstatus is 2 (cancelled).
 * Throws when ERPNext cannot be asked.
 */
export async function lookUpOutcome(
  erpnext: TenantErpNext,
  refund: Pick<RefundRow, "id" | "kind" | "erpnext_invoice_id">,
  docname: string | null,
): Promise<ErpNextOutcome> {
  if (refund.kind === "credit_note") {
    const filters = JSON.stringify([
      ["is_return", "=", 1],
      ["return_against", "=", refund.erpnext_invoice_id],
      ["docstatus", "=", 1],
      ["remarks", "like", `%${refundTag(refund.id)}%`],
    ]);
    const response = await erpnext.get<{ data?: { name?: string }[] }>(
      `${SALES_INVOICE_RESOURCE}?filters=${encodeURIComponent(filters)}` +
        `&fields=${encodeURIComponent(JSON.stringify(["name"]))}&limit_page_length=1`,
    );
    const name = response.data.data?.[0]?.name?.trim();
    return name ? { applied: true, creditNoteId: name } : { applied: false };
  }

  const doctype = refund.kind === "invoice_cancellation" ? "Sales%20Invoice" : "Payment%20Entry";
  const target = docname ?? refund.erpnext_invoice_id;
  const response = await erpnext.get<{ data?: { docstatus?: number } }>(
    `/api/resource/${doctype}/${encodeURIComponent(target)}`,
  );
  return response.data.data?.docstatus === 2
    ? { applied: true, creditNoteId: null }
    : { applied: false };
}

/** Record an applied approval: the same writes whether it was seen at once or found later. */
async function finalizeApproval(
  tx: TransactionSql,
  schoolId: string,
  refund: RefundRow,
  docname: string | null,
  outcome: Extract<ErpNextOutcome, { applied: true }>,
): Promise<RefundRow> {
  // Locked and re-checked: an approval's own finalize and a later settle of the same claim must
  // not both apply (a reversal's invoice balance would be raised twice).
  const [locked] = await tx<{ status: string }[]>`
    SELECT status FROM app.refund_requests
    WHERE school_id = ${schoolId}::uuid AND id = ${refund.id}::uuid
    FOR UPDATE
  `;
  if (locked?.status !== "approved") {
    const current = await getRefundById(tx, schoolId, refund.id);
    if (!current) throw new Error("refund row vanished");
    return current;
  }
  if (refund.kind !== "credit_note") {
    return finalizeCancellation(tx, schoolId, refund.checker_id!, refund, docname);
  }
  return finalizeCreditNote(tx, schoolId, refund, outcome.creditNoteId!);
}

async function finalizeCreditNote(
  tx: TransactionSql,
  schoolId: string,
  refund: RefundRow,
  creditNoteId: string,
): Promise<RefundRow> {
  await tx`
    UPDATE app.refund_requests
    SET status = 'submitted_to_erpnext',
        erpnext_credit_note_id = ${creditNoteId},
        updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId}::uuid AND id = ${refund.id}::uuid
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
    targetId: refund.id,
    oldValues: {
      status: "pending_approval",
    },
    newValues: {
      status: "submitted_to_erpnext",
      checker_id: refund.checker_id,
      erpnext_credit_note_id: creditNoteId,
      reason_code: refund.reason_code,
      amount_minor: refund.amount_minor,
    },
  });

  const row = await getRefundById(tx, schoolId, refund.id);
  if (!row) throw new Error("refund row vanished after update");
  return row;
}

// ---------------------------------------------------------------------------
// Stale claims -- requests left `approved` by an approval whose outcome was not settled
// ---------------------------------------------------------------------------

/** What settling one stale claim did. */
export type StaleClaimResult = "finalized" | "released" | "unknown";

/** The ERPNext document a claimed cancellation or reversal acts on. */
async function claimedDocname(
  tx: TransactionSql,
  schoolId: string,
  refund: RefundRow,
): Promise<string | null> {
  if (refund.kind === "credit_note") return null;
  if (refund.kind === "invoice_cancellation") return refund.erpnext_invoice_id;
  const [payment] = await tx<{ erpnext_docname: string }[]>`
    SELECT erpnext_docname FROM app.payment_cache
    WHERE school_id = ${schoolId}::uuid AND id = ${refund.payment_entry_id}::uuid
  `;
  return payment?.erpnext_docname ?? null;
}

/**
 * Settle one claim: look it up in ERPNext (GETs only, nothing is ever posted from here), then
 * finalize it if the write landed, or hand it back to `pending_approval` if it did not. A lookup
 * failure leaves it `approved` and is reported. The finalize and release are conditional on the
 * request still being this claim, so a concurrent settle cannot apply twice.
 */
export async function settleClaim(
  runTx: TxRunner,
  erpnext: TenantErpNext,
  schoolId: string,
  refund: RefundRow,
  log?: RefundLog,
): Promise<{ result: StaleClaimResult; row: RefundRow | null }> {
  const docname = await runTx((tx) => claimedDocname(tx, schoolId, refund));
  if (refund.kind !== "credit_note" && !docname) {
    reportUnsettled(refund, "reconciliation", new Error("payment row missing"), null, log);
    return { result: "unknown", row: null };
  }

  let outcome: ErpNextOutcome;
  try {
    outcome = await lookUpOutcome(erpnext, refund, docname);
  } catch (error) {
    reportUnsettled(refund, "reconciliation", error, null, log);
    return { result: "unknown", row: null };
  }

  if (outcome.applied) {
    const row = await runTx((tx) => finalizeApproval(tx, schoolId, refund, docname, outcome));
    log?.info(
      { refund_request_id: refund.id, school_id: schoolId },
      "stale refund claim finalized",
    );
    return { result: "finalized", row };
  }

  await releaseClaim(runTx, schoolId, refund.id, refund.checker_id!);
  log?.info({ refund_request_id: refund.id, school_id: schoolId }, "stale refund claim released");
  return { result: "released", row: null };
}

/**
 * Before a new approval: a request left `approved` for longer than STALE_REFUND_CLAIM_MINUTES is
 * settled first. Returns the finalized row when ERPNext had applied it; null to carry on (a fresh
 * claim then follows, or a 409 for a claim still in flight). 503 when ERPNext cannot be asked.
 */
async function settleStaleClaim(
  runTx: TxRunner,
  erpnextFor: (tx: TransactionSql) => Promise<TenantErpNext>,
  schoolId: string,
  refundId: string,
  log?: RefundLog,
): Promise<RefundRow | null> {
  const stale = await runTx(async (tx) => {
    const [row] = await tx<{ stale: boolean }[]>`
      SELECT approved_at < now() - make_interval(mins => ${STALE_REFUND_CLAIM_MINUTES}) AS stale
      FROM app.refund_requests
      WHERE school_id = ${schoolId}::uuid AND id = ${refundId}::uuid AND status = 'approved'
    `;
    if (!row?.stale) return null;
    return {
      refund: (await getRefundById(tx, schoolId, refundId))!,
      erpnext: await erpnextFor(tx),
    };
  });
  if (!stale) return null;

  const { result, row } = await settleClaim(runTx, stale.erpnext, schoolId, stale.refund, log);
  if (result === "unknown") throw outcomeUnknown();
  return result === "finalized" ? row : null;
}

/** How many stale claims one school's sweep settles at most; the rest wait for the next run. */
export const STALE_REFUND_SWEEP_LIMIT = 20;

/**
 * Settle a school's stale claims (reconciliation job). Lists them in one short transaction and
 * opens an ERPNext client only when there is something to settle. Bounded by
 * STALE_REFUND_SWEEP_LIMIT per run.
 */
export async function reconcileStaleRefundClaims(
  database: Database,
  erpnextFactory: Pick<TenantErpNextFactory, "forSchool">,
  schoolId: string,
  log?: RefundLog,
): Promise<Record<StaleClaimResult, number>> {
  const counts: Record<StaleClaimResult, number> = { finalized: 0, released: 0, unknown: 0 };
  const listed = await withTenantTx(database, { schoolId }, async (tx) => {
    const ids = await tx<{ id: string }[]>`
      SELECT id FROM app.refund_requests
      WHERE school_id = ${schoolId}::uuid AND status = 'approved'
        AND approved_at < now() - make_interval(mins => ${STALE_REFUND_CLAIM_MINUTES})
      ORDER BY approved_at
      LIMIT ${STALE_REFUND_SWEEP_LIMIT}
    `;
    if (ids.length === 0) return null;
    const refunds: RefundRow[] = [];
    for (const { id } of ids) {
      const row = await getRefundById(tx, schoolId, id);
      if (row) refunds.push(row);
    }
    return { refunds, erpnext: await erpnextFactory.forSchool(tx, schoolId) };
  });
  if (!listed) return counts;

  for (const refund of listed.refunds) {
    // As the checker who approved it, so the audit entry of a finalize names them.
    const runTx = tenantTxRunner(database, { schoolId, userId: refund.checker_id ?? undefined });
    try {
      const { result } = await settleClaim(runTx, listed.erpnext, schoolId, refund, log);
      counts[result] += 1;
    } catch (error) {
      counts.unknown += 1;
      reportUnsettled(refund, "reconciliation", error, null, log);
    }
  }
  return counts;
}

function assertApprovable(refund: RefundRow, userId: string): void {
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
}

/**
 * Hand a claim back once ERPNext refused it or is confirmed not to have applied it: nothing was
 * written there, so the request is pending again, exactly as before the approval. Conditional on
 * still being this checker's claim. If even this cannot be written the request stays `approved` --
 * the safe side; the reconciliation settles it.
 */
async function releaseClaim(
  runTx: TxRunner,
  schoolId: string,
  refundId: string,
  userId: string,
): Promise<void> {
  try {
    await runTx(
      (tx) => tx`
        UPDATE app.refund_requests
        SET status = 'pending_approval', checker_id = NULL, approved_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE school_id = ${schoolId}::uuid AND id = ${refundId}::uuid
          AND status = 'approved' AND checker_id = ${userId}::uuid
      `,
    );
  } catch {
    // See above.
  }
}

/** A credit note: a submitted return Sales Invoice against the refunded invoice. */
async function creditNoteCall(
  tx: TransactionSql,
  schoolId: string,
  refund: RefundRow,
): Promise<ApprovalCall> {
  const currency = await getCurrencyByCode(tx, refund.currency);
  if (!currency) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      `Currency for refund no longer active: ${refund.currency}`,
    );
  }

  const amountDecimal = Number(refund.amount_minor) / Math.pow(10, currency.minorUnit);

  return {
    path: SALES_INVOICE_RESOURCE,
    body: {
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
      // How the note is found again after an ambiguous failure (lookUpOutcome).
      remarks: refundTag(refund.id),
      docstatus: 1,
    },
    docname: null,
  };
}

// ---------------------------------------------------------------------------
// Maker step — ask to cancel an invoice or reverse a payment (000177)
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
 * The ERPNext call for a cancellation or reversal: cancel the document (docstatus 2). A reversal
 * cancels the payment's Payment Entry, so the payment must still be confirmed.
 */
async function cancellationCall(
  tx: TransactionSql,
  schoolId: string,
  refund: RefundRow,
): Promise<ApprovalCall> {
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

  return {
    path: FRAPPE_CANCEL,
    body: {
      doctype: refund.kind === "invoice_cancellation" ? "Sales Invoice" : "Payment Entry",
      name: docname,
    },
    docname,
  };
}

/**
 * Once ERPNext has cancelled the document, bring the local read models in line at once rather than
 * waiting for a webhook ERPNext does not send on cancel. A reversal makes its invoice owed again
 * by the payment's amount, capped at the invoice total; the next reconciliation corrects any drift.
 */
async function finalizeCancellation(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  refund: RefundRow,
  docname: string | null,
): Promise<RefundRow> {
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
    SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId}::uuid AND id = ${refund.id}::uuid
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
