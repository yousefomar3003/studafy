/**
 * Subscription refund requests: filed by a school's billing admin (the school's plan) or by a
 * student or their parent (the student's AI add-on), reviewed by Studafy staff in the platform
 * console, and issued through the provider that took the payment.
 *
 * ## Which payment, at which provider
 *
 * Both kinds of subscription are billed to the *school's* provider customer (see
 * `ensureProviderCustomer` in checkout-service.ts), so a refund always goes to that customer's
 * provider: Tap when the school has a Tap customer, Stripe otherwise -- the same rule
 * invoice-service.ts reads invoices by. The payment is named the way `listInvoices` names it, and is
 * re-read from the provider before it is recorded, so a request can only ever point at a paid charge
 * on its own school's account.
 *
 * ## Approval
 *
 * Three steps, so money never moves inside a transaction that could still roll back: claim the row
 * (`pending`/`failed` -> `approved`, under a row lock, so a double-click cannot refund twice), call
 * the provider, then record the outcome (`refunded` or `failed`). A process that dies between the
 * last two leaves the row `approved`, which nothing re-approves: a person checks the provider first.
 *
 * ## Cross-tenant reads and audit
 *
 * The table is tenant-isolated, so the console reads it the way modules/platform/service.ts reads
 * every tenant table: one school at a time, arming each scope in turn inside one `withSystemTx`. A
 * console decision is audited twice, as platform changes are: in the request's school with a NULL
 * actor, and in the operator's home school with the operator as actor.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { setTenantScope, withSystemTx, withTenantTx } from "../../../db/tenant-tx";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { requirePaymentProvider } from "../payment-provider-routing";

import { scheduleCancellation } from "./cancellation-service";
import { requireSchoolSubscription } from "./subscription-service";

import type { Database } from "../../../db";
import type { TenantContext } from "../../../db/tenant-tx";
import type { AuditEntry } from "../../../middleware/auditEmitter";
import type { PaymentProviderRegistry } from "../payment-provider-routing";
import type { InvoiceSummary, PaymentProviderPort } from "../ports/payment-provider";
import type { BillingProvider } from "@studafy/billing";
import type { TransactionSql } from "postgres";

export const REFUND_SCOPES = ["school", "ai"] as const;
export type RefundScope = (typeof REFUND_SCOPES)[number];

export const REFUND_REASONS = [
  "accidental_purchase",
  "duplicate_charge",
  "service_issue",
  "not_as_described",
  "no_longer_needed",
  "other",
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export const REFUND_STATUSES = ["pending", "approved", "rejected", "refunded", "failed"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** How far back a named payment is looked for at the provider: five pages of 100. */
const PAYMENT_LOOKUP_PAGES = 5;
const PAYMENT_LOOKUP_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Row types and mapping
// ---------------------------------------------------------------------------

interface RefundRequestRow {
  id: string;
  school_id: string;
  subscription_type: RefundScope;
  subscription_id: string;
  requested_by: string;
  provider: BillingProvider;
  payment_reference: string | null;
  // bigint columns arrive as strings; read as text and converted once in toRequest.
  amount_minor: string | null;
  currency_code: string | null;
  reason: RefundReason;
  details: string | null;
  status: RefundStatus;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  refunded_amount_minor: string | null;
  provider_refund_id: string | null;
  failure_message: string | null;
  refunded_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface RefundRequestDetailRow extends RefundRequestRow {
  requester_name: string;
  requester_email: string;
  student_name: string | null;
}

const REQUEST_COLUMNS = (tx: TransactionSql) => tx`
  r.id, r.school_id, r.subscription_type::text AS subscription_type, r.subscription_id,
  r.requested_by, r.provider, r.payment_reference, r.amount_minor::text AS amount_minor,
  r.currency_code, r.reason, r.details, r.status, r.reviewed_by, r.reviewed_at, r.review_note,
  r.refunded_amount_minor::text AS refunded_amount_minor, r.provider_refund_id, r.failure_message,
  r.refunded_at, r.created_at, r.updated_at
`;

/** The request plus who filed it and, for an AI add-on, which student it is for. */
const DETAIL_COLUMNS = (tx: TransactionSql) => tx`
  ${REQUEST_COLUMNS(tx)},
  u.display_name AS requester_name, u.email AS requester_email,
  CASE WHEN st.id IS NULL THEN NULL ELSE st.first_name || ' ' || st.last_name END AS student_name
`;

const DETAIL_JOINS = (tx: TransactionSql) => tx`
  JOIN app.users u ON u.id = r.requested_by
  LEFT JOIN app.ai_subscriptions ai
    ON r.subscription_type = 'ai' AND ai.id = r.subscription_id
  LEFT JOIN app.students st ON st.id = ai.student_id
`;

const iso = (value: Date) => value.toISOString();
const isoOrNull = (value: Date | null) => (value ? value.toISOString() : null);
const numberOrNull = (value: string | null) => (value === null ? null : Number(value));

/** What a requester sees of their own request: the decision, never the provider's internals. */
function toRequest(row: RefundRequestRow) {
  return {
    id: row.id,
    scope: row.subscription_type,
    status: row.status,
    reason: row.reason,
    details: row.details,
    paymentReference: row.payment_reference,
    amountMinor: numberOrNull(row.amount_minor),
    currencyCode: row.currency_code,
    refundedAmountMinor: row.status === "refunded" ? numberOrNull(row.refunded_amount_minor) : null,
    reviewNote: row.review_note,
    reviewedAt: isoOrNull(row.reviewed_at),
    refundedAt: isoOrNull(row.refunded_at),
    createdAt: iso(row.created_at),
  };
}

export type SubscriptionRefundRequest = ReturnType<typeof toRequest>;

function toPlatformRequest(row: RefundRequestDetailRow, schoolName: string) {
  return {
    ...toRequest(row),
    refundedAmountMinor: numberOrNull(row.refunded_amount_minor),
    schoolId: row.school_id,
    schoolName,
    subscriptionId: row.subscription_id,
    provider: row.provider,
    requester: { id: row.requested_by, name: row.requester_name, email: row.requester_email },
    studentName: row.student_name,
    reviewedBy: row.reviewed_by,
    providerRefundId: row.provider_refund_id,
    failureMessage: row.failure_message,
    updatedAt: iso(row.updated_at),
  };
}

export type PlatformRefundRequest = ReturnType<typeof toPlatformRequest>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface BillingCustomer {
  provider: BillingProvider;
  customerId: string;
}

/** The school's provider customer, by the same Tap-first rule invoice-service.ts reads with. */
async function billingCustomer(tx: TransactionSql, schoolId: string): Promise<BillingCustomer> {
  const [school] = await tx<
    { stripe_customer_id: string | null; tap_customer_id: string | null }[]
  >`
    SELECT stripe_customer_id, tap_customer_id
    FROM app.schools
    WHERE id = ${schoolId}::uuid
    LIMIT 1
  `;
  if (school?.tap_customer_id) return { provider: "tap", customerId: school.tap_customer_id };
  if (school?.stripe_customer_id) {
    return { provider: "stripe", customerId: school.stripe_customer_id };
  }
  throw new CodedHttpException(
    400,
    ERROR_CODES.SUBSCRIPTION_NOT_LINKED_TO_PROVIDER,
    "Nothing has been paid through a payment provider for this subscription",
  );
}

/**
 * The named payment, re-read from the provider: it must be a paid charge on this customer's own
 * account. Anything else -- not found within the lookup window, unpaid, voided -- is one answer.
 */
async function requirePaidPayment(
  port: PaymentProviderPort,
  customerId: string,
  reference: string,
): Promise<InvoiceSummary> {
  let startingAfter: string | undefined;
  for (let page = 0; page < PAYMENT_LOOKUP_PAGES; page++) {
    const result = await port.listInvoices({
      customerId,
      limit: PAYMENT_LOOKUP_PAGE_SIZE,
      startingAfter,
    });
    const match = result.invoices.find((invoice) => invoice.id === reference);
    if (match) {
      if (match.status === "paid" && match.amountPaid > 0) return match;
      break;
    }
    if (!result.hasMore || result.invoices.length === 0) break;
    startingAfter = result.invoices.at(-1)!.id;
  }
  throw new CodedHttpException(
    400,
    ERROR_CODES.SUBSCRIPTION_REFUND_PAYMENT_NOT_REFUNDABLE,
    "Payment not found, or not a paid charge that can be refunded",
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505"
  );
}

function alreadyRequested(): CodedHttpException {
  return new CodedHttpException(
    409,
    ERROR_CODES.SUBSCRIPTION_REFUND_ALREADY_REQUESTED,
    "A refund request for this subscription is already open",
  );
}

interface NewRequest {
  schoolId: string;
  scope: RefundScope;
  subscriptionId: string;
  requestedBy: string;
  provider: BillingProvider;
  payment: InvoiceSummary | null;
  reason: RefundReason;
  details: string | null;
}

/** Insert one request and its audit row. The open-request unique index is the real duplicate guard. */
async function insertRequest(
  database: Database,
  tenantContext: TenantContext,
  input: NewRequest,
): Promise<SubscriptionRefundRequest> {
  try {
    return await withTenantTx(database, tenantContext, async (tx) => {
      const [row] = await tx<RefundRequestRow[]>`
        INSERT INTO app.subscription_refund_requests AS r (
          school_id, subscription_type, subscription_id, requested_by, provider,
          payment_reference, amount_minor, currency_code, reason, details
        ) VALUES (
          ${input.schoolId}::uuid, ${input.scope}::app.billing_subscription_type,
          ${input.subscriptionId}::uuid, ${input.requestedBy}::uuid, ${input.provider},
          ${input.payment?.id ?? null}, ${input.payment?.amountPaid ?? null},
          ${input.payment?.currency ?? null}, ${input.reason}, ${input.details}
        )
        RETURNING ${REQUEST_COLUMNS(tx)}
      `;

      await emitAuditLog(tx, {
        action: "insert",
        targetTable: "subscription_refund_requests",
        targetId: row!.id,
        newValues: {
          subscription_type: input.scope,
          subscription_id: input.subscriptionId,
          payment_reference: input.payment?.id ?? null,
          amount_minor: input.payment?.amountPaid ?? null,
          reason: input.reason,
        },
      });

      return toRequest(row!);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw alreadyRequested();
    throw error;
  }
}

async function hasOpenRequest(
  tx: TransactionSql,
  scope: RefundScope,
  subscriptionId: string,
): Promise<boolean> {
  const [row] = await tx<{ found: boolean }[]>`
    SELECT true AS found FROM app.subscription_refund_requests
    WHERE subscription_type = ${scope}::app.billing_subscription_type
      AND subscription_id = ${subscriptionId}::uuid
      AND status IN ('pending', 'approved')
    LIMIT 1
  `;
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Requesters
// ---------------------------------------------------------------------------

export interface CreateSchoolRefundParams {
  paymentReference?: string;
  reason: RefundReason;
  details?: string;
  tenantContext: TenantContext & { userId: string };
}

/**
 * File a refund request for the caller's school plan. The caller's billing permission is checked by
 * the route; this checks there is something to refund and that nothing is already open.
 */
export async function createSchoolRefundRequest(
  database: Database,
  providers: PaymentProviderRegistry,
  params: CreateSchoolRefundParams,
): Promise<SubscriptionRefundRequest> {
  const { tenantContext } = params;
  const schoolId = tenantContext.schoolId;

  const { subscriptionId, customer } = await withTenantTx(database, tenantContext, async (tx) => {
    const sub = await requireSchoolSubscription(tx, schoolId);
    if (await hasOpenRequest(tx, "school", sub.id)) throw alreadyRequested();
    return { subscriptionId: sub.id, customer: await billingCustomer(tx, schoolId) };
  });

  // Read from the provider between the two transactions, never while one is held open.
  const payment = params.paymentReference
    ? await requirePaidPayment(
        requirePaymentProvider(providers, customer.provider).port,
        customer.customerId,
        params.paymentReference,
      )
    : null;

  return insertRequest(database, tenantContext, {
    schoolId,
    scope: "school",
    subscriptionId,
    requestedBy: tenantContext.userId,
    provider: customer.provider,
    payment,
    reason: params.reason,
    details: params.details?.trim() || null,
  });
}

export interface CreateAiRefundParams {
  studentId: string;
  reason: RefundReason;
  details?: string;
  tenantContext: TenantContext & { userId: string };
}

/**
 * File a refund request for one student's AI add-on, as that student or as a parent linked to them.
 *
 * Neither can see the school's invoices, so no payment is named: the reviewer picks it. Anyone else
 * gets a 404 -- whether a student exists is not the caller's business, the same rule the online fee
 * payment route applies.
 */
export async function createAiRefundRequest(
  database: Database,
  params: CreateAiRefundParams,
): Promise<SubscriptionRefundRequest> {
  const { studentId, tenantContext } = params;
  const schoolId = tenantContext.schoolId;

  const { subscriptionId, customer } = await withTenantTx(database, tenantContext, async (tx) => {
    const [allowed] = await tx<{ found: boolean }[]>`
      SELECT true AS found
      WHERE EXISTS (
        SELECT 1 FROM app.students
        WHERE id = ${studentId}::uuid AND user_id = ${tenantContext.userId}::uuid
      ) OR EXISTS (
        SELECT 1 FROM app.parent_child_links
        WHERE school_id = ${schoolId}::uuid
          AND parent_user_id = ${tenantContext.userId}::uuid
          AND student_id = ${studentId}::uuid
      )
    `;
    if (!allowed) {
      throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Student not found");
    }

    const [sub] = await tx<{ id: string }[]>`
      SELECT id FROM app.ai_subscriptions WHERE student_id = ${studentId}::uuid LIMIT 1
    `;
    if (!sub) {
      throw new CodedHttpException(
        404,
        ERROR_CODES.SUBSCRIPTION_NOT_FOUND,
        "Student has no AI subscription",
      );
    }
    if (await hasOpenRequest(tx, "ai", sub.id)) throw alreadyRequested();
    return { subscriptionId: sub.id, customer: await billingCustomer(tx, schoolId) };
  });

  return insertRequest(database, tenantContext, {
    schoolId,
    scope: "ai",
    subscriptionId,
    requestedBy: tenantContext.userId,
    provider: customer.provider,
    payment: null,
    reason: params.reason,
    details: params.details?.trim() || null,
  });
}

/** The school plan's refund requests, newest first. Every billing admin of the school sees them. */
export async function listSchoolRefundRequests(
  database: Database,
  tenantContext: TenantContext,
): Promise<SubscriptionRefundRequest[]> {
  return withTenantTx(database, tenantContext, async (tx) => {
    const rows = await tx<RefundRequestRow[]>`
      SELECT ${REQUEST_COLUMNS(tx)} FROM app.subscription_refund_requests r
      WHERE r.subscription_type = 'school'
      ORDER BY r.created_at DESC, r.id
      LIMIT 50
    `;
    return rows.map(toRequest);
  });
}

/** The AI add-on refund requests the caller filed, newest first. */
export async function listMyAiRefundRequests(
  database: Database,
  tenantContext: TenantContext & { userId: string },
): Promise<SubscriptionRefundRequest[]> {
  return withTenantTx(database, tenantContext, async (tx) => {
    const rows = await tx<RefundRequestRow[]>`
      SELECT ${REQUEST_COLUMNS(tx)} FROM app.subscription_refund_requests r
      WHERE r.subscription_type = 'ai' AND r.requested_by = ${tenantContext.userId}::uuid
      ORDER BY r.created_at DESC, r.id
      LIMIT 50
    `;
    return rows.map(toRequest);
  });
}

// ---------------------------------------------------------------------------
// Platform console
// ---------------------------------------------------------------------------

export interface PlatformActor {
  userId: string;
  schoolId: string;
  requestId?: string;
}

/**
 * One audit row in the request's school with a NULL actor, and one in the operator's home school
 * with the operator as actor -- see this file's header. Leaves the request's school scope armed.
 */
async function auditPlatformChange(
  tx: TransactionSql,
  schoolId: string,
  actor: PlatformActor,
  entry: AuditEntry,
): Promise<void> {
  const writeIn = async (scopeId: string, actorUserId: string | null) => {
    await setTenantScope(tx, scopeId, actor.requestId);
    await tx`SELECT set_config('app.user_id', ${actorUserId ?? ""}, true)`;
    await emitAuditLog(tx, entry);
  };

  if (actor.schoolId === schoolId) {
    await writeIn(schoolId, actor.userId);
    return;
  }
  await writeIn(actor.schoolId, actor.userId);
  await writeIn(schoolId, null);
}

async function loadDetail(
  tx: TransactionSql,
  requestId: string,
  lock = false,
): Promise<RefundRequestDetailRow> {
  const [row] = await tx<RefundRequestDetailRow[]>`
    SELECT ${DETAIL_COLUMNS(tx)}
    FROM app.subscription_refund_requests r
    ${DETAIL_JOINS(tx)}
    WHERE r.id = ${requestId}::uuid
    ${lock ? tx`FOR UPDATE OF r` : tx``}
  `;
  if (!row) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.SUBSCRIPTION_REFUND_NOT_FOUND,
      "Refund request not found",
    );
  }
  return row;
}

async function schoolName(tx: TransactionSql, schoolId: string): Promise<string> {
  const [school] = await tx<{ name: string }[]>`
    SELECT name FROM app.schools WHERE id = ${schoolId}::uuid
  `;
  if (!school) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.SUBSCRIPTION_REFUND_NOT_FOUND,
      "Refund request not found",
    );
  }
  return school.name;
}

export interface PlatformRefundFilters {
  status?: RefundStatus;
  scope?: RefundScope;
  schoolId?: string;
  search?: string;
  limit: number;
  offset: number;
}

/**
 * Every school's refund requests, newest first, with the count still waiting for review.
 *
 * One query per school (see this file's header), merged and paged here. `search` matches the school
 * name, or the requester's name or email.
 */
export async function listPlatformRefundRequests(
  database: Database,
  filters: PlatformRefundFilters,
) {
  return withSystemTx(database, async (tx) => {
    const schools = await tx<{ id: string; name: string }[]>`
      SELECT id, name FROM app.schools
      ${filters.schoolId ? tx`WHERE id = ${filters.schoolId}::uuid` : tx``}
      ORDER BY name, id
    `;

    const needle = filters.search?.toLowerCase();
    const pattern = filters.search ? `%${filters.search.replace(/[\\%_]/g, "\\$&")}%` : null;
    const matched: PlatformRefundRequest[] = [];
    let pendingCount = 0;

    for (const school of schools) {
      await setTenantScope(tx, school.id);
      const schoolMatches = needle !== undefined && school.name.toLowerCase().includes(needle);
      const rows = await tx<RefundRequestDetailRow[]>`
        SELECT ${DETAIL_COLUMNS(tx)}
        FROM app.subscription_refund_requests r
        ${DETAIL_JOINS(tx)}
        WHERE true
        ${filters.scope ? tx`AND r.subscription_type = ${filters.scope}::app.billing_subscription_type` : tx``}
        ${
          pattern && !schoolMatches
            ? tx`AND (u.display_name ILIKE ${pattern} OR u.email ILIKE ${pattern})`
            : tx``
        }
      `;
      for (const row of rows) {
        if (row.status === "pending") pendingCount++;
        if (!filters.status || row.status === filters.status) {
          matched.push(toPlatformRequest(row, school.name));
        }
      }
    }

    matched.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return {
      requests: matched.slice(filters.offset, filters.offset + filters.limit),
      total: matched.length,
      pendingCount,
    };
  });
}

/**
 * One request, plus -- while it can still be approved -- the school's recent paid payments, so the
 * reviewer can pick the one to refund. A provider that cannot be reached leaves `payments` null
 * rather than hiding the request.
 */
export async function getPlatformRefundRequest(
  database: Database,
  providers: PaymentProviderRegistry,
  schoolId: string,
  requestId: string,
) {
  const { request, customer } = await withSystemTx(database, async (tx) => {
    const name = await schoolName(tx, schoolId);
    await setTenantScope(tx, schoolId);
    const row = await loadDetail(tx, requestId);
    const reviewable = row.status === "pending" || row.status === "failed";
    return {
      request: toPlatformRequest(row, name),
      customer: reviewable ? await billingCustomer(tx, schoolId).catch(() => null) : null,
    };
  });

  let payments: InvoiceSummary[] | null = null;
  if (customer) {
    try {
      const port = requirePaymentProvider(providers, customer.provider).port;
      const page = await port.listInvoices({ customerId: customer.customerId, limit: 20 });
      payments = page.invoices.filter(
        (invoice) => invoice.status === "paid" && invoice.amountPaid > 0,
      );
    } catch {
      payments = null;
    }
  }

  return {
    request,
    payments:
      payments?.map((invoice) => ({
        id: invoice.id,
        amountPaid: invoice.amountPaid,
        currency: invoice.currency,
        created: invoice.created.toISOString(),
        periodStart: invoice.periodStart.toISOString(),
        periodEnd: invoice.periodEnd.toISOString(),
      })) ?? null,
  };
}

export interface ApproveRefundInput {
  /** Defaults to the whole payment. */
  amountMinor?: number;
  /** Required when the request names no payment; replaces the requester's choice otherwise. */
  paymentReference?: string;
  /** School plans only: also schedule the subscription to cancel at the end of its period. */
  cancelSubscription?: boolean;
  note?: string;
}

export type RefundCancellationOutcome =
  "not_requested" | "scheduled" | "already_scheduled" | "failed";

/**
 * Approve a `pending` (or retry a `failed`) request and issue the refund. See this file's header for
 * the three steps. A provider failure is recorded on the row and then re-thrown, so the console gets
 * the provider's own error and the row says `failed`.
 */
export async function approveRefundRequest(
  database: Database,
  providers: PaymentProviderRegistry,
  schoolId: string,
  requestId: string,
  input: ApproveRefundInput,
  actor: PlatformActor,
) {
  // 1. Read, then resolve the payment at the provider with no transaction open.
  const before = await withSystemTx(database, async (tx) => {
    await schoolName(tx, schoolId);
    await setTenantScope(tx, schoolId);
    return loadDetail(tx, requestId);
  });

  if (before.status !== "pending" && before.status !== "failed") throw invalidTransition();
  if (input.cancelSubscription && before.subscription_type !== "school") {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "Only a school plan can be cancelled from a refund approval",
    );
  }

  const reference = input.paymentReference ?? before.payment_reference;
  if (!reference) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.SUBSCRIPTION_REFUND_PAYMENT_REQUIRED,
      "Choose the payment to refund",
    );
  }

  const { port } = requirePaymentProvider(providers, before.provider);
  let payment: { amountMinor: number; currency: string };
  if (reference === before.payment_reference && before.amount_minor && before.currency_code) {
    payment = { amountMinor: Number(before.amount_minor), currency: before.currency_code };
  } else {
    const customer = await withSystemTx(database, (tx) => billingCustomer(tx, schoolId));
    if (customer.provider !== before.provider) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.SUBSCRIPTION_REFUND_PAYMENT_NOT_REFUNDABLE,
        "The school is now billed by a different payment provider than this request",
      );
    }
    const paid = await requirePaidPayment(port, customer.customerId, reference);
    payment = { amountMinor: paid.amountPaid, currency: paid.currency };
  }

  const amountMinor = input.amountMinor ?? payment.amountMinor;
  if (amountMinor > payment.amountMinor) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.SUBSCRIPTION_REFUND_AMOUNT_EXCEEDS_PAYMENT,
      "The refund amount is more than the payment",
    );
  }

  // 2. Claim the row. The status re-check under the lock is what stops a concurrent approval.
  const claimed = await withSystemTx(database, async (tx) => {
    await setTenantScope(tx, schoolId);
    const locked = await loadDetail(tx, requestId, true);
    if (locked.status !== "pending" && locked.status !== "failed") throw invalidTransition();

    const [row] = await tx<{ reviewed_at: Date }[]>`
      UPDATE app.subscription_refund_requests SET
        status = 'approved',
        payment_reference = ${reference},
        amount_minor = ${payment.amountMinor},
        currency_code = ${payment.currency},
        refunded_amount_minor = ${amountMinor},
        reviewed_by = ${actor.userId}::uuid,
        reviewed_at = clock_timestamp(),
        review_note = ${input.note?.trim() || null},
        failure_message = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${requestId}::uuid
      RETURNING reviewed_at
    `;

    await auditPlatformChange(tx, schoolId, actor, {
      action: "update",
      targetTable: "subscription_refund_requests",
      targetId: requestId,
      oldValues: { status: locked.status },
      newValues: {
        status: "approved",
        payment_reference: reference,
        refunded_amount_minor: amountMinor,
        currency_code: payment.currency,
      },
    });
    return row!;
  });

  // 3. Move the money, then record what happened.
  let outcome: { providerRefundId: string } | { error: unknown };
  try {
    const result = await port.refund({
      invoiceId: reference,
      amountMinor,
      currency: payment.currency,
      // One key per approval attempt: a retry after `failed` is a new attempt, not a replay.
      idempotencyKey: `subscription-refund-${requestId}-${claimed.reviewed_at.getTime()}`,
      metadata: { refund_request_id: requestId, school_id: schoolId },
    });
    outcome = { providerRefundId: result.providerRefundId };
  } catch (error) {
    outcome = { error };
  }

  await withSystemTx(database, async (tx) => {
    await setTenantScope(tx, schoolId);
    if ("providerRefundId" in outcome) {
      await tx`
        UPDATE app.subscription_refund_requests SET
          status = 'refunded',
          provider_refund_id = ${outcome.providerRefundId},
          refunded_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${requestId}::uuid
      `;
    } else {
      const message =
        outcome.error instanceof Error ? outcome.error.message : "Payment provider refund failed";
      await tx`
        UPDATE app.subscription_refund_requests SET
          status = 'failed',
          failure_message = ${message.slice(0, 2000)},
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${requestId}::uuid
      `;
    }

    await auditPlatformChange(tx, schoolId, actor, {
      action: "update",
      targetTable: "subscription_refund_requests",
      targetId: requestId,
      oldValues: { status: "approved" },
      newValues:
        "providerRefundId" in outcome
          ? { status: "refunded", provider_refund_id: outcome.providerRefundId }
          : { status: "failed" },
    });
  });

  if ("error" in outcome) throw outcome.error;

  // 4. Optionally end the plan. The refund has already happened, so a failure here is reported,
  // not thrown -- the operator cancels from the school's own billing page instead.
  let cancellation: RefundCancellationOutcome = "not_requested";
  if (input.cancelSubscription) {
    try {
      await scheduleCancellation(database, providers, {
        schoolId,
        reason: "Refund approved by Studafy",
        tenantContext: { schoolId, requestId: actor.requestId },
      });
      cancellation = "scheduled";
    } catch (error) {
      cancellation =
        error instanceof CodedHttpException &&
        error.code === ERROR_CODES.SUBSCRIPTION_ALREADY_CANCELED
          ? "already_scheduled"
          : "failed";
    }
  }

  const detail = await getPlatformRefundRequest(database, providers, schoolId, requestId);
  return { request: detail.request, cancellation };
}

/** Reject a `pending` request. The note is shown to the requester, so it is required. */
export async function rejectRefundRequest(
  database: Database,
  schoolId: string,
  requestId: string,
  note: string,
  actor: PlatformActor,
): Promise<PlatformRefundRequest> {
  return withSystemTx(database, async (tx) => {
    const name = await schoolName(tx, schoolId);
    await setTenantScope(tx, schoolId);
    const locked = await loadDetail(tx, requestId, true);
    if (locked.status !== "pending") throw invalidTransition();

    await tx`
      UPDATE app.subscription_refund_requests SET
        status = 'rejected',
        reviewed_by = ${actor.userId}::uuid,
        reviewed_at = CURRENT_TIMESTAMP,
        review_note = ${note.trim()},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${requestId}::uuid
    `;

    await auditPlatformChange(tx, schoolId, actor, {
      action: "update",
      targetTable: "subscription_refund_requests",
      targetId: requestId,
      oldValues: { status: locked.status },
      newValues: { status: "rejected", review_note: note.trim() },
    });

    return toPlatformRequest(await loadDetail(tx, requestId), name);
  });
}

function invalidTransition(): CodedHttpException {
  return new CodedHttpException(
    409,
    ERROR_CODES.SUBSCRIPTION_REFUND_INVALID_TRANSITION,
    "This refund request cannot move to that status from its current one",
  );
}
