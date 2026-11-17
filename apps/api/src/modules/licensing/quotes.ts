import { ERROR_CODES } from "@studafy/constants";
import {
  buildSchedule,
  customScheduleErrors,
  scheduleMonths,
  termsChanges,
  yearTotals,
} from "@studafy/license-pricing";

import { attachAiProgramme, currentAiProgrammeStamp } from "./ai-programme";
import { auditLicenseChange, licenseError } from "./context";
import { activateLicenseFor, integerSetting, issueInvoice, utcDate } from "./invoices";
import { priceQuote } from "./pricing";
import {
  AUDIENCES,
  createLicense,
  extendLicense,
  readLicense,
  transitionLicense,
  updateLicense,
} from "./service";

import type { AiProgrammeStamp } from "./ai-programme";
import type { LicenseActor } from "./context";
import type { InvoiceRecord } from "./invoices";
import type { PricedQuote, QuoteAudienceInput, QuoteKind, QuoteTerms } from "./pricing";
import type { Audience, Changed } from "./service";
import type {
  CustomInstalmentInput,
  LicenceYearTotal,
  PaymentPlan,
  PricingResult,
  ProposedInstalment,
  ScheduledInstalment,
  TermsChange,
} from "@studafy/license-pricing";
import type { JSONValue, TransactionSql } from "postgres";

/**
 * License quotes (session 3 of docs/billing/feature-licensing.md). The super admin prices a quote,
 * edits it while it is a draft, and sends it; the school sees sent quotes and accepts one, or the
 * super admin marks it accepted. Accepting applies the terms to the license -- creating it, setting
 * its terms, adding seats or extending it -- and issues the invoice, in one transaction.
 */

export const QUOTE_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "expired",
  "withdrawn",
  "declined",
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

const DAY_MS = 86_400_000;

export interface QuoteView {
  id: string;
  schoolId: string;
  kind: QuoteKind;
  licenseId: string | null;
  status: QuoteStatus;
  currencyCode: string;
  minorUnit: number;
  startsAt: string;
  endsAt: string;
  months: number;
  prorateDays: number | null;
  includeFamilyPlus: boolean;
  audiences: (QuoteAudienceInput & { audience: Audience })[];
  adjustmentMinor: number;
  adjustmentReason: string | null;
  listTotalMinor: number;
  discountTotalMinor: number;
  creditTotalMinor: number;
  totalMinor: number;
  breakdown: PricingResult;
  pricedAt: string;
  validUntil: string;
  notes: string | null;
  /** How the invoice is to be paid (000221). */
  paymentPlan: PaymentPlan;
  /** The super admin's instalments, for a custom plan; null otherwise. */
  paymentSchedule: CustomInstalmentInput[] | null;
  /**
   * The instalments the invoice would have if the quote were accepted today (the real ones are on the
   * invoice once it is).
   */
  schedulePreview: ScheduledInstalment[];
  /** What the school pays in each licence year, from the schedule preview. */
  yearTotals: LicenceYearTotal[];
  /** The school's request this quote answers (000233), and what it asked for. */
  changeRequestId: string | null;
  requestedTerms: RequestedTermsView | null;
  /** Where the quote departs from the school's choice; each needs `termsChangeReason`. */
  termsChanges: TermsChange[];
  termsChangeReason: string | null;
  createdBy: string;
  sentAt: string | null;
  acceptedAt: string | null;
  acceptedBy: string | null;
  acceptedByPlatform: boolean | null;
  closedAt: string | null;
  /** When the school declined it (000223), by whom, and its optional reason. */
  declinedAt: string | null;
  declinedBy: string | null;
  declineReason: string | null;
  invoiceId: string | null;
  createdAt: string;
}

/** The length, start and payment plan the school chose on its request. */
export interface RequestedTermsView {
  months: number | null;
  startsOn: string | null;
  paymentPlan: PaymentPlan | null;
  paymentProposal: ProposedInstalment[] | null;
}

interface QuoteRow {
  id: string;
  school_id: string;
  kind: QuoteKind;
  license_id: string | null;
  status: QuoteStatus;
  currency_code: string;
  minor_unit: number;
  starts_at: Date;
  ends_at: Date;
  months: number;
  prorate_days: number | null;
  include_family_plus: boolean;
  student_plan_id: string | null;
  student_seats: number;
  teacher_plan_id: string | null;
  teacher_seats: number;
  parent_plan_id: string | null;
  parent_seats: number;
  adjustment_minor: string;
  adjustment_reason: string | null;
  list_total_minor: string;
  discount_total_minor: string;
  credit_total_minor: string;
  total_minor: string;
  breakdown: PricingResult;
  priced_at: Date;
  valid_until: Date;
  notes: string | null;
  payment_plan: PaymentPlan;
  payment_schedule: CustomInstalmentInput[] | null;
  created_by: string;
  sent_at: Date | null;
  accepted_at: Date | null;
  accepted_by: string | null;
  accepted_by_platform: boolean | null;
  closed_at: Date | null;
  declined_at: Date | null;
  declined_by: string | null;
  decline_reason: string | null;
  invoice_id: string | null;
  created_at: Date;
  change_request_id: string | null;
  terms_change_reason: string | null;
  request_months: number | null;
  request_starts_on: string | null;
  request_payment_plan: PaymentPlan | null;
  request_payment_proposal: ProposedInstalment[] | null;
}

const QUOTE_COLUMNS = (tx: TransactionSql) => tx`
  q.id::text AS id, q.school_id::text AS school_id, q.kind, q.license_id::text AS license_id,
  q.status, c.code AS currency_code, c.minor_unit::int AS minor_unit, q.starts_at, q.ends_at,
  q.months, q.prorate_days, q.include_family_plus, q.student_plan_id::text AS student_plan_id,
  q.student_seats, q.teacher_plan_id::text AS teacher_plan_id, q.teacher_seats,
  q.parent_plan_id::text AS parent_plan_id, q.parent_seats,
  q.adjustment_minor::text AS adjustment_minor, q.adjustment_reason,
  q.list_total_minor::text AS list_total_minor, q.discount_total_minor::text AS discount_total_minor,
  q.credit_total_minor::text AS credit_total_minor, q.total_minor::text AS total_minor, q.breakdown,
  q.priced_at, q.valid_until, q.notes, q.payment_plan, q.payment_schedule,
  q.created_by::text AS created_by, q.sent_at, q.accepted_at,
  q.accepted_by::text AS accepted_by, q.accepted_by_platform, q.closed_at,
  q.declined_at, q.declined_by::text AS declined_by, q.decline_reason,
  (SELECT i.id::text FROM app.license_invoices AS i
   WHERE i.school_id = q.school_id AND i.quote_id = q.id) AS invoice_id,
  q.created_at, q.change_request_id::text AS change_request_id, q.terms_change_reason,
  r.months AS request_months, r.starts_on::text AS request_starts_on,
  r.payment_plan AS request_payment_plan, r.payment_proposal AS request_payment_proposal
`;

/** The quote's request, for what the school asked for. */
const REQUEST_JOIN = (tx: TransactionSql) => tx`
  LEFT JOIN app.license_change_requests AS r
    ON r.id = q.change_request_id AND r.school_id = q.school_id
`;

/** Where `offered` departs from the school's request; none without a request. */
export function changesFromRequest(
  requested: RequestedTermsView | null,
  offered: {
    kind: QuoteKind;
    months: number;
    startsAt: string;
    paymentPlan: PaymentPlan;
    paymentSchedule: readonly CustomInstalmentInput[] | null;
    totalMinor: number;
  },
): TermsChange[] {
  if (!requested) return [];
  return termsChanges(
    {
      months: requested.months,
      startDate: requested.startsOn,
      paymentPlan: requested.paymentPlan,
      proposal: requested.paymentProposal,
    },
    {
      // A seat increase runs to the licence's end: its length is not the school's to choose.
      months: offered.kind === "seat_increase" ? null : offered.months,
      startDate: offered.kind === "new" ? offered.startsAt : null,
      paymentPlan: offered.paymentPlan,
      custom: offered.paymentSchedule,
      totalMinor: offered.totalMinor,
    },
  );
}

/** What a quote preview needs from the settings: when an invoice paid at once falls due. */
interface PreviewContext {
  today: string;
  dueDays: number;
}

async function previewContext(tx: TransactionSql, now: Date = new Date()): Promise<PreviewContext> {
  return { today: utcDate(now), dueDays: await integerSetting(tx, "license.invoice_due_days", 30) };
}

/** The instalments an invoice for these terms would have, issued on `issueDate`. */
export function scheduleFor(
  terms: {
    totalMinor: number;
    months: number;
    /** Set for a seat increase: the schedule spreads over the months left, not the whole term. */
    prorateDays?: number | null;
    startsAt: string;
    paymentPlan: PaymentPlan;
    paymentSchedule: readonly CustomInstalmentInput[] | null;
  },
  issueDate: string,
  dueDays: number,
): ScheduledInstalment[] {
  const custom = terms.paymentPlan === "custom" ? (terms.paymentSchedule ?? []) : null;
  // A custom schedule that no longer adds up (only possible for a stale stored quote) previews as
  // paid at once rather than failing the read; accepting it is refused.
  const plan =
    custom && customScheduleErrors(terms.totalMinor, custom).length > 0
      ? "in_full"
      : terms.paymentPlan;
  return buildSchedule({
    plan,
    totalMinor: terms.totalMinor,
    months: scheduleMonths(terms.months, terms.prorateDays ?? null),
    startDate: terms.startsAt.slice(0, 10),
    issueDate,
    inFullDueDate: utcDate(new Date(Date.parse(issueDate) + dueDays * DAY_MS)),
    custom,
  });
}

function toView(row: QuoteRow, preview: PreviewContext): QuoteView {
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  const issueDate = row.accepted_at ? utcDate(row.accepted_at) : preview.today;
  const schedulePreview = scheduleFor(
    {
      totalMinor: Number(row.total_minor),
      months: row.months,
      prorateDays: row.prorate_days,
      startsAt: row.starts_at.toISOString(),
      paymentPlan: row.payment_plan,
      paymentSchedule: row.payment_schedule,
    },
    issueDate,
    preview.dueDays,
  );
  const requestedTerms: RequestedTermsView | null = row.change_request_id
    ? {
        months: row.request_months,
        startsOn: row.request_starts_on,
        paymentPlan: row.request_payment_plan,
        paymentProposal: row.request_payment_proposal,
      }
    : null;
  return {
    id: row.id,
    schoolId: row.school_id,
    kind: row.kind,
    licenseId: row.license_id,
    status: row.status,
    currencyCode: row.currency_code,
    minorUnit: row.minor_unit,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    months: row.months,
    prorateDays: row.prorate_days,
    includeFamilyPlus: row.include_family_plus,
    audiences: [
      { audience: "student", planId: row.student_plan_id, seats: row.student_seats },
      { audience: "teacher", planId: row.teacher_plan_id, seats: row.teacher_seats },
      { audience: "parent", planId: row.parent_plan_id, seats: row.parent_seats },
    ],
    adjustmentMinor: Number(row.adjustment_minor),
    adjustmentReason: row.adjustment_reason,
    listTotalMinor: Number(row.list_total_minor),
    discountTotalMinor: Number(row.discount_total_minor),
    creditTotalMinor: Number(row.credit_total_minor),
    totalMinor: Number(row.total_minor),
    breakdown: row.breakdown,
    pricedAt: row.priced_at.toISOString(),
    validUntil: row.valid_until.toISOString(),
    notes: row.notes,
    paymentPlan: row.payment_plan,
    paymentSchedule: row.payment_schedule,
    schedulePreview,
    yearTotals: yearTotals(
      schedulePreview,
      row.starts_at.toISOString(),
      scheduleMonths(row.months, row.prorate_days),
    ),
    changeRequestId: row.change_request_id,
    requestedTerms,
    termsChanges: changesFromRequest(requestedTerms, {
      kind: row.kind,
      months: row.months,
      startsAt: row.starts_at.toISOString(),
      paymentPlan: row.payment_plan,
      paymentSchedule: row.payment_schedule,
      totalMinor: Number(row.total_minor),
    }),
    termsChangeReason: row.terms_change_reason,
    createdBy: row.created_by,
    sentAt: iso(row.sent_at),
    acceptedAt: iso(row.accepted_at),
    acceptedBy: row.accepted_by,
    acceptedByPlatform: row.accepted_by_platform,
    closedAt: iso(row.closed_at),
    declinedAt: iso(row.declined_at),
    declinedBy: row.declined_by,
    declineReason: row.decline_reason,
    invoiceId: row.invoice_id,
    createdAt: row.created_at.toISOString(),
  };
}

export async function readQuote(
  tx: TransactionSql,
  quoteId: string,
  options: { forUpdate?: boolean } = {},
): Promise<QuoteView | null> {
  const [row] = await tx<QuoteRow[]>`
    SELECT ${QUOTE_COLUMNS(tx)}
    FROM app.license_quotes AS q
    JOIN app.currencies AS c ON c.id = q.currency_id
    ${REQUEST_JOIN(tx)}
    WHERE q.school_id = current_setting('app.school_id')::uuid AND q.id = ${quoteId}::uuid
    ${options.forUpdate ? tx`FOR UPDATE OF q` : tx``}
  `;
  return row ? toView(row, await previewContext(tx)) : null;
}

export async function requireQuote(
  tx: TransactionSql,
  quoteId: string,
  actor: LicenseActor,
  options: { forUpdate?: boolean; schoolVisible?: boolean } = {},
): Promise<QuoteView> {
  const quote = await readQuote(tx, quoteId, options);
  // The school never sees drafts or withdrawn quotes: they are the super admin's.
  if (!quote || (options.schoolVisible && !SCHOOL_VISIBLE.includes(quote.status))) {
    throw licenseError(404, ERROR_CODES.LICENSE_QUOTE_NOT_FOUND, actor.locale);
  }
  return quote;
}

/** The statuses a school sees. */
export const SCHOOL_VISIBLE: readonly QuoteStatus[] = ["sent", "accepted", "expired", "declined"];

/** The school's quotes, newest first. */
export async function listQuotes(
  tx: TransactionSql,
  statuses: readonly QuoteStatus[] = QUOTE_STATUSES,
): Promise<QuoteView[]> {
  const rows = await tx<QuoteRow[]>`
    SELECT ${QUOTE_COLUMNS(tx)}
    FROM app.license_quotes AS q
    JOIN app.currencies AS c ON c.id = q.currency_id
    ${REQUEST_JOIN(tx)}
    WHERE q.school_id = current_setting('app.school_id')::uuid
      AND q.status = ANY(${statuses as QuoteStatus[]}::text[])
    ORDER BY q.created_at DESC, q.id
  `;
  const preview = await previewContext(tx);
  return rows.map((row) => toView(row, preview));
}

function quoteSnapshot(quote: QuoteView): Record<string, unknown> {
  return {
    kind: quote.kind,
    license_id: quote.licenseId,
    status: quote.status,
    currency_code: quote.currencyCode,
    starts_at: quote.startsAt,
    ends_at: quote.endsAt,
    months: quote.months,
    prorate_days: quote.prorateDays,
    include_family_plus: quote.includeFamilyPlus,
    audiences: quote.audiences,
    adjustment_minor: quote.adjustmentMinor,
    adjustment_reason: quote.adjustmentReason,
    total_minor: quote.totalMinor,
    valid_until: quote.validUntil,
    notes: quote.notes,
    payment_plan: quote.paymentPlan,
    payment_schedule: quote.paymentSchedule,
    change_request_id: quote.changeRequestId,
    terms_change_reason: quote.termsChangeReason,
  };
}

export interface QuotePaymentTerms {
  /** Paid at once when omitted on create; unchanged when omitted on replace. */
  paymentPlan?: PaymentPlan;
  /** Required for, and only for, a custom plan. */
  paymentSchedule?: CustomInstalmentInput[] | null;
  /**
   * Why the quote's length, start or plan differs from the school's request (000233). Required when
   * it does (LICENSE_TERMS_CHANGE_REASON_REQUIRED); dropped when it does not. Unchanged when omitted
   * on replace.
   */
  termsChangeReason?: string | null;
}

/** What the school asked for on an open request of the armed school; null when there is none. */
export async function requestedTermsOf(
  tx: TransactionSql,
  requestId: string,
): Promise<RequestedTermsView | null> {
  const [row] = await tx<
    {
      months: number | null;
      starts_on: string | null;
      payment_plan: PaymentPlan | null;
      payment_proposal: ProposedInstalment[] | null;
    }[]
  >`
    SELECT months, starts_on::text AS starts_on, payment_plan, payment_proposal
    FROM app.license_change_requests
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${requestId}::uuid
      AND status = 'open'
  `;
  if (!row) return null;
  return {
    months: row.months,
    startsOn: row.starts_on,
    paymentPlan: row.payment_plan,
    paymentProposal: row.payment_proposal,
  };
}

/** The open request a new quote answers: 404 when it is not one. */
async function openRequestTerms(
  tx: TransactionSql,
  requestId: string,
  actor: LicenseActor,
): Promise<RequestedTermsView> {
  const terms = await requestedTermsOf(tx, requestId);
  if (!terms) throw licenseError(404, ERROR_CODES.LICENSE_NOT_FOUND, actor.locale);
  return terms;
}

/** The reason to store: required when the offer departs from the request, else none. */
function termsReason(
  changes: readonly TermsChange[],
  reason: string | null | undefined,
  actor: LicenseActor,
): string | null {
  if (changes.length === 0) return null;
  const trimmed = reason?.trim() || null;
  if (!trimmed) {
    throw licenseError(422, ERROR_CODES.LICENSE_TERMS_CHANGE_REASON_REQUIRED, actor.locale);
  }
  return trimmed.slice(0, 1000);
}

/**
 * The plan and schedule to store for a quote priced at `totalMinor`. A custom schedule must add up to
 * the total exactly, be in date order, have no date before today and at most MAX_CUSTOM_INSTALMENTS
 * instalments: LICENSE_PAYMENT_SCHEDULE_INVALID otherwise.
 */
function resolvePaymentPlan(
  requested: QuotePaymentTerms,
  fallback: { plan: PaymentPlan; schedule: CustomInstalmentInput[] | null },
  totalMinor: number,
  actor: LicenseActor,
  now: Date,
): { plan: PaymentPlan; schedule: CustomInstalmentInput[] | null } {
  const plan = requested.paymentPlan ?? fallback.plan;
  if (plan !== "custom") {
    if (requested.paymentSchedule) {
      throw licenseError(422, ERROR_CODES.LICENSE_PAYMENT_SCHEDULE_INVALID, actor.locale);
    }
    return { plan, schedule: null };
  }
  const schedule =
    requested.paymentSchedule ?? (requested.paymentPlan ? null : fallback.schedule) ?? null;
  const today = utcDate(now);
  if (
    !schedule ||
    customScheduleErrors(totalMinor, schedule).length > 0 ||
    schedule.some((instalment) => instalment.dueDate < today)
  ) {
    throw licenseError(422, ERROR_CODES.LICENSE_PAYMENT_SCHEDULE_INVALID, actor.locale);
  }
  return {
    plan,
    schedule: schedule.map((i) => ({ amountMinor: i.amountMinor, dueDate: i.dueDate })),
  };
}

async function validUntil(tx: TransactionSql, now: Date): Promise<Date> {
  const days = await integerSetting(tx, "license.quote_validity_days", 30);
  return new Date(now.getTime() + days * DAY_MS);
}

/** The priced columns, shared by create and replace. */
function pricedColumns(priced: PricedQuote) {
  const a = priced.audiences;
  return {
    currency_id: priced.currencyId,
    starts_at: priced.startsAt,
    ends_at: priced.endsAt,
    months: priced.months,
    prorate_days: priced.prorateDays,
    student_plan_id: a.student.planId,
    student_seats: a.student.seats,
    teacher_plan_id: a.teacher.planId,
    teacher_seats: a.teacher.seats,
    include_family_plus: priced.includeFamilyPlus,
    parent_plan_id: a.parent.planId,
    parent_seats: a.parent.seats,
    adjustment_minor: priced.adjustment?.amountMinor ?? 0,
    adjustment_reason: priced.adjustment?.reason ?? null,
    list_total_minor: priced.pricing.listTotalMinor,
    discount_total_minor: priced.pricing.discountTotalMinor,
    credit_total_minor: priced.pricing.creditTotalMinor,
    total_minor: priced.pricing.totalMinor,
  };
}

export async function createQuote(
  tx: TransactionSql,
  schoolId: string,
  terms: QuoteTerms &
    QuotePaymentTerms & { notes?: string | null; changeRequestId?: string | null },
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<QuoteView> {
  const requested = terms.changeRequestId
    ? await openRequestTerms(tx, terms.changeRequestId, actor)
    : null;
  const priced = await priceQuote(tx, terms, actor, { now });
  const columns = pricedColumns(priced);
  // The Student AI programme values in force now: the licence is signed with them on acceptance.
  const programme = await currentAiProgrammeStamp(tx);
  const payment = resolvePaymentPlan(
    terms,
    // Answering a request, the school's plan is the default.
    {
      plan:
        requested?.paymentPlan && requested.paymentPlan !== "custom"
          ? requested.paymentPlan
          : "in_full",
      schedule: null,
    },
    priced.pricing.totalMinor,
    actor,
    now,
  );
  const reason = termsReason(
    changesFromRequest(requested, {
      kind: priced.kind,
      months: priced.months,
      startsAt: priced.startsAt.toISOString(),
      paymentPlan: payment.plan,
      paymentSchedule: payment.schedule,
      totalMinor: priced.pricing.totalMinor,
    }),
    terms.termsChangeReason,
    actor,
  );
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.license_quotes (
      school_id, kind, license_id, currency_id, starts_at, ends_at, months, prorate_days,
      student_plan_id, student_seats, teacher_plan_id, teacher_seats, include_family_plus,
      parent_plan_id, parent_seats, adjustment_minor, adjustment_reason, list_total_minor,
      discount_total_minor, credit_total_minor, total_minor, breakdown, valid_until, notes,
      payment_plan, payment_schedule, created_by, change_request_id, terms_change_reason,
      ai_programme_version_id, ai_programme_override_id
    ) VALUES (
      ${schoolId}::uuid, ${priced.kind}, ${priced.licenseId}::uuid, ${columns.currency_id}::uuid,
      ${columns.starts_at}, ${columns.ends_at}, ${columns.months}, ${columns.prorate_days},
      ${columns.student_plan_id}::uuid, ${columns.student_seats},
      ${columns.teacher_plan_id}::uuid, ${columns.teacher_seats}, ${columns.include_family_plus},
      ${columns.parent_plan_id}::uuid, ${columns.parent_seats}, ${columns.adjustment_minor},
      ${columns.adjustment_reason}, ${columns.list_total_minor}, ${columns.discount_total_minor},
      ${columns.credit_total_minor}, ${columns.total_minor},
      ${tx.json(priced.pricing as unknown as JSONValue)}, ${await validUntil(tx, now)},
      ${terms.notes?.trim() || null}, ${payment.plan},
      ${payment.schedule ? tx.json(payment.schedule as unknown as JSONValue) : null},
      ${actor.userId}::uuid, ${terms.changeRequestId ?? null}::uuid, ${reason},
      ${programme.versionId}::uuid, ${programme.overrideId}::uuid
    )
    RETURNING id::text AS id
  `;
  const quote = (await readQuote(tx, row!.id))!;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "insert",
    targetTable: "license_quotes",
    targetId: quote.id,
    newValues: quoteSnapshot(quote),
  });
  return quote;
}

/** Re-price a draft with new terms. Its kind and license stay. */
export async function replaceQuote(
  tx: TransactionSql,
  schoolId: string,
  quoteId: string,
  terms: Omit<QuoteTerms, "kind" | "licenseId"> & QuotePaymentTerms & { notes?: string | null },
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<QuoteView> {
  const before = await requireQuote(tx, quoteId, actor, { forUpdate: true });
  if (before.status !== "draft") {
    throw licenseError(409, ERROR_CODES.LICENSE_QUOTE_NOT_EDITABLE, actor.locale);
  }
  const priced = await priceQuote(
    tx,
    { ...terms, kind: before.kind, licenseId: before.licenseId },
    actor,
    { now },
  );
  const c = pricedColumns(priced);
  const programme = await currentAiProgrammeStamp(tx);
  const payment = resolvePaymentPlan(
    terms,
    { plan: before.paymentPlan, schedule: before.paymentSchedule },
    priced.pricing.totalMinor,
    actor,
    now,
  );
  const reason = termsReason(
    changesFromRequest(before.requestedTerms, {
      kind: priced.kind,
      months: priced.months,
      startsAt: priced.startsAt.toISOString(),
      paymentPlan: payment.plan,
      paymentSchedule: payment.schedule,
      totalMinor: priced.pricing.totalMinor,
    }),
    terms.termsChangeReason !== undefined ? terms.termsChangeReason : before.termsChangeReason,
    actor,
  );
  await tx`
    UPDATE app.license_quotes SET
      currency_id = ${c.currency_id}::uuid, starts_at = ${c.starts_at}, ends_at = ${c.ends_at},
      months = ${c.months}, prorate_days = ${c.prorate_days},
      student_plan_id = ${c.student_plan_id}::uuid, student_seats = ${c.student_seats},
      teacher_plan_id = ${c.teacher_plan_id}::uuid, teacher_seats = ${c.teacher_seats},
      include_family_plus = ${c.include_family_plus},
      parent_plan_id = ${c.parent_plan_id}::uuid, parent_seats = ${c.parent_seats},
      adjustment_minor = ${c.adjustment_minor}, adjustment_reason = ${c.adjustment_reason},
      list_total_minor = ${c.list_total_minor}, discount_total_minor = ${c.discount_total_minor},
      credit_total_minor = ${c.credit_total_minor}, total_minor = ${c.total_minor},
      breakdown = ${tx.json(priced.pricing as unknown as JSONValue)},
      priced_at = CURRENT_TIMESTAMP,
      notes = ${terms.notes !== undefined ? terms.notes?.trim() || null : before.notes},
      payment_plan = ${payment.plan},
      payment_schedule = ${payment.schedule ? tx.json(payment.schedule as unknown as JSONValue) : null},
      terms_change_reason = ${reason},
      ai_programme_version_id = ${programme.versionId}::uuid,
      ai_programme_override_id = ${programme.overrideId}::uuid,
      updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${quoteId}::uuid
  `;
  const after = (await readQuote(tx, quoteId))!;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "license_quotes",
    targetId: quoteId,
    oldValues: quoteSnapshot(before),
    newValues: quoteSnapshot(after),
  });
  return after;
}

/** Send a draft to the school. It is valid for the configured days from now. */
export async function sendQuote(
  tx: TransactionSql,
  schoolId: string,
  quoteId: string,
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<QuoteView> {
  const before = await requireQuote(tx, quoteId, actor, { forUpdate: true });
  if (before.status !== "draft") {
    throw licenseError(409, ERROR_CODES.LICENSE_QUOTE_NOT_EDITABLE, actor.locale);
  }
  const until = await validUntil(tx, now);
  await tx`
    UPDATE app.license_quotes
    SET status = 'sent', sent_at = ${now}, valid_until = ${until},
        updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${quoteId}::uuid
  `;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "license_quotes",
    targetId: quoteId,
    oldValues: { status: before.status, valid_until: before.validUntil },
    newValues: { status: "sent", valid_until: until.toISOString() },
  });
  return (await readQuote(tx, quoteId))!;
}

/** Take back a draft or sent quote. */
export async function withdrawQuote(
  tx: TransactionSql,
  schoolId: string,
  quoteId: string,
  actor: LicenseActor,
): Promise<QuoteView> {
  const before = await requireQuote(tx, quoteId, actor, { forUpdate: true });
  if (before.status !== "draft" && before.status !== "sent") {
    throw licenseError(409, ERROR_CODES.LICENSE_QUOTE_NOT_EDITABLE, actor.locale);
  }
  await tx`
    UPDATE app.license_quotes
    SET status = 'withdrawn', closed_at = CURRENT_TIMESTAMP,
        updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${quoteId}::uuid
  `;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "license_quotes",
    targetId: quoteId,
    oldValues: { status: before.status },
    newValues: { status: "withdrawn" },
  });
  return (await readQuote(tx, quoteId))!;
}

/**
 * The school declines a sent quote, optionally saying why (000223). It is closed like an expired or
 * withdrawn quote: it can no longer be accepted and the super admin prices a new one. Overlap credits
 * are claimed by invoices, not quotes, so nothing is released here. Refused for anything but a sent
 * quote still within its validity.
 */
export async function declineQuote(
  tx: TransactionSql,
  schoolId: string,
  quoteId: string,
  actor: LicenseActor,
  reason: string | null,
  now: Date = new Date(),
): Promise<QuoteView> {
  const before = await requireQuote(tx, quoteId, actor, { forUpdate: true, schoolVisible: true });
  if (before.status !== "sent") {
    throw licenseError(409, ERROR_CODES.LICENSE_QUOTE_NOT_EDITABLE, actor.locale);
  }
  if (new Date(before.validUntil).getTime() < now.getTime()) {
    throw licenseError(409, ERROR_CODES.LICENSE_QUOTE_EXPIRED, actor.locale);
  }
  const trimmed = reason?.trim() || null;
  await tx`
    UPDATE app.license_quotes
    SET status = 'declined', closed_at = ${now}, declined_at = ${now},
        declined_by = ${actor.userId}::uuid, decline_reason = ${trimmed},
        updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${quoteId}::uuid
  `;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "license_quotes",
    targetId: quoteId,
    oldValues: { status: before.status },
    newValues: { status: "declined", decline_reason: trimmed },
  });
  return (await readQuote(tx, quoteId))!;
}

/**
 * The overlap credits a quote claims must still be unclaimed when it is accepted: locked, so two
 * acceptances claiming the same credit serialize and the second is refused as stale.
 */
async function assertCreditsOpen(
  tx: TransactionSql,
  overlapIds: string[],
  actor: LicenseActor,
): Promise<void> {
  if (overlapIds.length === 0) return;
  const locked = await tx<{ id: string }[]>`
    SELECT id::text AS id FROM app.license_seat_overlaps
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ANY(${overlapIds}::uuid[])
    FOR UPDATE
  `;
  const [claimed] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM app.license_invoice_lines AS line
    JOIN app.license_invoices AS inv ON inv.id = line.invoice_id AND inv.school_id = line.school_id
    WHERE line.school_id = current_setting('app.school_id')::uuid
      AND line.overlap_id = ANY(${overlapIds}::uuid[])
      AND inv.status <> 'void'
  `;
  if (locked.length !== overlapIds.length || (claimed?.count ?? 0) > 0) {
    throw licenseError(409, ERROR_CODES.LICENSE_QUOTE_STALE, actor.locale);
  }
}

/** The programme versions a quote was priced with; null for one priced before 000234. */
async function quoteAiProgrammeStamp(
  tx: TransactionSql,
  quoteId: string,
): Promise<AiProgrammeStamp | null> {
  const [row] = await tx<{ version_id: string | null; override_id: string | null }[]>`
    SELECT ai_programme_version_id::text AS version_id,
           ai_programme_override_id::text AS override_id
    FROM app.license_quotes
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${quoteId}::uuid
  `;
  return row?.version_id ? { versionId: row.version_id, overrideId: row.override_id } : null;
}

export interface AcceptedQuote {
  quote: QuoteView;
  invoice: InvoiceRecord;
}

/**
 * Accept a quote: apply its terms to the license and issue its invoice. The school accepts a sent
 * quote; the super admin may also accept a draft on the school's behalf. Refused when the quote has
 * expired, or when the license changed after it was priced or its credits were claimed since
 * (LICENSE_QUOTE_STALE: price a new one).
 */
export async function acceptQuote(
  tx: TransactionSql,
  schoolId: string,
  quoteId: string,
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<Changed<AcceptedQuote>> {
  const quote = await requireQuote(tx, quoteId, actor, {
    forUpdate: true,
    schoolVisible: actor.kind === "school",
  });
  const acceptable = actor.kind === "school" ? ["sent"] : ["draft", "sent"];
  if (!acceptable.includes(quote.status)) {
    throw licenseError(409, ERROR_CODES.LICENSE_QUOTE_NOT_EDITABLE, actor.locale);
  }
  if (new Date(quote.validUntil).getTime() < now.getTime()) {
    throw licenseError(409, ERROR_CODES.LICENSE_QUOTE_EXPIRED, actor.locale);
  }

  const before = quote.licenseId
    ? await readLicense(tx, quote.licenseId, { forUpdate: true })
    : null;
  if (before && before.updatedAt.getTime() > new Date(quote.pricedAt).getTime()) {
    throw licenseError(409, ERROR_CODES.LICENSE_QUOTE_STALE, actor.locale);
  }
  const lines = quote.breakdown.lines;
  const overlapIds = lines.flatMap((line) =>
    line.kind === "overlap_credit" && line.amountMinor < 0 ? [line.reference] : [],
  );
  await assertCreditsOpen(tx, overlapIds, actor);
  if (
    quote.paymentPlan === "custom" &&
    customScheduleErrors(quote.totalMinor, quote.paymentSchedule ?? []).length > 0
  ) {
    throw licenseError(422, ERROR_CODES.LICENSE_PAYMENT_SCHEDULE_INVALID, actor.locale);
  }

  const audience = (a: Audience) => quote.audiences.find((x) => x.audience === a)!;
  const audienceInputs = Object.fromEntries(
    AUDIENCES.map((a) => [a, { planId: audience(a).planId, seats: audience(a).seats }]),
  ) as Record<Audience, QuoteAudienceInput>;

  let licenseId: string;
  const versions = new Map<string, number>();
  const merge = (changed: { versions: Map<string, number> }) => {
    for (const [userId, version] of changed.versions) versions.set(userId, version);
  };

  // The programme values the quote was priced with (the current ones for a quote priced before
  // 000234): a new licence and an extension -- a renewal -- are signed with them; a seat increase
  // keeps the licence's own.
  const programme =
    (await quoteAiProgrammeStamp(tx, quote.id)) ?? (await currentAiProgrammeStamp(tx));

  if (quote.kind === "new") {
    const terms = {
      startsAt: new Date(quote.startsAt),
      endsAt: new Date(quote.endsAt),
      currencyCode: quote.currencyCode,
      includeFamilyPlus: quote.includeFamilyPlus,
      ...audienceInputs,
    };
    const license = before
      ? (merge(await updateLicense(tx, schoolId, before.id, terms, actor)),
        (await readLicense(tx, before.id))!)
      : await createLicense(tx, schoolId, terms, actor, programme);
    if (before) await attachAiProgramme(tx, license, programme);
    licenseId = license.id;
    if (license.status === "draft") {
      merge(await transitionLicense(tx, schoolId, license.id, "awaiting_payment", actor, now));
    }
  } else if (quote.kind === "seat_increase") {
    licenseId = before!.id;
    merge(
      await updateLicense(
        tx,
        schoolId,
        licenseId,
        { includeFamilyPlus: quote.includeFamilyPlus, ...audienceInputs },
        actor,
      ),
    );
  } else {
    licenseId = before!.id;
    merge(await extendLicense(tx, schoolId, licenseId, new Date(quote.endsAt), actor));
    await attachAiProgramme(tx, before!, programme);
  }

  const invoice = await issueInvoice(
    tx,
    schoolId,
    {
      licenseId,
      quoteId: quote.id,
      currencyId: (await readLicense(tx, licenseId))!.currencyId,
      lines,
      planIds: Object.fromEntries(AUDIENCES.map((a) => [a, audience(a).planId])),
      schedule: {
        plan: quote.paymentPlan,
        months: scheduleMonths(quote.months, quote.prorateDays),
        startDate: quote.startsAt.slice(0, 10),
        custom: quote.paymentSchedule,
      },
    },
    actor,
    now,
  );
  // Fully covered by credits: nothing to pay, so it is in force now.
  const activation =
    invoice.status === "paid"
      ? await activateLicenseFor(tx, schoolId, invoice, actor, now)
      : { versions: new Map<string, number>(), pending: [] };
  merge(activation);

  await tx`
    UPDATE app.license_quotes
    SET status = 'accepted', license_id = ${licenseId}::uuid, accepted_at = CURRENT_TIMESTAMP,
        -- A draft the super admin accepts on the school's behalf counts as sent at acceptance.
        sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP),
        accepted_by = ${actor.userId}::uuid, accepted_by_platform = ${actor.kind === "platform"},
        updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${quoteId}::uuid
  `;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "license_quotes",
    targetId: quoteId,
    oldValues: { status: quote.status, license_id: quote.licenseId },
    newValues: { status: "accepted", license_id: licenseId, invoice_id: invoice.id },
  });
  // The request this quote answered is done.
  if (quote.changeRequestId) {
    const resolved = await tx<{ id: string }[]>`
      UPDATE app.license_change_requests
      SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, resolved_by = ${actor.userId}::uuid,
          updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
      WHERE school_id = current_setting('app.school_id')::uuid
        AND id = ${quote.changeRequestId}::uuid AND status = 'open'
      RETURNING id::text AS id
    `;
    if (resolved.length > 0) {
      await auditLicenseChange(tx, schoolId, actor, {
        action: "update",
        targetTable: "license_change_requests",
        targetId: quote.changeRequestId,
        oldValues: { status: "open" },
        newValues: { status: "resolved", quote_id: quoteId },
      });
    }
  }

  return {
    result: { quote: (await readQuote(tx, quoteId))!, invoice },
    versions,
    pending: activation.pending,
  };
}
