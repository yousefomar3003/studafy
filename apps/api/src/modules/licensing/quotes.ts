import { ERROR_CODES } from "@studafy/constants";

import { auditLicenseChange, licenseError } from "./context";
import { activateLicenseFor, integerSetting, issueInvoice } from "./invoices";
import { priceQuote } from "./pricing";
import {
  AUDIENCES,
  createLicense,
  extendLicense,
  readLicense,
  transitionLicense,
  updateLicense,
} from "./service";

import type { LicenseActor } from "./context";
import type { InvoiceRecord } from "./invoices";
import type { PricedQuote, QuoteAudienceInput, QuoteKind, QuoteTerms } from "./pricing";
import type { Audience, Changed } from "./service";
import type { PricingResult } from "@studafy/license-pricing";
import type { JSONValue, TransactionSql } from "postgres";

/**
 * License quotes (session 3 of docs/billing/feature-licensing.md). The super admin prices a quote,
 * edits it while it is a draft, and sends it; the school sees sent quotes and accepts one, or the
 * super admin marks it accepted. Accepting applies the terms to the license -- creating it, setting
 * its terms, adding seats or extending it -- and issues the invoice, in one transaction.
 */

export const QUOTE_STATUSES = ["draft", "sent", "accepted", "expired", "withdrawn"] as const;
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
  createdBy: string;
  sentAt: string | null;
  acceptedAt: string | null;
  acceptedBy: string | null;
  acceptedByPlatform: boolean | null;
  closedAt: string | null;
  invoiceId: string | null;
  createdAt: string;
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
  created_by: string;
  sent_at: Date | null;
  accepted_at: Date | null;
  accepted_by: string | null;
  accepted_by_platform: boolean | null;
  closed_at: Date | null;
  invoice_id: string | null;
  created_at: Date;
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
  q.priced_at, q.valid_until, q.notes, q.created_by::text AS created_by, q.sent_at, q.accepted_at,
  q.accepted_by::text AS accepted_by, q.accepted_by_platform, q.closed_at,
  (SELECT i.id::text FROM app.license_invoices AS i
   WHERE i.school_id = q.school_id AND i.quote_id = q.id) AS invoice_id,
  q.created_at
`;

function toView(row: QuoteRow): QuoteView {
  const iso = (d: Date | null) => d?.toISOString() ?? null;
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
    createdBy: row.created_by,
    sentAt: iso(row.sent_at),
    acceptedAt: iso(row.accepted_at),
    acceptedBy: row.accepted_by,
    acceptedByPlatform: row.accepted_by_platform,
    closedAt: iso(row.closed_at),
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
    WHERE q.school_id = current_setting('app.school_id')::uuid AND q.id = ${quoteId}::uuid
    ${options.forUpdate ? tx`FOR UPDATE OF q` : tx``}
  `;
  return row ? toView(row) : null;
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
export const SCHOOL_VISIBLE: readonly QuoteStatus[] = ["sent", "accepted", "expired"];

/** The school's quotes, newest first. */
export async function listQuotes(
  tx: TransactionSql,
  statuses: readonly QuoteStatus[] = QUOTE_STATUSES,
): Promise<QuoteView[]> {
  const rows = await tx<QuoteRow[]>`
    SELECT ${QUOTE_COLUMNS(tx)}
    FROM app.license_quotes AS q
    JOIN app.currencies AS c ON c.id = q.currency_id
    WHERE q.school_id = current_setting('app.school_id')::uuid
      AND q.status = ANY(${statuses as QuoteStatus[]}::text[])
    ORDER BY q.created_at DESC, q.id
  `;
  return rows.map(toView);
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
  terms: QuoteTerms & { notes?: string | null },
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<QuoteView> {
  const priced = await priceQuote(tx, terms, actor, { now });
  const columns = pricedColumns(priced);
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.license_quotes (
      school_id, kind, license_id, currency_id, starts_at, ends_at, months, prorate_days,
      student_plan_id, student_seats, teacher_plan_id, teacher_seats, include_family_plus,
      parent_plan_id, parent_seats, adjustment_minor, adjustment_reason, list_total_minor,
      discount_total_minor, credit_total_minor, total_minor, breakdown, valid_until, notes,
      created_by
    ) VALUES (
      ${schoolId}::uuid, ${priced.kind}, ${priced.licenseId}::uuid, ${columns.currency_id}::uuid,
      ${columns.starts_at}, ${columns.ends_at}, ${columns.months}, ${columns.prorate_days},
      ${columns.student_plan_id}::uuid, ${columns.student_seats},
      ${columns.teacher_plan_id}::uuid, ${columns.teacher_seats}, ${columns.include_family_plus},
      ${columns.parent_plan_id}::uuid, ${columns.parent_seats}, ${columns.adjustment_minor},
      ${columns.adjustment_reason}, ${columns.list_total_minor}, ${columns.discount_total_minor},
      ${columns.credit_total_minor}, ${columns.total_minor},
      ${tx.json(priced.pricing as unknown as JSONValue)}, ${await validUntil(tx, now)},
      ${terms.notes?.trim() || null}, ${actor.userId}::uuid
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
  terms: Omit<QuoteTerms, "kind" | "licenseId"> & { notes?: string | null },
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

  const audience = (a: Audience) => quote.audiences.find((x) => x.audience === a)!;
  const audienceInputs = Object.fromEntries(
    AUDIENCES.map((a) => [a, { planId: audience(a).planId, seats: audience(a).seats }]),
  ) as Record<Audience, QuoteAudienceInput>;

  let licenseId: string;
  const versions = new Map<string, number>();
  const merge = (changed: { versions: Map<string, number> }) => {
    for (const [userId, version] of changed.versions) versions.set(userId, version);
  };

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
      : await createLicense(tx, schoolId, terms, actor);
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

  return {
    result: { quote: (await readQuote(tx, quoteId))!, invoice },
    versions,
    pending: activation.pending,
  };
}
