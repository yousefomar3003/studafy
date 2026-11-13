import { ERROR_CODES } from "@studafy/constants";
import {
  calculateLicensePrice,
  divideHalfUp,
  DAYS_PER_YEAR,
  MONTHS_PER_YEAR,
  PricingError,
  validatePriceSettings,
} from "@studafy/license-pricing";

import { setTenantScope } from "../../db/tenant-tx";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { licenseError } from "./context";
import { AUDIENCES, readLicense } from "./service";

import type { LicenseActor } from "./context";
import type { Audience, LicenseRecord } from "./service";
import type { AuditEntry } from "../../middleware/auditEmitter";
import type {
  CreditInput,
  DurationDiscount,
  PriceSettings,
  PricingResult,
  SeatInput,
  VolumeBasis,
  VolumeBracket,
} from "@studafy/license-pricing";
import type { TransactionSql } from "postgres";

/**
 * Pricing for school licenses (session 3 of docs/billing/feature-licensing.md): the super admin's
 * price settings per currency, and turning a quote's terms -- a new term, more seats, a later end
 * date -- into the calculator's input. The arithmetic itself is @studafy/license-pricing's.
 */

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------------

/** `date` plus whole months in UTC, keeping the day of the month where it exists (Jan 31 -> Feb 28). */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/** A term's length in whole months, to the nearest month (it picks the duration discount). */
export function termMonths(startsAt: Date, endsAt: Date): number {
  const months = Math.round((endsAt.getTime() - startsAt.getTime()) / (DAY_MS * (365.25 / 12)));
  return Math.min(120, Math.max(1, months));
}

/** Whole days from `from` to `to`, a part day counting as a day (as the overlap credit counts). */
export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.ceil((to.getTime() - from.getTime()) / DAY_MS));
}

// ---------------------------------------------------------------------------------------------------
// Price settings (global, super admin only)
// ---------------------------------------------------------------------------------------------------

export interface PriceSettingsView {
  currencyCode: string;
  volumeBasis: VolumeBasis;
  volumeBrackets: VolumeBracket[];
  durationDiscounts: DurationDiscount[];
  updatedAt: string | null;
}

interface BracketRow {
  currency_code: string;
  kind: "volume" | "duration";
  audience: Audience | null;
  threshold: number;
  discount_bps: number;
}

/** Every currency that has settings, with its brackets. */
export async function listPriceSettings(tx: TransactionSql): Promise<PriceSettingsView[]> {
  const settings = await tx<
    { currency_code: string; volume_basis: VolumeBasis; updated_at: Date }[]
  >`
    SELECT c.code AS currency_code, s.volume_basis, s.updated_at
    FROM app.license_price_settings AS s
    JOIN app.currencies AS c ON c.id = s.currency_id
    ORDER BY c.code
  `;
  const brackets = await tx<BracketRow[]>`
    SELECT c.code AS currency_code, b.kind, b.audience, b.threshold, b.discount_bps
    FROM app.license_price_brackets AS b
    JOIN app.currencies AS c ON c.id = b.currency_id
    ORDER BY c.code, b.kind, b.audience NULLS FIRST, b.threshold
  `;
  return settings.map((row) =>
    toView(row.currency_code, row.volume_basis, row.updated_at, brackets),
  );
}

function toView(
  currencyCode: string,
  volumeBasis: VolumeBasis,
  updatedAt: Date | null,
  brackets: readonly BracketRow[],
): PriceSettingsView {
  const own = brackets.filter((b) => b.currency_code === currencyCode);
  return {
    currencyCode,
    volumeBasis,
    volumeBrackets: own
      .filter((b) => b.kind === "volume")
      .map((b) => ({ audience: b.audience, minSeats: b.threshold, discountBps: b.discount_bps })),
    durationDiscounts: own
      .filter((b) => b.kind === "duration")
      .map((b) => ({ minMonths: b.threshold, discountBps: b.discount_bps })),
    updatedAt: updatedAt?.toISOString() ?? null,
  };
}

/** The settings a currency prices with: none saved means no discounts. */
export async function readPriceSettings(
  tx: TransactionSql,
  currencyCode: string,
): Promise<PriceSettingsView> {
  const [row] = await tx<{ volume_basis: VolumeBasis; updated_at: Date }[]>`
    SELECT s.volume_basis, s.updated_at
    FROM app.license_price_settings AS s
    JOIN app.currencies AS c ON c.id = s.currency_id
    WHERE c.code = ${currencyCode}
  `;
  const brackets = await tx<BracketRow[]>`
    SELECT c.code AS currency_code, b.kind, b.audience, b.threshold, b.discount_bps
    FROM app.license_price_brackets AS b
    JOIN app.currencies AS c ON c.id = b.currency_id
    WHERE c.code = ${currencyCode}
  `;
  return toView(
    currencyCode,
    row?.volume_basis ?? "per_audience",
    row?.updated_at ?? null,
    brackets,
  );
}

/**
 * Audit a change to a global table (price settings, bank details): one row in the operator's home
 * school, attributed to them. Leaves the transaction scoped to `restoreSchoolId` (or the home school)
 * with no actor GUC.
 */
export async function auditPlatformChange(
  tx: TransactionSql,
  actor: LicenseActor,
  entry: AuditEntry,
  restoreSchoolId?: string,
): Promise<void> {
  await setTenantScope(tx, actor.homeSchoolId, actor.requestId);
  await tx`SELECT set_config('app.user_id', ${actor.userId}, true)`;
  await emitAuditLog(tx, entry);
  await tx`SELECT set_config('app.user_id', '', true)`;
  if (restoreSchoolId) await setTenantScope(tx, restoreSchoolId, actor.requestId);
}

/** Replace a currency's settings and brackets. Refuses overlapping or out-of-range brackets. */
export async function replacePriceSettings(
  tx: TransactionSql,
  currencyCode: string,
  input: Omit<PriceSettings, "volumeBrackets" | "durationDiscounts"> & {
    volumeBrackets: VolumeBracket[];
    durationDiscounts: DurationDiscount[];
  },
  actor: LicenseActor,
): Promise<PriceSettingsView> {
  try {
    validatePriceSettings(input);
  } catch (err) {
    if (err instanceof PricingError) {
      throw licenseError(422, ERROR_CODES.LICENSE_PRICING_INVALID, actor.locale);
    }
    throw err;
  }
  const [currency] = await tx<{ id: string }[]>`
    SELECT id::text AS id FROM app.currencies WHERE code = ${currencyCode} AND is_active
  `;
  if (!currency) throw licenseError(422, ERROR_CODES.VALIDATION_FAILED, actor.locale);

  const before = await readPriceSettings(tx, currencyCode);
  const existed = before.updatedAt !== null;

  await tx`
    INSERT INTO app.license_price_settings (currency_id, volume_basis, updated_by)
    VALUES (${currency.id}::uuid, ${input.volumeBasis}, ${actor.userId}::uuid)
    ON CONFLICT (currency_id) DO UPDATE SET
      volume_basis = EXCLUDED.volume_basis,
      updated_by = EXCLUDED.updated_by,
      updated_at = GREATEST(CURRENT_TIMESTAMP, app.license_price_settings.updated_at)
  `;
  await tx`DELETE FROM app.license_price_brackets WHERE currency_id = ${currency.id}::uuid`;
  const rows = [
    ...input.volumeBrackets.map((b) => ({
      currency_id: currency.id,
      kind: "volume",
      audience: b.audience,
      threshold: b.minSeats,
      discount_bps: b.discountBps,
    })),
    ...input.durationDiscounts.map((d) => ({
      currency_id: currency.id,
      kind: "duration",
      audience: null,
      threshold: d.minMonths,
      discount_bps: d.discountBps,
    })),
  ];
  if (rows.length > 0) {
    await tx`
      INSERT INTO app.license_price_brackets ${tx(rows, "currency_id", "kind", "audience", "threshold", "discount_bps")}
    `;
  }

  const after = await readPriceSettings(tx, currencyCode);
  const snapshot = (view: PriceSettingsView) => ({
    currency_code: view.currencyCode,
    volume_basis: view.volumeBasis,
    volume_brackets: view.volumeBrackets,
    duration_discounts: view.durationDiscounts,
  });
  await auditPlatformChange(tx, actor, {
    action: existed ? "update" : "insert",
    targetTable: "license_price_settings",
    targetId: currency.id,
    ...(existed ? { oldValues: snapshot(before) } : {}),
    newValues: snapshot(after),
  });
  return after;
}

// ---------------------------------------------------------------------------------------------------
// Quote terms -> calculator input
// ---------------------------------------------------------------------------------------------------

export type QuoteKind = "new" | "seat_increase" | "extension";

export interface QuoteAudienceInput {
  planId: string | null;
  seats: number;
}

/**
 * What the super admin asks to price. `new`: a term from `startsAt` for `months` (for the license
 * `licenseId` names, if it is not yet in force). `seat_increase`: the license's new seat totals, charged
 * for the rest of its term. `extension`: `months` more at the license's seats.
 */
export interface QuoteTerms {
  kind: QuoteKind;
  licenseId?: string | null;
  currencyCode?: string;
  startsAt?: Date;
  months?: number;
  includeFamilyPlus?: boolean;
  student?: QuoteAudienceInput;
  teacher?: QuoteAudienceInput;
  parent?: QuoteAudienceInput;
  includeOverlapCredits?: boolean;
  adjustment?: { amountMinor: number; reason: string } | null;
}

/** The terms resolved against the license and the price list, ready to store and to apply. */
export interface PricedQuote {
  kind: QuoteKind;
  licenseId: string | null;
  currencyId: string;
  currencyCode: string;
  startsAt: Date;
  endsAt: Date;
  months: number;
  prorateDays: number | null;
  includeFamilyPlus: boolean;
  audiences: Record<Audience, QuoteAudienceInput>;
  adjustment: { amountMinor: number; reason: string } | null;
  overlapIds: string[];
  pricing: PricingResult;
}

interface PlanRow {
  id: string;
  code: string;
  display_name: string;
  audience: Audience | null;
  monthly_minor: string | null;
}

/** The tiers named, with their monthly seat price in the currency (NULL when unpriced). */
async function plansWithPrices(
  tx: TransactionSql,
  planIds: string[],
  currencyId: string,
): Promise<Map<string, PlanRow>> {
  if (planIds.length === 0) return new Map();
  const rows = await tx<PlanRow[]>`
    SELECT p.id::text AS id, p.code, p.display_name, p.audience,
           pp.amount_minor::text AS monthly_minor
    FROM app.plans AS p
    LEFT JOIN app.plan_prices AS pp
      ON pp.plan_id = p.id
     AND pp.currency_id = ${currencyId}::uuid
     AND pp.billing_interval = 'monthly'
     AND pp.is_active
    WHERE p.id = ANY(${planIds}::uuid[])
  `;
  return new Map(rows.map((row) => [row.id, row]));
}

interface OverlapCreditRow {
  id: string;
  license_id: string;
  audience: Audience;
  overlap_days: number;
  credit_minor: string | null;
  name: string;
}

/**
 * The school's overlap credits not yet on an invoice (a voided invoice gives its credits back), in
 * `currencyId`. A credit recorded without an amount -- its tier had no price then -- is priced now
 * the way session 2 prices one: days x monthly seat price x 12 / 365.
 */
export async function openOverlapCredits(
  tx: TransactionSql,
  currencyId: string,
): Promise<{ inputs: CreditInput[]; ids: string[] }> {
  const rows = await tx<OverlapCreditRow[]>`
    SELECT o.id::text AS id, o.license_id::text AS license_id, s.audience, o.overlap_days,
           o.credit_minor::text AS credit_minor,
           COALESCE(u.display_name, u.email) AS name
    FROM app.license_seat_overlaps AS o
    JOIN app.license_seats AS s ON s.id = o.seat_id AND s.school_id = o.school_id
    JOIN app.users AS u ON u.id = o.user_id AND u.school_id = o.school_id
    WHERE o.school_id = current_setting('app.school_id')::uuid
      AND o.currency_id = ${currencyId}::uuid
      AND o.overlap_days > 0
      AND NOT EXISTS (
        SELECT 1
        FROM app.license_invoice_lines AS line
        JOIN app.license_invoices AS inv
          ON inv.id = line.invoice_id AND inv.school_id = line.school_id
        WHERE line.school_id = o.school_id
          AND line.overlap_id = o.id
          AND inv.status <> 'void'
      )
    ORDER BY o.created_at, o.id
  `;

  // Unpriced credits: the seat's tier on its license, at today's monthly price.
  const unpriced = rows.filter((row) => row.credit_minor === null);
  const monthly = new Map<string, bigint>();
  for (const licenseId of new Set(unpriced.map((row) => row.license_id))) {
    const license = await readLicense(tx, licenseId);
    if (!license) continue;
    const planIds = AUDIENCES.map((a) => planIdOf(license, a)).filter((id): id is string =>
      Boolean(id),
    );
    const plans = await plansWithPrices(tx, planIds, currencyId);
    for (const audience of AUDIENCES) {
      const plan = plans.get(planIdOf(license, audience) ?? "");
      if (plan?.monthly_minor) monthly.set(`${licenseId}:${audience}`, BigInt(plan.monthly_minor));
    }
  }

  const inputs: CreditInput[] = [];
  const ids: string[] = [];
  for (const row of rows) {
    let amount: bigint | null = row.credit_minor === null ? null : BigInt(row.credit_minor);
    if (amount === null) {
      const price = monthly.get(`${row.license_id}:${row.audience}`);
      if (price === undefined) continue;
      amount = divideHalfUp(
        BigInt(row.overlap_days) * price * BigInt(MONTHS_PER_YEAR),
        BigInt(DAYS_PER_YEAR),
      );
    }
    if (amount <= 0n) continue;
    inputs.push({
      reference: row.id,
      description: `Overlap credit: ${row.name}, ${row.overlap_days} days`,
      amountMinor: Number(amount),
    });
    ids.push(row.id);
  }
  return { inputs, ids };
}

function planIdOf(license: LicenseRecord, audience: Audience): string | null {
  if (audience === "student") return license.studentPlanId;
  if (audience === "teacher") return license.teacherPlanId;
  return license.parentPlanId;
}

function seatsOf(license: LicenseRecord, audience: Audience): number {
  if (audience === "student") return license.studentSeats;
  if (audience === "teacher") return license.teacherSeats;
  return license.includeFamilyPlus ? license.parentSeats : 0;
}

async function currencyByCode(
  tx: TransactionSql,
  code: string,
  actor: LicenseActor,
): Promise<{ id: string; code: string }> {
  const [row] = await tx<{ id: string; code: string }[]>`
    SELECT id::text AS id, code FROM app.currencies WHERE code = ${code} AND is_active
  `;
  if (!row) throw licenseError(422, ERROR_CODES.VALIDATION_FAILED, actor.locale);
  return row;
}

/**
 * Price `terms` for the school the transaction is scoped to (or for no school, when `withCredits` is
 * false: the console's calculator before a school is chosen). Reads the license, the tiers' prices
 * and the open overlap credits; changes nothing.
 */
export async function priceQuote(
  tx: TransactionSql,
  terms: QuoteTerms,
  actor: LicenseActor,
  options: { now?: Date; withCredits?: boolean } = {},
): Promise<PricedQuote> {
  const now = options.now ?? new Date();
  const license = terms.licenseId ? await readLicense(tx, terms.licenseId) : null;
  if (terms.licenseId && !license) {
    throw licenseError(404, ERROR_CODES.LICENSE_NOT_FOUND, actor.locale);
  }
  if (terms.kind !== "new" && !license) {
    throw licenseError(422, ERROR_CODES.VALIDATION_FAILED, actor.locale);
  }

  let currency: { id: string; code: string };
  let startsAt: Date;
  let endsAt: Date;
  let months: number;
  let prorateDays: number | null = null;
  let includeFamilyPlus: boolean;
  const audiences = {} as Record<Audience, QuoteAudienceInput>;
  /** Seats charged and the seat count that picks the volume bracket, per audience. */
  const charged = {} as Record<Audience, { seats: number; volumeSeats: number }>;

  if (terms.kind === "new") {
    // A new term, or the terms of a license that is not yet in force.
    if (license && license.status !== "draft" && license.status !== "awaiting_payment") {
      throw licenseError(409, ERROR_CODES.LICENSE_NOT_EDITABLE, actor.locale);
    }
    if (!terms.months) throw licenseError(422, ERROR_CODES.VALIDATION_FAILED, actor.locale);
    currency = await currencyByCode(tx, terms.currencyCode ?? license?.currencyCode ?? "", actor);
    startsAt = terms.startsAt ?? license?.startsAt ?? now;
    months = terms.months;
    endsAt = addMonths(startsAt, months);
    includeFamilyPlus = terms.includeFamilyPlus ?? false;
    for (const audience of AUDIENCES) {
      const input = terms[audience] ?? { planId: null, seats: 0 };
      audiences[audience] = input;
      charged[audience] = { seats: input.seats, volumeSeats: input.seats };
    }
  } else if (terms.kind === "seat_increase") {
    // More seats on a license in force, for the rest of its term, discounted at the new totals.
    if (license!.status !== "active" && license!.status !== "suspended") {
      throw licenseError(409, ERROR_CODES.LICENSE_NOT_EDITABLE, actor.locale);
    }
    currency = { id: license!.currencyId, code: license!.currencyCode };
    startsAt = new Date(Math.max(now.getTime(), license!.startsAt.getTime()));
    endsAt = license!.endsAt;
    prorateDays = daysBetween(startsAt, endsAt);
    if (prorateDays < 1) throw licenseError(409, ERROR_CODES.LICENSE_NOT_EDITABLE, actor.locale);
    months = termMonths(license!.startsAt, license!.endsAt);
    includeFamilyPlus = terms.includeFamilyPlus ?? license!.includeFamilyPlus;
    for (const audience of AUDIENCES) {
      const current = seatsOf(license!, audience);
      const wanted = terms[audience]?.seats ?? current;
      // The tier stays the license's; an audience without one may be given its first.
      const planId = planIdOf(license!, audience) ?? terms[audience]?.planId ?? null;
      if (wanted < current) throw licenseError(422, ERROR_CODES.VALIDATION_FAILED, actor.locale);
      audiences[audience] = { planId, seats: wanted };
      charged[audience] = { seats: wanted - current, volumeSeats: wanted };
    }
  } else {
    // An extension: `months` more at the license's seats and tiers.
    if (license!.status !== "active" && license!.status !== "suspended") {
      throw licenseError(409, ERROR_CODES.LICENSE_NOT_EDITABLE, actor.locale);
    }
    if (!terms.months) throw licenseError(422, ERROR_CODES.VALIDATION_FAILED, actor.locale);
    currency = { id: license!.currencyId, code: license!.currencyCode };
    startsAt = license!.endsAt;
    months = terms.months;
    endsAt = addMonths(startsAt, months);
    includeFamilyPlus = license!.includeFamilyPlus;
    for (const audience of AUDIENCES) {
      const seats = seatsOf(license!, audience);
      audiences[audience] = { planId: planIdOf(license!, audience), seats };
      charged[audience] = { seats, volumeSeats: seats };
    }
  }

  if (!includeFamilyPlus && audiences.parent.seats > 0) {
    throw licenseError(422, ERROR_CODES.LICENSE_TIER_INVALID, actor.locale);
  }

  const planIds = AUDIENCES.map((a) => audiences[a].planId).filter((id): id is string =>
    Boolean(id),
  );
  const plans = await plansWithPrices(tx, planIds, currency.id);
  const seats: SeatInput[] = [];
  for (const audience of AUDIENCES) {
    const { planId, seats: total } = audiences[audience];
    if (total > 0 && !planId)
      throw licenseError(422, ERROR_CODES.LICENSE_TIER_INVALID, actor.locale);
    if (!planId) continue;
    const plan = plans.get(planId);
    if (!plan || plan.audience !== audience) {
      throw licenseError(422, ERROR_CODES.LICENSE_TIER_INVALID, actor.locale);
    }
    if (charged[audience].seats === 0 && charged[audience].volumeSeats === 0) continue;
    if (charged[audience].seats > 0 && plan.monthly_minor === null) {
      throw licenseError(422, ERROR_CODES.LICENSE_PRICE_MISSING, actor.locale);
    }
    seats.push({
      audience,
      tierCode: plan.code,
      tierName: plan.display_name,
      seats: charged[audience].seats,
      volumeSeats: charged[audience].volumeSeats,
      listPricePerSeatMonthMinor: Number(plan.monthly_minor ?? 0),
    });
  }

  const credits =
    options.withCredits !== false && terms.includeOverlapCredits !== false
      ? await openOverlapCredits(tx, currency.id)
      : { inputs: [], ids: [] };
  const settings = await readPriceSettings(tx, currency.code);
  const adjustment =
    terms.adjustment && terms.adjustment.amountMinor !== 0
      ? { amountMinor: terms.adjustment.amountMinor, reason: terms.adjustment.reason.trim() }
      : null;

  let pricing: PricingResult;
  try {
    pricing = calculateLicensePrice({
      currencyCode: currency.code,
      months,
      prorateDays,
      includeFamilyPlus,
      seats,
      settings,
      credits: credits.inputs,
      adjustment,
    });
  } catch (err) {
    if (err instanceof PricingError) {
      throw licenseError(422, ERROR_CODES.LICENSE_PRICING_INVALID, actor.locale);
    }
    throw err;
  }

  // Only the credits the calculator could apply are claimed by this quote.
  const applied = new Set(
    pricing.lines.flatMap((line) =>
      line.kind === "overlap_credit" && line.amountMinor < 0 ? [line.reference] : [],
    ),
  );

  return {
    kind: terms.kind,
    licenseId: license?.id ?? null,
    currencyId: currency.id,
    currencyCode: currency.code,
    startsAt,
    endsAt,
    months,
    prorateDays,
    includeFamilyPlus,
    audiences,
    adjustment,
    overlapIds: credits.ids.filter((id) => applied.has(id)),
    pricing,
  };
}
