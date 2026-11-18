import { licenceInProgramme, measurementPeriods, periodFor, utcDay } from "@studafy/billing";
import {
  academicYearMonths,
  computeRevenueShare,
  contentBonusAimBps,
  conversionStanding,
  measurementDateOf,
  monthCount,
  paidPartOf,
  studafyNetOf,
  studentAiMarginOf,
  tierFor,
} from "@studafy/license-pricing";

import { setTenantScope, withSystemTx } from "../../db/tenant-tx";

import {
  currentAiProgrammeStamp,
  resolveAiProgrammeValues,
  schoolCurrencyCode,
} from "./ai-programme";
import { consoleSchools } from "./invoices";
import { listRevenueShareEntries, revenueShareTotals } from "./revenue-share";
import { revenueShareMeasures } from "./revenue-share-context";
import { currentLicense } from "./service";
import { currentUploadPeriod, uploadConsistency } from "./upload-consistency";

import type { LicenseActor } from "./context";
import type { RevenueShareEntryView, RevenueShareTotals } from "./revenue-share";
import type { LicenseRecord, LicenseStatus } from "./service";
import type { Database, DatabasePools } from "../../db/client";
import type {
  AiProgrammeTier,
  LicenseCommitment,
  ResolvedAiProgramme,
} from "@studafy/license-pricing";
import type { TransactionSql } from "postgres";

/**
 * The Student AI programme's dashboards (phase 6 of AI-REVSHARE-PLAN, docs/billing/ai-programme.md
 * "Dashboards"): one read of a school's standing -- enrolled and opted in, the conversion in force
 * and its tier, what the next tier takes, upload consistency and the bonus, the revenue share, the
 * school's earnings for the year, and what it owes and paid Studafy -- for the school's leadership
 * and finance (aggregates only: no student, parent or teacher is named here) and the super admin's
 * console, which adds what Studafy keeps.
 *
 * It runs as the system role armed for the one school (`readSchoolAsSystem` for a school user, the
 * console's own system transaction for a super admin): tenant isolation still binds every statement
 * to that school, and the route's permission decides who may ask. The opt-ins and the tuition lines
 * are leadership-only under the runtime role's row policies, which would make finance's counts
 * wrong; the counts here are what the revenue share engine itself measures.
 *
 * Values come from the core resolver `resolveAiProgrammeValues` (never the platform-only resolver,
 * which crosses into the super admins' school for names).
 *
 * ## The school's earnings (what "earnings" counts)
 *
 *   * Revenue share earned: the share entries of the academic year (their period starts in it) that
 *     are final -- owed, credited on an invoice, due to be paid out, or paid out. Pending shares are
 *     shown apart (not yet final); forfeited ones are not earnings.
 *   * Margin on the Student AI line: per opted-in student, (the parent's monthly price, fixed on the
 *     line) - (the licence's price per seat per month, from the values the licence was signed with)
 *     x months. Only knowable from the tuition lines Studafy billed: for a line billed on the fee
 *     schedule ("auto"), the months on ERPNext invoices, counted as far as the parent paid the
 *     invoice (pro rata for a part-paid one). A line the school bills itself ("outside", auto-billing
 *     off) is ESTIMATED: its months charged, as if parents pay it in full.
 *   * Total = share earned + margin collected + margin estimated.
 */

// ---------------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------------

export interface DashboardLicence {
  id: string;
  status: LicenseStatus;
  commitment: LicenseCommitment;
  startsOn: string;
  /** The licence's last day. */
  endsOn: string;
  studentSeats: number;
  currencyCode: string;
  minorUnit: number;
  inProgramme: boolean;
}

export interface DashboardYear {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  /** Months under the one month rule (`academicYearMonths`). */
  months: number;
}

export interface DashboardValues {
  licensePriceMinor: number | null;
  parentPriceMinor: number | null;
  maxShareBps: number;
  conversionTiers: AiProgrammeTier[];
  contentBonusTiers: AiProgrammeTier[];
  largeSchoolMinSeats: number;
  largeSchoolShareBps: number;
  bonusRequiresConversionShare: boolean;
  monthToMonthShareBps: number;
  measurementOffsetDays: number;
  payoutMode: "invoice_credit" | "payout";
}

export interface DashboardConversion {
  periodStart: string;
  measureOn: string;
  /** locked: measured and locked on the measurement day; provisional: a super admin's re-measure
   * before it; live: today's counts (not measured yet). */
  source: "locked" | "provisional" | "live";
  enrolled: number;
  optedIn: number;
  conversionBps: number;
  seats: number;
  tierFromBps: number | null;
  shareBps: number;
  floorApplied: boolean;
}

export interface DashboardUploads {
  from: string;
  to: string;
  schoolDays: number;
  classesCounted: number;
  consistencyBps: number | null;
  /** The bonus tier the consistency falls in (its threshold and bonus). */
  tierFromBps: number | null;
  tierBonusBps: number;
  /** What teachers should aim for: the next paying tier, or the top one once there. */
  aimBps: number | null;
}

export interface DashboardRate {
  conversionShareBps: number;
  bonusBps: number;
  capped: boolean;
  multiplierBps: number;
  totalBps: number;
}

export interface DashboardShare {
  /** The Student AI part of what Studafy collected, on the year's shares that are not void. */
  collectedMinor: number;
  earnedMinor: number;
  pendingMinor: number;
  owedMinor: number;
  creditedMinor: number;
  payoutDueMinor: number;
  paidOutMinor: number;
  forfeitedMinor: number;
}

export type MarginBasis = "collected" | "estimated" | "mixed" | "none";

export interface DashboardMargin {
  basis: MarginBasis;
  /** The school's auto-billing setting today. */
  autoBilling: boolean;
  /** Parent price - licence price per student per month, at today's values; null when unknown. */
  perStudentMonthMinor: number | null;
  /** Tuition lines (opted-in students) of the year, in the licence's currency. */
  lines: number;
  /** Months on ERPNext invoices (lines billed through Studafy). */
  billedMinor: number;
  /** Of those, the part parents paid. */
  collectedMinor: number;
  /** Lines the school bills itself: their months charged, as if paid in full. */
  estimatedMinor: number;
  /** Every line's months charged: what the year's margin comes to once everything is paid. */
  expectedMinor: number;
}

export interface DashboardEarnings {
  share: DashboardShare;
  margin: DashboardMargin;
  /** share earned + margin collected + margin estimated. */
  totalMinor: number;
  /** True when part of the total is an estimate (lines billed outside Studafy). */
  estimated: boolean;
}

export interface DashboardStudafy {
  /** The licence's invoices that are not void: their totals, paid, and open balance. */
  invoicedMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  overdueMinor: number;
  /** Revenue share credits taken off the licence's invoices. */
  sharesCreditedMinor: number;
}

export interface AiProgrammeDashboard {
  schoolId: string;
  today: string;
  license: DashboardLicence | null;
  academicYear: DashboardYear | null;
  currencyCode: string;
  minorUnit: number;
  values: DashboardValues;
  /** Today's counts: students enrolled and opted in for the year. */
  students: { enrolled: number; optedIn: number; conversionBps: number };
  /** The conversion the share uses: the locked measurement, else a provisional one, else today's. */
  conversion: DashboardConversion | null;
  /** The next conversion tier that pays more, and the opt-ins it takes (from today's counts). */
  nextTier: { fromBps: number; shareBps: number; optInsNeeded: number } | null;
  /** The large-school floor, when it pays more and the licence is below its seats. */
  largeSchoolFloor: { minSeats: number; shareBps: number; seatsNeeded: number } | null;
  uploads: DashboardUploads | null;
  /** The share a payment for the period to date would get. */
  rate: DashboardRate | null;
  /** The whole ledger's totals in the licence's currency (every year). */
  ledger: RevenueShareTotals | null;
  earnings: DashboardEarnings;
  studafy: DashboardStudafy | null;
}

// ---------------------------------------------------------------------------------------------------
// Reading it
// ---------------------------------------------------------------------------------------------------

/**
 * A read in a system transaction armed for the school, with the acting user on the audit trail's
 * GUC: for a school user's aggregate read (the route decides who may ask).
 */
export function readSchoolAsSystem<T>(
  database: Database | DatabasePools,
  actor: LicenseActor,
  read: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return withSystemTx(database, async (tx) => {
    await setTenantScope(tx, actor.homeSchoolId, actor.requestId);
    await tx`SELECT set_config('app.user_id', ${actor.userId}, true)`;
    return read(tx);
  });
}

/** The day before an exclusive end instant, as YYYY-MM-DD (UTC). */
function lastDayOf(endsAt: Date): string {
  return utcDay(new Date(endsAt.getTime() - 1));
}

async function minorUnitOf(tx: TransactionSql, currencyCode: string): Promise<number> {
  const [row] = await tx<{ minor_unit: number }[]>`
    SELECT minor_unit::int AS minor_unit FROM app.currencies WHERE code = ${currencyCode}
  `;
  return row?.minor_unit ?? 2;
}

/** The academic year covering `day`, else the next to start, else the latest. */
async function dashboardYear(tx: TransactionSql, day: string): Promise<DashboardYear | null> {
  const [row] = await tx<{ id: string; name: string; starts_on: string; ends_on: string }[]>`
    SELECT id::text AS id, name, starts_on::text AS starts_on, ends_on::text AS ends_on
    FROM app.academic_years
    WHERE school_id = current_setting('app.school_id')::uuid
    ORDER BY (starts_on <= ${day}::date AND ends_on >= ${day}::date) DESC,
             (starts_on > ${day}::date) DESC,
             CASE WHEN starts_on > ${day}::date THEN starts_on END ASC,
             ends_on DESC
    LIMIT 1
  `;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    months: monthCount(academicYearMonths(row.starts_on, row.ends_on)),
  };
}

async function dashboardConversion(
  tx: TransactionSql,
  license: LicenseRecord,
  values: ResolvedAiProgramme,
  live: { enrolled: number; optedIn: number },
  today: string,
): Promise<DashboardConversion> {
  const periods = await measurementPeriods(tx, license.id);
  const periodStart = periodFor(periods, today);
  const [snapshot] = await tx<
    {
      enrolled_count: number;
      opted_in_count: number;
      conversion_bps: number;
      seats: number;
      conversion_share_bps: number;
      floor_applied: boolean;
      locked: boolean;
    }[]
  >`
    SELECT enrolled_count, opted_in_count, conversion_bps, seats, conversion_share_bps,
           floor_applied, locked
    FROM app.ai_programme_conversion_snapshots
    WHERE school_id = current_setting('app.school_id')::uuid
      AND license_id = ${license.id}::uuid AND period_start = ${periodStart}::date
    ORDER BY locked DESC, measured_at DESC
    LIMIT 1
  `;
  const measureOn = measurementDateOf(periodStart, values.measurementOffsetDays);
  if (snapshot) {
    return {
      periodStart,
      measureOn,
      source: snapshot.locked ? "locked" : "provisional",
      enrolled: snapshot.enrolled_count,
      optedIn: snapshot.opted_in_count,
      conversionBps: snapshot.conversion_bps,
      seats: snapshot.seats,
      tierFromBps: tierFor(values.conversionTiers, snapshot.conversion_bps)?.fromBps ?? null,
      shareBps: snapshot.conversion_share_bps,
      floorApplied: snapshot.floor_applied,
    };
  }
  const standing = conversionStanding(values, { ...live, seats: license.studentSeats });
  return {
    periodStart,
    measureOn,
    source: "live",
    enrolled: live.enrolled,
    optedIn: live.optedIn,
    conversionBps: standing.conversionBps,
    seats: license.studentSeats,
    tierFromBps: standing.tier?.fromBps ?? null,
    shareBps: standing.shareBps,
    floorApplied: standing.floorApplied,
  };
}

async function dashboardUploads(
  tx: TransactionSql,
  license: LicenseRecord | null,
  values: ResolvedAiProgramme,
): Promise<DashboardUploads> {
  const period = await currentUploadPeriod(tx, license);
  const report = await uploadConsistency(tx, period);
  const tier =
    report.consistencyBps === null
      ? null
      : tierFor(values.contentBonusTiers, report.consistencyBps);
  return {
    from: report.from,
    to: report.countedTo,
    schoolDays: report.schoolDays,
    classesCounted: report.classesCounted,
    consistencyBps: report.consistencyBps,
    tierFromBps: tier?.fromBps ?? null,
    tierBonusBps: tier?.shareBps ?? 0,
    aimBps: contentBonusAimBps(values.contentBonusTiers, report.consistencyBps),
  };
}

const EMPTY_SHARE: DashboardShare = {
  collectedMinor: 0,
  earnedMinor: 0,
  pendingMinor: 0,
  owedMinor: 0,
  creditedMinor: 0,
  payoutDueMinor: 0,
  paidOutMinor: 0,
  forfeitedMinor: 0,
};

function yearShare(
  entries: readonly RevenueShareEntryView[],
  currencyCode: string,
  year: DashboardYear | null,
  licenseId: string | null,
): DashboardShare {
  const inScope = entries.filter(
    (entry) =>
      entry.currencyCode === currencyCode &&
      (year
        ? entry.periodFrom >= year.startsOn && entry.periodFrom <= year.endsOn
        : entry.licenseId === licenseId),
  );
  const totals = revenueShareTotals(inScope)[0];
  if (!totals) return { ...EMPTY_SHARE };
  return {
    collectedMinor: totals.baseMinor,
    earnedMinor: totals.earnedMinor,
    pendingMinor: totals.pendingMinor,
    owedMinor: totals.owedMinor,
    creditedMinor: totals.creditedMinor,
    payoutDueMinor: totals.payoutDueMinor,
    paidOutMinor: totals.paidOutMinor,
    forfeitedMinor: totals.forfeitedMinor,
  };
}

/** The school's margin on the year's Student AI lines (see the module comment). */
async function yearMargin(
  tx: TransactionSql,
  year: DashboardYear | null,
  currencyCode: string,
  todayValues: ResolvedAiProgramme,
): Promise<DashboardMargin> {
  const [settings] = await tx<{ auto_billing: boolean }[]>`
    SELECT auto_billing FROM app.student_ai_billing_settings
    WHERE school_id = current_setting('app.school_id')::uuid
  `;
  const autoBilling = settings?.auto_billing ?? true;
  const perStudentMonthMinor =
    todayValues.licensePriceMinor !== null && todayValues.parentPriceMinor !== null
      ? todayValues.parentPriceMinor - todayValues.licensePriceMinor
      : null;
  const margin: DashboardMargin = {
    basis: "none",
    autoBilling,
    perStudentMonthMinor,
    lines: 0,
    billedMinor: 0,
    collectedMinor: 0,
    estimatedMinor: 0,
    expectedMinor: 0,
  };
  if (!year) return margin;

  const items = await tx<
    {
      id: string;
      license_id: string;
      version_id: string;
      override_id: string | null;
      monthly_price_minor: string;
      months: number;
      billing: "auto" | "outside";
    }[]
  >`
    SELECT i.id::text AS id, i.license_id::text AS license_id,
           l.ai_programme_version_id::text AS version_id,
           l.ai_programme_override_id::text AS override_id,
           i.monthly_price_minor::text AS monthly_price_minor, i.months, i.billing
    FROM app.student_ai_fee_items AS i
    JOIN app.school_licenses AS l ON l.id = i.license_id AND l.school_id = i.school_id
    JOIN app.currencies AS c ON c.id = i.currency_id
    WHERE i.school_id = current_setting('app.school_id')::uuid
      AND i.academic_year_id = ${year.id}::uuid AND c.code = ${currencyCode}
  `;
  if (items.length === 0) return margin;
  const portions = await tx<
    {
      item_id: string;
      month_count: number;
      paid_minor: string | null;
      total_minor: string | null;
    }[]
  >`
    SELECT p.item_id::text AS item_id, p.month_count,
           (ic.total_amount_minor - ic.outstanding_amount_minor)::text AS paid_minor,
           ic.total_amount_minor::text AS total_minor
    FROM app.student_ai_fee_portions AS p
    JOIN app.student_ai_fee_items AS i ON i.id = p.item_id AND i.school_id = p.school_id
    LEFT JOIN app.invoice_cache AS ic
      ON ic.school_id = p.school_id AND ic.erpnext_docname = p.erpnext_invoice_docname
    WHERE p.school_id = current_setting('app.school_id')::uuid
      AND i.academic_year_id = ${year.id}::uuid AND p.status = 'invoiced'
  `;
  const licencePrice = new Map<string, number | null>();
  const priceOf = async (item: (typeof items)[number]) => {
    if (!licencePrice.has(item.license_id)) {
      const values = await resolveAiProgrammeValues(
        tx,
        { versionId: item.version_id, overrideId: item.override_id },
        currencyCode,
      );
      licencePrice.set(item.license_id, values.licensePriceMinor);
    }
    return licencePrice.get(item.license_id)!;
  };

  let auto = 0;
  let outside = 0;
  for (const item of items) {
    const licence = await priceOf(item);
    if (licence === null) continue;
    const parent = Number(item.monthly_price_minor);
    margin.lines += 1;
    margin.expectedMinor += studentAiMarginOf(parent, licence, item.months);
    if (item.billing === "outside") {
      outside += 1;
      margin.estimatedMinor += studentAiMarginOf(parent, licence, item.months);
      continue;
    }
    auto += 1;
    for (const portion of portions.filter((p) => p.item_id === item.id)) {
      const billed = studentAiMarginOf(parent, licence, portion.month_count);
      margin.billedMinor += billed;
      margin.collectedMinor += paidPartOf(
        billed,
        Number(portion.paid_minor ?? 0),
        Number(portion.total_minor ?? 0),
      );
    }
  }
  margin.basis =
    auto > 0 && outside > 0 ? "mixed" : outside > 0 ? "estimated" : auto > 0 ? "collected" : "none";
  return margin;
}

async function studafyInvoices(
  tx: TransactionSql,
  license: LicenseRecord,
  entries: readonly RevenueShareEntryView[],
): Promise<DashboardStudafy> {
  const [row] = await tx<
    { invoiced: string; paid: string; outstanding: string; overdue: string }[]
  >`
    SELECT COALESCE(sum(total_minor), 0)::text AS invoiced,
           COALESCE(sum(paid_minor), 0)::text AS paid,
           COALESCE(sum(balance_minor) FILTER (WHERE status IN ('issued', 'partially_paid')), 0)::text
             AS outstanding,
           COALESCE(sum(balance_minor) FILTER (
             WHERE status IN ('issued', 'partially_paid') AND overdue_at IS NOT NULL
           ), 0)::text AS overdue
    FROM app.license_invoices
    WHERE school_id = current_setting('app.school_id')::uuid
      AND license_id = ${license.id}::uuid AND status <> 'void'
  `;
  const credited = entries
    .filter((e) => e.status === "credited" && e.licenseId === license.id)
    .reduce((sum, e) => sum + e.amountMinor, 0);
  return {
    invoicedMinor: Number(row!.invoiced),
    paidMinor: Number(row!.paid),
    outstandingMinor: Number(row!.outstanding),
    overdueMinor: Number(row!.overdue),
    sharesCreditedMinor: credited,
  };
}

function valuesView(values: ResolvedAiProgramme): DashboardValues {
  return {
    licensePriceMinor: values.licensePriceMinor,
    parentPriceMinor: values.parentPriceMinor,
    maxShareBps: values.maxShareBps,
    conversionTiers: values.conversionTiers.map((t) => ({ ...t })),
    contentBonusTiers: values.contentBonusTiers.map((t) => ({ ...t })),
    largeSchoolMinSeats: values.largeSchoolMinSeats,
    largeSchoolShareBps: values.largeSchoolShareBps,
    bonusRequiresConversionShare: values.bonusRequiresConversionShare,
    monthToMonthShareBps: values.monthToMonthShareBps,
    measurementOffsetDays: values.measurementOffsetDays,
    payoutMode: values.payoutMode,
  };
}

/** The armed school's Student AI dashboard (see the module comment). */
export async function aiProgrammeDashboard(
  tx: TransactionSql,
  now: Date = new Date(),
): Promise<AiProgrammeDashboard> {
  const [scope] = await tx<{ school: string }[]>`SELECT current_setting('app.school_id') AS school`;
  const schoolId = scope!.school;
  const today = utcDay(now);
  const license = await currentLicense(tx);
  const currencyCode = license?.currencyCode ?? (await schoolCurrencyCode(tx));
  const minorUnit = await minorUnitOf(tx, currencyCode);
  const values = await resolveAiProgrammeValues(
    tx,
    license
      ? { versionId: license.aiProgrammeVersionId, overrideId: license.aiProgrammeOverrideId }
      : await currentAiProgrammeStamp(tx),
    currencyCode,
  );
  const inProgramme = license ? await licenceInProgramme(tx, license.id) : false;
  const year = await dashboardYear(tx, today);

  const measures = revenueShareMeasures();
  const enrolled = await measures.countEnrolledStudents(tx, schoolId, today);
  const optedIn = license
    ? await measures.countOptedInStudents(tx, schoolId, license.id, today)
    : 0;
  const standing = conversionStanding(values, {
    enrolled,
    optedIn,
    seats: license?.studentSeats ?? 0,
  });

  const conversion = license
    ? await dashboardConversion(tx, license, values, { enrolled, optedIn }, today)
    : null;
  const uploads = await dashboardUploads(tx, license, values);
  const commitment = license?.commitment ?? "full_year";
  const rate = conversion
    ? (() => {
        const share = computeRevenueShare(values, {
          conversionBps: conversion.conversionBps,
          uploadConsistencyBps: uploads.consistencyBps ?? 0,
          seats: conversion.seats,
          commitment,
          baseMinor: 0,
        });
        return {
          conversionShareBps: share.conversionShareBps,
          bonusBps: share.bonusBps,
          capped: share.capped,
          multiplierBps: share.multiplierBps,
          totalBps: share.totalBps,
        };
      })()
    : null;

  const entries = await listRevenueShareEntries(tx);
  const ledger = revenueShareTotals(entries).find((t) => t.currencyCode === currencyCode) ?? null;
  const share = yearShare(entries, currencyCode, year, license?.id ?? null);
  const margin = await yearMargin(tx, year, currencyCode, values);

  return {
    schoolId,
    today,
    license: license
      ? {
          id: license.id,
          status: license.status,
          commitment: license.commitment,
          startsOn: utcDay(license.startsAt),
          endsOn: lastDayOf(license.endsAt),
          studentSeats: license.studentSeats,
          currencyCode: license.currencyCode,
          minorUnit,
          inProgramme,
        }
      : null,
    academicYear: year,
    currencyCode,
    minorUnit,
    values: valuesView(values),
    students: { enrolled, optedIn, conversionBps: standing.conversionBps },
    conversion,
    nextTier: license ? standing.next : null,
    largeSchoolFloor: license ? standing.floor : null,
    uploads,
    rate,
    ledger,
    earnings: {
      share,
      margin,
      totalMinor: share.earnedMinor + margin.collectedMinor + margin.estimatedMinor,
      estimated: margin.estimatedMinor !== 0,
    },
    studafy: license ? await studafyInvoices(tx, license, entries) : null,
  };
}

// ---------------------------------------------------------------------------------------------------
// The super admin's console
// ---------------------------------------------------------------------------------------------------

export interface StudafyNetView {
  /** The year's Student AI collected less its share (earned and pending). */
  netMinor: number;
  perSeatMinor: number | null;
  seats: number;
}

/** What Studafy keeps of a school's Student AI seats for the year, in total and per seat. */
export function studafyNet(dashboard: AiProgrammeDashboard): StudafyNetView {
  const share = dashboard.earnings.share;
  const seats = dashboard.conversion?.seats ?? dashboard.license?.studentSeats ?? 0;
  const net = studafyNetOf({
    collectedMinor: share.collectedMinor,
    shareMinor: share.earnedMinor + share.pendingMinor,
    seats,
  });
  return { ...net, seats };
}

export interface PlatformAiProgrammeDashboard extends AiProgrammeDashboard {
  schoolName: string;
  studafyNet: StudafyNetView;
}

export async function platformAiProgrammeDashboard(
  tx: TransactionSql,
  now: Date = new Date(),
): Promise<PlatformAiProgrammeDashboard> {
  const dashboard = await aiProgrammeDashboard(tx, now);
  const [school] = await tx<{ name: string }[]>`
    SELECT name FROM app.schools WHERE id = current_setting('app.school_id')::uuid
  `;
  return { ...dashboard, schoolName: school?.name ?? "", studafyNet: studafyNet(dashboard) };
}

export interface AiProgrammeSchoolRow {
  schoolId: string;
  schoolName: string;
  licenseId: string | null;
  licenseStatus: LicenseStatus | null;
  commitment: LicenseCommitment | null;
  inProgramme: boolean;
  studentSeats: number;
  currencyCode: string;
  minorUnit: number;
  enrolled: number;
  optedIn: number;
  /** Today's conversion, and the one in force (locked, provisional, or today's). */
  liveConversionBps: number;
  conversionBps: number | null;
  conversionSource: "locked" | "provisional" | "live" | null;
  conversionShareBps: number;
  uploadConsistencyBps: number | null;
  bonusBps: number;
  totalBps: number;
  collectedMinor: number;
  pendingMinor: number;
  owedMinor: number;
  creditedMinor: number;
  payoutDueMinor: number;
  paidOutMinor: number;
  forfeitedMinor: number;
  earnedMinor: number;
  studafyNetMinor: number;
  studafyNetPerSeatMinor: number | null;
}

function schoolRow(dashboard: PlatformAiProgrammeDashboard): AiProgrammeSchoolRow {
  const share = dashboard.earnings.share;
  return {
    schoolId: dashboard.schoolId,
    schoolName: dashboard.schoolName,
    licenseId: dashboard.license?.id ?? null,
    licenseStatus: dashboard.license?.status ?? null,
    commitment: dashboard.license?.commitment ?? null,
    inProgramme: dashboard.license?.inProgramme ?? false,
    studentSeats: dashboard.license?.studentSeats ?? 0,
    currencyCode: dashboard.currencyCode,
    minorUnit: dashboard.minorUnit,
    enrolled: dashboard.students.enrolled,
    optedIn: dashboard.students.optedIn,
    liveConversionBps: dashboard.students.conversionBps,
    conversionBps: dashboard.conversion?.conversionBps ?? null,
    conversionSource: dashboard.conversion?.source ?? null,
    conversionShareBps: dashboard.rate?.conversionShareBps ?? 0,
    uploadConsistencyBps: dashboard.uploads?.consistencyBps ?? null,
    bonusBps: dashboard.rate?.bonusBps ?? 0,
    totalBps: dashboard.rate?.totalBps ?? 0,
    collectedMinor: share.collectedMinor,
    pendingMinor: share.pendingMinor,
    owedMinor: share.owedMinor,
    creditedMinor: share.creditedMinor,
    payoutDueMinor: share.payoutDueMinor,
    paidOutMinor: share.paidOutMinor,
    forfeitedMinor: share.forfeitedMinor,
    earnedMinor: share.earnedMinor,
    studafyNetMinor: dashboard.studafyNet.netMinor,
    studafyNetPerSeatMinor: dashboard.studafyNet.perSeatMinor,
  };
}

/**
 * Every school in the Student AI programme (a licence with an opt-in window or opt-ins, or a revenue
 * share ledger), one row each: the console's overview. One system transaction; each school is read
 * under its own armed scope, as every cross-school console list is.
 */
export async function listAiProgrammeSchools(
  database: Database | DatabasePools,
  now: Date = new Date(),
): Promise<AiProgrammeSchoolRow[]> {
  return withSystemTx(database, async (tx) => {
    const schools = await consoleSchools(tx, null);
    const rows: AiProgrammeSchoolRow[] = [];
    for (const school of schools) {
      await setTenantScope(tx, school.id);
      const [found] = await tx<{ in_programme: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM app.ai_optin_windows
                       WHERE school_id = current_setting('app.school_id')::uuid)
            OR EXISTS (SELECT 1 FROM app.ai_optins
                       WHERE school_id = current_setting('app.school_id')::uuid)
            OR EXISTS (SELECT 1 FROM app.ai_programme_revenue_share_entries
                       WHERE school_id = current_setting('app.school_id')::uuid) AS in_programme
      `;
      if (!found?.in_programme) continue;
      rows.push(schoolRow(await platformAiProgrammeDashboard(tx, now)));
    }
    await setTenantScope(tx, "");
    return rows;
  });
}
