import {
  academicYearMonths,
  allocatePayments,
  computeRevenueShare,
  conversionMeasureDay,
  instalmentPeriods,
  monthIndex,
  monthSlices,
  monthStart,
  ratioBps,
  scheduleMonths,
  splitByWeight,
  studentPartOf,
} from "@studafy/license-pricing";

import { REVENUE_SHARE_MEASURES } from "./measures";
import { readProgrammeValues } from "./programme";

import type { RevenueShareMeasures } from "./measures";
import type { ProgrammeStamp } from "./programme";
import type {
  PaymentPlan,
  ResolvedAiProgramme,
  LicenseCommitment,
  MonthRange,
  RevenueShareResult,
} from "@studafy/license-pricing";
import type { TransactionSql } from "postgres";

/**
 * The Student AI revenue share engine (migration 000237, docs/billing/ai-programme.md): conversion
 * snapshots, the ledger entry for each recorded payment, pending entries worked out once what they
 * wait for is known, voids, and settling (forfeit, credit on the next invoice, payout due). Shared
 * by the API (a payment recorded, the super admin's console) and the workers (the hourly run that
 * locks measurements and settles), which is why it is a package: both must reach the same figures.
 *
 * Every function runs in the caller's transaction, scoped to the school (app.school_id), as
 * studafy_admin -- except `settleRevenueShare`, whose SQL function a school may run too. Every
 * change is handed to `ctx.audit`, which writes the audit rows the caller's way (the API's two-row
 * platform convention, the workers' system rows).
 */

export interface RevenueShareAuditEntry {
  action: "insert" | "update";
  targetTable: string;
  targetId: string;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
}

export type RevenueShareAudit = (entries: readonly RevenueShareAuditEntry[]) => Promise<void>;

export interface RevenueShareContext {
  schoolId: string;
  now: Date;
  audit: RevenueShareAudit;
  /** The adapters; REVENUE_SHARE_MEASURES unless a test passes its own. */
  measures?: RevenueShareMeasures;
}

export const REVENUE_SHARE_STATUSES = [
  "pending",
  // Final figures, waiting for a super admin's approval on the school's weekly statement (owner,
  // 2026-11-18: nothing is credited or paid before it is approved).
  "awaiting_approval",
  "owed",
  "zero",
  "credited",
  "payout_due",
  "paid_out",
  "forfeited",
  "void",
  // A super admin rejected it on a weekly statement: never credited or paid.
  "rejected",
] as const;
export type RevenueShareStatus = (typeof REVENUE_SHARE_STATUSES)[number];

const measuresOf = (ctx: RevenueShareContext) => ctx.measures ?? REVENUE_SHARE_MEASURES;

/** YYYY-MM-DD of an instant, in UTC. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------------
// Licences and their measurement periods
// ---------------------------------------------------------------------------------------------------

export interface LicenceFacts {
  id: string;
  status: string;
  startsOn: string;
  /** The day after the last day (exclusive). */
  endsOn: string;
  currencyId: string;
  currencyCode: string;
  studentSeats: number;
  graceDays: number;
  stamp: ProgrammeStamp;
}

export async function readLicence(
  tx: TransactionSql,
  licenseId: string,
): Promise<LicenceFacts | null> {
  const [row] = await tx<
    {
      id: string;
      status: string;
      starts_on: string;
      ends_on: string;
      currency_id: string;
      currency_code: string;
      student_seats: number;
      grace_days: number;
      version_id: string;
      override_id: string | null;
    }[]
  >`
    SELECT l.id::text AS id, l.status,
           ((l.starts_at AT TIME ZONE 'UTC')::date)::text AS starts_on,
           ((l.ends_at AT TIME ZONE 'UTC')::date)::text AS ends_on,
           l.currency_id::text AS currency_id, c.code AS currency_code, l.student_seats,
           l.nonpayment_grace_days AS grace_days,
           l.ai_programme_version_id::text AS version_id,
           l.ai_programme_override_id::text AS override_id
    FROM app.school_licenses AS l
    JOIN app.currencies AS c ON c.id = l.currency_id
    WHERE l.school_id = current_setting('app.school_id')::uuid AND l.id = ${licenseId}::uuid
  `;
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    currencyId: row.currency_id,
    currencyCode: row.currency_code,
    studentSeats: row.student_seats,
    graceDays: row.grace_days,
    stamp: { versionId: row.version_id, overrideId: row.override_id },
  };
}

/**
 * Whether a licence is in the Student AI programme: the school opened at least one opt-in window on
 * it, or it holds programme opt-ins (phase 2, 000235; a transfer's opt-in has no window of its own).
 * Only such a licence earns a revenue share: a licence without it gets no ledger entries and no
 * conversion measurement.
 */
export async function licenceInProgramme(tx: TransactionSql, licenseId: string): Promise<boolean> {
  const [row] = await tx<{ in_programme: boolean }[]>`
    SELECT EXISTS (
             SELECT 1 FROM app.ai_optin_windows AS w
             WHERE w.school_id = current_setting('app.school_id')::uuid
               AND w.license_id = ${licenseId}::uuid
           )
        OR EXISTS (
             SELECT 1 FROM app.ai_optins AS o
             WHERE o.school_id = current_setting('app.school_id')::uuid
               AND o.license_id = ${licenseId}::uuid
           ) AS in_programme
  `;
  return row?.in_programme ?? false;
}

/**
 * The months a licence counts over its whole span, renewals included (an accepted extension moves
 * its end): THE month rule (`academicYearMonths`). Null for a span too short to count a month.
 */
function countedMonthsOf(licence: Pick<LicenceFacts, "startsOn" | "endsOn">): MonthRange | null {
  return academicYearMonths(licence.startsOn, addDays(licence.endsOn, -1));
}

/**
 * A licence's measurement periods, by their first day: one per month it counts (owner,
 * 2026-11-18: conversion is measured and locked every month). A licence too short to count a month
 * has the one period of the month it starts in.
 */
export async function measurementPeriods(tx: TransactionSql, licenseId: string): Promise<string[]> {
  const licence = await readLicence(tx, licenseId);
  if (!licence) return [];
  const counted = countedMonthsOf(licence);
  if (!counted) return [monthStart(monthIndex(licence.startsOn))];
  const months: string[] = [];
  for (let index = counted.first; index <= counted.last; index += 1) months.push(monthStart(index));
  return months;
}

/** The day a period's conversion is measured: its month's first day, or the licence's when later. */
export async function measurementDayOf(
  tx: TransactionSql,
  licenseId: string,
  periodStart: string,
): Promise<string> {
  const licence = await readLicence(tx, licenseId);
  return conversionMeasureDay(periodStart, licence?.startsOn ?? periodStart);
}

/**
 * The first day of a licence's terms: its start, and the first day of every term an accepted
 * extension (a renewal) added -- the stretch `recordEarlierPaymentShares` looks back over.
 */
async function licenceTermStarts(tx: TransactionSql, licenseId: string): Promise<string[]> {
  const rows = await tx<{ start: string }[]>`
    SELECT ((l.starts_at AT TIME ZONE 'UTC')::date)::text AS start
    FROM app.school_licenses AS l
    WHERE l.school_id = current_setting('app.school_id')::uuid AND l.id = ${licenseId}::uuid
    UNION
    SELECT ((q.starts_at AT TIME ZONE 'UTC')::date)::text
    FROM app.license_quotes AS q
    WHERE q.school_id = current_setting('app.school_id')::uuid
      AND q.license_id = ${licenseId}::uuid
      AND q.kind = 'extension' AND q.status = 'accepted'
    ORDER BY 1
  `;
  return rows.map((row) => row.start);
}

/** The period a day falls in: the latest period that started on or before it (the first, before any). */
export function periodFor(periods: readonly string[], day: string): string {
  let found = periods[0]!;
  for (const start of periods) if (start <= day) found = start;
  return found;
}

// ---------------------------------------------------------------------------------------------------
// Conversion snapshots
// ---------------------------------------------------------------------------------------------------

export interface ConversionMeasurement {
  licenseId: string;
  periodStart: string;
  measureOn: string;
  asOf: string;
  enrolledCount: number;
  /**
   * Enrolled students with Student AI from the school that month: an opt-in covering the month, or
   * a student seat the school assigned on the licence (owner, 2026-11-18). Not in-app purchases.
   */
  optedInCount: number;
  conversionBps: number;
  /** The same count: the large-school floor's test is on the students the school provides for. */
  seats: number;
  conversionShareBps: number;
  floorApplied: boolean;
  stamp: ProgrammeStamp;
}

/** Measure a licence month's conversion as of a day, under the values the licence carries now. */
export async function measureConversion(
  tx: TransactionSql,
  ctx: RevenueShareContext,
  licenseId: string,
  periodStart: string,
  asOf: string,
): Promise<ConversionMeasurement> {
  const licence = await readLicence(tx, licenseId);
  if (!licence) throw new Error(`Unknown licence ${licenseId}.`);
  const values = await readProgrammeValues(tx, licence.stamp, licence.currencyCode);
  const measures = measuresOf(ctx);
  const enrolledCount = await measures.countEnrolledStudents(tx, ctx.schoolId, asOf);
  const holders = await measures.countStudentAiHolders(
    tx,
    ctx.schoolId,
    licenseId,
    periodStart,
    asOf,
  );
  const conversionBps = ratioBps(holders, enrolledCount);
  const share = computeRevenueShare(values, {
    conversionBps,
    uploadConsistencyBps: 0,
    seats: holders,
    commitment: "full_year",
    baseMinor: 0,
  });
  return {
    licenseId,
    periodStart,
    measureOn: conversionMeasureDay(periodStart, licence.startsOn),
    asOf,
    enrolledCount,
    optedInCount: holders,
    conversionBps,
    seats: holders,
    conversionShareBps: share.conversionShareBps,
    floorApplied: share.floorApplied,
    stamp: licence.stamp,
  };
}

export interface SnapshotRecord extends ConversionMeasurement {
  id: string;
  locked: boolean;
  source: "scheduled" | "super_admin";
  reason: string | null;
  measuredBy: string | null;
  measuredAt: string;
}

/** Store a measurement: locked by the workers on the measurement day, or a super admin's re-measure. */
export async function insertSnapshot(
  tx: TransactionSql,
  ctx: RevenueShareContext,
  measurement: ConversionMeasurement,
  how: { source: "scheduled" } | { source: "super_admin"; reason: string; measuredBy: string },
): Promise<SnapshotRecord> {
  const locked = how.source === "scheduled";
  const reason = how.source === "super_admin" ? how.reason : null;
  const measuredBy = how.source === "super_admin" ? how.measuredBy : null;
  const [row] = await tx<{ id: string; measured_at: Date }[]>`
    INSERT INTO app.ai_programme_conversion_snapshots (
      school_id, license_id, period_start, measure_on, as_of, enrolled_count, opted_in_count,
      conversion_bps, seats, conversion_share_bps, floor_applied, ai_programme_version_id,
      ai_programme_override_id, locked, source, reason, measured_by
    ) VALUES (
      ${ctx.schoolId}::uuid, ${measurement.licenseId}::uuid, ${measurement.periodStart}::date,
      ${measurement.measureOn}::date, ${measurement.asOf}::date, ${measurement.enrolledCount},
      ${measurement.optedInCount}, ${measurement.conversionBps}, ${measurement.seats},
      ${measurement.conversionShareBps}, ${measurement.floorApplied},
      ${measurement.stamp.versionId}::uuid, ${measurement.stamp.overrideId}::uuid, ${locked},
      ${how.source}, ${reason}, ${measuredBy}::uuid
    )
    RETURNING id::text AS id, measured_at
  `;
  await ctx.audit([
    {
      action: "insert",
      targetTable: "ai_programme_conversion_snapshots",
      targetId: row!.id,
      oldValues: null,
      newValues: {
        license_id: measurement.licenseId,
        period_start: measurement.periodStart,
        measure_on: measurement.measureOn,
        as_of: measurement.asOf,
        enrolled_count: measurement.enrolledCount,
        opted_in_count: measurement.optedInCount,
        conversion_bps: measurement.conversionBps,
        seats: measurement.seats,
        conversion_share_bps: measurement.conversionShareBps,
        locked,
        source: how.source,
        ...(reason ? { reason } : {}),
      },
    },
  ]);
  return {
    ...measurement,
    id: row!.id,
    locked,
    source: how.source,
    reason,
    measuredBy,
    measuredAt: row!.measured_at.toISOString(),
  };
}

export interface LockedSnapshot {
  id: string;
  conversionBps: number;
  seats: number;
}

export async function lockedSnapshot(
  tx: TransactionSql,
  licenseId: string,
  periodStart: string,
): Promise<LockedSnapshot | null> {
  const [row] = await tx<{ id: string; conversion_bps: number; seats: number }[]>`
    SELECT id::text AS id, conversion_bps, seats
    FROM app.ai_programme_conversion_snapshots
    WHERE school_id = current_setting('app.school_id')::uuid
      AND license_id = ${licenseId}::uuid AND period_start = ${periodStart}::date AND locked
  `;
  return row ? { id: row.id, conversionBps: row.conversion_bps, seats: row.seats } : null;
}

/**
 * A period whose measurement day passed longer ago than this is locked only when a share waits for
 * it: the hourly run catches up after an outage, but deploying the engine does not measure every
 * old licence's past periods after the fact.
 */
export const LOCK_CATCH_UP_DAYS = 31;

/**
 * Lock every measurement that is due: for each licence period whose measurement day has come and
 * that has no locked measurement yet, measure as of that day and lock it. Only licences that can
 * still earn (awaiting payment, active, suspended) in the programme, for a measurement day in the
 * last LOCK_CATCH_UP_DAYS days, and any period that has shares waiting for its conversion.
 * Idempotent: a locked period is never measured again.
 */
export async function lockDueConversionSnapshots(
  tx: TransactionSql,
  ctx: RevenueShareContext,
): Promise<SnapshotRecord[]> {
  const today = utcDay(ctx.now);
  const catchUpFrom = utcDay(new Date(ctx.now.getTime() - LOCK_CATCH_UP_DAYS * 86_400_000));
  const licences = await tx<{ id: string }[]>`
    SELECT l.id::text AS id
    FROM app.school_licenses AS l
    WHERE l.school_id = current_setting('app.school_id')::uuid
      AND (
        (l.status IN ('awaiting_payment', 'active', 'suspended')
         AND (
           EXISTS (SELECT 1 FROM app.ai_optin_windows AS w
                   WHERE w.school_id = l.school_id AND w.license_id = l.id)
           OR EXISTS (SELECT 1 FROM app.ai_optins AS o
                      WHERE o.school_id = l.school_id AND o.license_id = l.id)
         ))
        OR EXISTS (
          SELECT 1 FROM app.ai_programme_revenue_share_entries AS e
          WHERE e.school_id = l.school_id AND e.license_id = l.id AND e.status = 'pending'
            AND e.conversion_pending
        )
      )
    ORDER BY l.starts_at, l.id
  `;
  const locked: SnapshotRecord[] = [];
  for (const { id } of licences) {
    const licence = (await readLicence(tx, id))!;
    const periods = await measurementPeriods(tx, id);
    const waiting = new Set(
      (
        await tx<{ start: string }[]>`
          SELECT DISTINCT measurement_period_start::text AS start
          FROM app.ai_programme_revenue_share_entries
          WHERE school_id = current_setting('app.school_id')::uuid AND license_id = ${id}::uuid
            AND status = 'pending' AND conversion_pending
        `
      ).map((row) => row.start),
    );
    const earning = ["awaiting_payment", "active", "suspended"].includes(licence.status);
    for (const periodStart of periods) {
      const measureOn = conversionMeasureDay(periodStart, licence.startsOn);
      if (measureOn > today) continue;
      const relevant =
        waiting.has(periodStart) ||
        (earning && measureOn < licence.endsOn && measureOn >= catchUpFrom);
      if (!relevant || (await lockedSnapshot(tx, id, periodStart))) continue;
      const measurement = await measureConversion(tx, ctx, id, periodStart, measureOn);
      locked.push(await insertSnapshot(tx, ctx, measurement, { source: "scheduled" }));
    }
  }
  return locked;
}

// ---------------------------------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------------------------------

interface FigureInput {
  licence: LicenceFacts;
  stamp: ProgrammeStamp;
  measurementPeriodStart: string;
  periodFrom: string;
  periodTo: string;
  commitment: LicenseCommitment;
  baseMinor: number;
}

interface Figures {
  values: ResolvedAiProgramme;
  snapshot: LockedSnapshot | null;
  uploadConsistencyBps: number | null;
  result: RevenueShareResult;
  /**
   * Nothing is left to wait for: the month's conversion is locked and the share is final. A share
   * waits for its month's locked conversion even when it cannot change the amount (a month-to-month
   * licence at 0%), so every final entry records the conversion it was given.
   */
  final: boolean;
  /**
   * Where a final share goes: awaiting the super admin's approval on the school's weekly statement
   * (approved, it becomes owed or payout due by the programme's payout mode), or zero (nothing).
   */
  finalStatus: "awaiting_approval" | "zero";
}

async function figuresFor(
  tx: TransactionSql,
  ctx: RevenueShareContext,
  input: FigureInput,
): Promise<Figures> {
  const values = await readProgrammeValues(tx, input.stamp, input.licence.currencyCode);
  const snapshot = await lockedSnapshot(tx, input.licence.id, input.measurementPeriodStart);
  const uploadConsistencyBps = await measuresOf(ctx).uploadConsistencyForPeriod(tx, {
    schoolId: ctx.schoolId,
    licenseId: input.licence.id,
    from: input.periodFrom,
    to: input.periodTo,
  });
  const result = computeRevenueShare(values, {
    conversionBps: snapshot?.conversionBps ?? null,
    uploadConsistencyBps,
    seats: snapshot?.seats ?? input.licence.studentSeats,
    commitment: input.commitment,
    baseMinor: input.baseMinor,
  });
  return {
    values,
    snapshot,
    uploadConsistencyBps,
    result,
    final: result.final && snapshot !== null,
    finalStatus: result.amountMinor === 0 ? "zero" : "awaiting_approval",
  };
}

/** The columns a computation writes. */
function figureColumns(f: Figures) {
  return {
    snapshot_id: f.snapshot?.id ?? null,
    seats: f.snapshot?.seats ?? null,
    conversion_bps: f.snapshot?.conversionBps ?? null,
    conversion_share_bps: f.result.conversionShareBps,
    floor_applied: f.result.floorApplied,
    upload_consistency_bps: f.uploadConsistencyBps,
    bonus_bps: f.result.bonusBps,
    capped: f.result.capped,
    multiplier_bps: f.result.multiplierBps,
    total_bps: f.result.totalBps,
    amount_minor: f.result.amountMinor,
    conversion_pending: f.snapshot === null,
    bonus_pending: f.result.bonusPending,
  };
}

function figureAudit(f: Figures): Record<string, unknown> {
  const c = figureColumns(f);
  return {
    conversion_bps: c.conversion_bps,
    conversion_share_bps: c.conversion_share_bps,
    floor_applied: c.floor_applied,
    upload_consistency_bps: c.upload_consistency_bps,
    bonus_bps: c.bonus_bps,
    capped: c.capped,
    multiplier_bps: c.multiplier_bps,
    total_bps: c.total_bps,
    amount_minor: c.amount_minor,
    conversion_pending: c.conversion_pending,
    bonus_pending: c.bonus_pending,
  };
}

/** A payment's part of one instalment (the increase in that instalment's paid amount). */
export interface PaymentPortion {
  instalmentId: string;
  amountMinor: number;
}

export interface RecordedShare {
  id: string;
  instalmentId: string;
  status: RevenueShareStatus;
  amountMinor: number;
  totalBps: number;
}

/**
 * The ledger entries for a payment just recorded: one per instalment it paid, on the Student AI part
 * of the money, under the values the licence carries now. Pending when conversion is not locked or
 * the upload consistency is not known; forfeited at once when the money came on or after the
 * instalment's cutoff (decision 11). Nothing for an invoice without student seats.
 */
export async function recordPaymentShares(
  tx: TransactionSql,
  ctx: RevenueShareContext,
  paymentId: string,
  portions: readonly PaymentPortion[],
): Promise<RecordedShare[]> {
  const paid = portions.filter((portion) => portion.amountMinor > 0);
  if (paid.length === 0) return [];
  const [payment] = await tx<
    {
      invoice_id: string;
      received_on: string;
      license_id: string;
      quote_id: string | null;
      currency_id: string;
      payment_plan: PaymentPlan;
      student_lines: string;
      seat_lines: string;
    }[]
  >`
    SELECT p.invoice_id::text AS invoice_id,
           ((p.received_at AT TIME ZONE 'UTC')::date)::text AS received_on,
           i.license_id::text AS license_id, i.quote_id::text AS quote_id,
           i.currency_id::text AS currency_id, i.payment_plan,
           COALESCE((SELECT sum(line.amount_minor) FROM app.license_invoice_lines AS line
                     WHERE line.school_id = i.school_id AND line.invoice_id = i.id
                       AND line.kind = 'seats' AND line.audience = 'student'), 0)::text AS student_lines,
           COALESCE((SELECT sum(line.amount_minor) FROM app.license_invoice_lines AS line
                     WHERE line.school_id = i.school_id AND line.invoice_id = i.id
                       AND line.kind = 'seats'), 0)::text AS seat_lines
    FROM app.license_payments AS p
    JOIN app.license_invoices AS i ON i.id = p.invoice_id AND i.school_id = p.school_id
    WHERE p.school_id = current_setting('app.school_id')::uuid AND p.id = ${paymentId}::uuid
  `;
  if (!payment) throw new Error(`Unknown licence payment ${paymentId}.`);
  const studentLines = Number(payment.student_lines);
  if (studentLines <= 0) return [];
  // Only a licence in the Student AI programme earns a share (an opt-in window, or opt-ins).
  if (!(await licenceInProgramme(tx, payment.license_id))) return [];
  const licence = (await readLicence(tx, payment.license_id))!;
  const commitment = await measuresOf(ctx).licenceCommitment(tx, ctx.schoolId, licence.id);

  // What each instalment pays for: the quote's term (the added months of an extension, the rest of
  // the term for a seat increase), split as its plan splits it.
  const [term] = await tx<
    { starts_on: string; ends_on: string; months: number; prorate_days: number | null }[]
  >`
    SELECT ((q.starts_at AT TIME ZONE 'UTC')::date)::text AS starts_on,
           ((q.ends_at AT TIME ZONE 'UTC')::date)::text AS ends_on, q.months, q.prorate_days
    FROM app.license_quotes AS q
    WHERE q.school_id = current_setting('app.school_id')::uuid AND q.id = ${payment.quote_id}::uuid
  `;
  const instalments = await tx<{ id: string; position: number; due_date: string }[]>`
    SELECT id::text AS id, position, due_date::text AS due_date
    FROM app.license_invoice_instalments
    WHERE school_id = current_setting('app.school_id')::uuid
      AND invoice_id = ${payment.invoice_id}::uuid
    ORDER BY position
  `;
  const periods = instalmentPeriods({
    plan: payment.payment_plan,
    startDate: term?.starts_on ?? licence.startsOn,
    endDate: term?.ends_on ?? licence.endsOn,
    months: term ? scheduleMonths(term.months, term.prorate_days) : 1,
    instalments: instalments.map((i) => ({ position: i.position, dueDate: i.due_date })),
  });
  const licenceTerm = { startsOn: licence.startsOn, lastDay: addDays(licence.endsOn, -1) };

  const recorded: RecordedShare[] = [];
  for (const portion of paid) {
    const instalment = instalments.find((i) => i.id === portion.instalmentId);
    if (!instalment) throw new Error(`Instalment ${portion.instalmentId} is not on the invoice.`);
    const period = periods.find((p) => p.position === instalment.position)!;
    const cutoff = addDays(instalment.due_date, licence.graceDays);
    const late = payment.received_on >= cutoff;
    // One entry per month the instalment pays for, each under that month's conversion (owner,
    // 2026-11-18): the money split by month, the Student AI part taken of each month's money.
    const slices = monthSlices(period.from, period.to, licenceTerm);
    const collectedParts = splitByWeight(portion.amountMinor, slices);
    for (const [index, slice] of slices.entries()) {
      const collected = collectedParts.at(index) ?? 0;
      if (collected <= 0) continue;
      const base = studentPartOf(collected, studentLines, Number(payment.seat_lines));
      const figures = await figuresFor(tx, ctx, {
        licence,
        stamp: licence.stamp,
        measurementPeriodStart: slice.month,
        periodFrom: slice.from,
        periodTo: slice.to,
        commitment,
        baseMinor: base,
      });
      const status: RevenueShareStatus = late
        ? "forfeited"
        : figures.final
          ? figures.finalStatus
          : "pending";
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.ai_programme_revenue_share_entries ${tx({
          school_id: ctx.schoolId,
          kind: "share",
          license_id: licence.id,
          invoice_id: payment.invoice_id,
          payment_id: paymentId,
          instalment_id: instalment.id,
          received_on: payment.received_on,
          period_from: slice.from,
          period_to: slice.to,
          measurement_period_start: slice.month,
          currency_id: payment.currency_id,
          collected_minor: collected,
          base_minor: base,
          commitment,
          ai_programme_version_id: licence.stamp.versionId,
          ai_programme_override_id: licence.stamp.overrideId,
          ...figureColumns(figures),
          status,
          final_at: status === "awaiting_approval" ? ctx.now : null,
          forfeited_at: late ? ctx.now : null,
          forfeit_reason: late ? "late_payment" : null,
        })}
        RETURNING id::text AS id
      `;
      await ctx.audit([
        {
          action: "insert",
          targetTable: "ai_programme_revenue_share_entries",
          targetId: row!.id,
          oldValues: null,
          newValues: {
            license_id: licence.id,
            invoice_id: payment.invoice_id,
            payment_id: paymentId,
            instalment_id: instalment.id,
            period_from: slice.from,
            period_to: slice.to,
            measurement_period_start: slice.month,
            collected_minor: collected,
            base_minor: base,
            commitment,
            ai_programme_version_id: licence.stamp.versionId,
            ai_programme_override_id: licence.stamp.overrideId,
            ...figureAudit(figures),
            status,
            ...(late ? { forfeit_reason: "late_payment" } : {}),
          },
        },
      ]);
      recorded.push({
        id: row!.id,
        instalmentId: instalment.id,
        status,
        amountMinor: figures.result.amountMinor,
        totalBps: figures.result.totalBps,
      });
    }
  }
  return recorded;
}

/**
 * A licence just entered the Student AI programme (its first opt-in window, or its first opt-in):
 * the payments already recorded on it for the current licence period earned nothing when they were
 * recorded (the programme gate is tested at record time), so record their shares now, as
 * `recordPaymentShares` would have -- the same figures, pending or final, and forfeited when the
 * money came on or after the instalment's cutoff.
 *
 * Only payments that are not voided and have no ledger entry get one: entries are created, never
 * rewritten, and calling it again records nothing. "The current licence period" is the measurement
 * period today falls in (the licence's start, or the start of the term a renewal added): the
 * invoices whose term starts in it. Each earlier payment's part of each instalment is worked out as
 * `recordPayment` did, by replaying the invoice's payments in the order they were recorded,
 * earliest instalment first (`allocatePayments`).
 */
export async function recordEarlierPaymentShares(
  tx: TransactionSql,
  ctx: RevenueShareContext,
  licenseId: string,
): Promise<RecordedShare[]> {
  if (!(await licenceInProgramme(tx, licenseId))) return [];
  const periods = await licenceTermStarts(tx, licenseId);
  if (periods.length === 0) return [];
  const current = periodFor(periods, utcDay(ctx.now));
  const next = periods.find((start) => start > current) ?? null;
  const invoices = await tx<{ id: string }[]>`
    SELECT i.id::text AS id
    FROM app.license_invoices AS i
    JOIN app.school_licenses AS l ON l.id = i.license_id AND l.school_id = i.school_id
    LEFT JOIN app.license_quotes AS q ON q.id = i.quote_id AND q.school_id = i.school_id
    WHERE i.school_id = current_setting('app.school_id')::uuid
      AND i.license_id = ${licenseId}::uuid
      AND i.status <> 'void'
      AND ((COALESCE(q.starts_at, l.starts_at) AT TIME ZONE 'UTC')::date) >= ${current}::date
      AND (${next}::date IS NULL
           OR ((COALESCE(q.starts_at, l.starts_at) AT TIME ZONE 'UTC')::date) < ${next}::date)
    ORDER BY i.issue_date, i.number
  `;
  const recorded: RecordedShare[] = [];
  for (const invoice of invoices) {
    const instalments = await tx<{ id: string; position: number; amount_minor: string }[]>`
      SELECT id::text AS id, position, amount_minor::text AS amount_minor
      FROM app.license_invoice_instalments
      WHERE school_id = current_setting('app.school_id')::uuid
        AND invoice_id = ${invoice.id}::uuid
      ORDER BY position
    `;
    const payments = await tx<{ id: string; amount_minor: string; has_entries: boolean }[]>`
      SELECT p.id::text AS id, p.amount_minor::text AS amount_minor,
             EXISTS (
               SELECT 1 FROM app.ai_programme_revenue_share_entries AS e
               WHERE e.school_id = p.school_id AND e.payment_id = p.id
             ) AS has_entries
      FROM app.license_payments AS p
      WHERE p.school_id = current_setting('app.school_id')::uuid
        AND p.invoice_id = ${invoice.id}::uuid AND p.voided_at IS NULL
      ORDER BY p.created_at, p.id
    `;
    const amounts = instalments.map((i) => ({
      position: i.position,
      amountMinor: Number(i.amount_minor),
    }));
    let paidBefore = 0;
    for (const payment of payments) {
      const before = allocatePayments(amounts, paidBefore);
      paidBefore += Number(payment.amount_minor);
      if (payment.has_entries) continue;
      const after = allocatePayments(amounts, paidBefore);
      const portions = instalments.map((instalment, index) => ({
        instalmentId: instalment.id,
        amountMinor: after[index]!.paidMinor - before[index]!.paidMinor,
      }));
      recorded.push(...(await recordPaymentShares(tx, ctx, payment.id, portions)));
    }
  }
  return recorded;
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export interface ResolvedShare {
  id: string;
  status: RevenueShareStatus;
  amountMinor: number;
}

/**
 * Work out the school's pending entries again (one licence's, when given): with conversion locked
 * and the upload consistency known they become final -- awaiting the super admin's approval, or zero. Each keeps the values it
 * was recorded under (the licence's stamp at the time of the payment).
 */
export async function resolvePendingShares(
  tx: TransactionSql,
  ctx: RevenueShareContext,
  filter: { licenseId?: string } = {},
): Promise<ResolvedShare[]> {
  const pending = await tx<
    {
      id: string;
      license_id: string;
      version_id: string;
      override_id: string | null;
      measurement_period_start: string;
      period_from: string;
      period_to: string;
      commitment: LicenseCommitment;
      base_minor: string;
      amount_minor: string;
      total_bps: number;
      conversion_pending: boolean;
      bonus_pending: boolean;
      snapshot_id: string | null;
      upload_consistency_bps: number | null;
    }[]
  >`
    SELECT id::text AS id, license_id::text AS license_id,
           ai_programme_version_id::text AS version_id,
           ai_programme_override_id::text AS override_id,
           measurement_period_start::text AS measurement_period_start,
           period_from::text AS period_from, period_to::text AS period_to, commitment,
           base_minor::text AS base_minor, amount_minor::text AS amount_minor, total_bps,
           conversion_pending, bonus_pending, snapshot_id::text AS snapshot_id,
           upload_consistency_bps
    FROM app.ai_programme_revenue_share_entries
    WHERE school_id = current_setting('app.school_id')::uuid AND status = 'pending'
      ${filter.licenseId ? tx`AND license_id = ${filter.licenseId}::uuid` : tx``}
    ORDER BY computed_at, id
    FOR UPDATE
  `;
  const resolved: ResolvedShare[] = [];
  const licences = new Map<string, LicenceFacts>();
  for (const entry of pending) {
    const licence = licences.get(entry.license_id) ?? (await readLicence(tx, entry.license_id))!;
    licences.set(entry.license_id, licence);
    const figures = await figuresFor(tx, ctx, {
      licence,
      stamp: { versionId: entry.version_id, overrideId: entry.override_id },
      measurementPeriodStart: entry.measurement_period_start,
      periodFrom: entry.period_from,
      periodTo: entry.period_to,
      commitment: entry.commitment,
      baseMinor: Number(entry.base_minor),
    });
    const columns = figureColumns(figures);
    const unchanged =
      !figures.final &&
      columns.snapshot_id === entry.snapshot_id &&
      columns.upload_consistency_bps === entry.upload_consistency_bps &&
      columns.amount_minor === Number(entry.amount_minor) &&
      columns.total_bps === entry.total_bps &&
      columns.conversion_pending === entry.conversion_pending &&
      columns.bonus_pending === entry.bonus_pending;
    if (unchanged) continue;
    const status: RevenueShareStatus = figures.final ? figures.finalStatus : "pending";
    const finalAt = status === "awaiting_approval" ? ctx.now : null;
    await tx`
      UPDATE app.ai_programme_revenue_share_entries
      SET ${tx({ ...columns, status, final_at: finalAt })}, computed_at = ${ctx.now},
          updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
      WHERE school_id = current_setting('app.school_id')::uuid AND id = ${entry.id}::uuid
    `;
    await ctx.audit([
      {
        action: "update",
        targetTable: "ai_programme_revenue_share_entries",
        targetId: entry.id,
        oldValues: {
          status: "pending",
          amount_minor: Number(entry.amount_minor),
          total_bps: entry.total_bps,
          conversion_pending: entry.conversion_pending,
          bonus_pending: entry.bonus_pending,
        },
        newValues: { ...figureAudit(figures), status },
      },
    ]);
    resolved.push({ id: entry.id, status, amountMinor: columns.amount_minor });
  }
  return resolved;
}

export interface VoidedShare {
  id: string;
  from: RevenueShareStatus;
  /** The reversal written for a share already credited or paid out. */
  reversalId: string | null;
}

/**
 * A payment was voided: its shares not given yet are void; a share already credited or paid out is
 * taken back by a reversal entry (the negative of it), owed against the next credit (or due against
 * the next payout, for one paid out). Forfeited shares stay forfeited.
 */
export async function voidPaymentShares(
  tx: TransactionSql,
  ctx: RevenueShareContext,
  paymentId: string,
): Promise<VoidedShare[]> {
  const entries = await tx<{ id: string; status: RevenueShareStatus }[]>`
    SELECT id::text AS id, status
    FROM app.ai_programme_revenue_share_entries
    WHERE school_id = current_setting('app.school_id')::uuid AND payment_id = ${paymentId}::uuid
      AND kind = 'share'
    ORDER BY id
    FOR UPDATE
  `;
  const voided: VoidedShare[] = [];
  for (const entry of entries) {
    if (
      entry.status === "pending" ||
      entry.status === "awaiting_approval" ||
      entry.status === "owed" ||
      entry.status === "zero" ||
      entry.status === "payout_due"
    ) {
      await tx`
        UPDATE app.ai_programme_revenue_share_entries
        SET status = 'void', voided_at = ${ctx.now},
            updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
        WHERE school_id = current_setting('app.school_id')::uuid AND id = ${entry.id}::uuid
      `;
      await ctx.audit([
        {
          action: "update",
          targetTable: "ai_programme_revenue_share_entries",
          targetId: entry.id,
          oldValues: { status: entry.status },
          newValues: { status: "void", payment_id: paymentId },
        },
      ]);
      voided.push({ id: entry.id, from: entry.status, reversalId: null });
      continue;
    }
    if (entry.status !== "credited" && entry.status !== "paid_out") continue;
    const status = entry.status === "credited" ? "owed" : "payout_due";
    const [reversal] = await tx<{ id: string; amount_minor: string }[]>`
      INSERT INTO app.ai_programme_revenue_share_entries (
        school_id, kind, reverses_entry_id, license_id, invoice_id, payment_id, instalment_id,
        received_on, period_from, period_to, measurement_period_start, currency_id,
        collected_minor, base_minor, commitment, ai_programme_version_id,
        ai_programme_override_id, snapshot_id, seats, conversion_bps, conversion_share_bps,
        floor_applied, upload_consistency_bps, bonus_bps, capped, multiplier_bps, total_bps,
        amount_minor, conversion_pending, bonus_pending, status, computed_at
      )
      SELECT school_id, 'reversal', id, license_id, invoice_id, payment_id, instalment_id,
             received_on, period_from, period_to, measurement_period_start, currency_id,
             -collected_minor, -base_minor, commitment, ai_programme_version_id,
             ai_programme_override_id, snapshot_id, seats, conversion_bps, conversion_share_bps,
             floor_applied, upload_consistency_bps, bonus_bps, capped, multiplier_bps, total_bps,
             -amount_minor, false, false, ${status}, ${ctx.now}
      FROM app.ai_programme_revenue_share_entries
      WHERE school_id = current_setting('app.school_id')::uuid AND id = ${entry.id}::uuid
      RETURNING id::text AS id, amount_minor::text AS amount_minor
    `;
    await ctx.audit([
      {
        action: "insert",
        targetTable: "ai_programme_revenue_share_entries",
        targetId: reversal!.id,
        oldValues: null,
        newValues: {
          kind: "reversal",
          reverses_entry_id: entry.id,
          payment_id: paymentId,
          amount_minor: Number(reversal!.amount_minor),
          status,
        },
      },
    ]);
    voided.push({ id: entry.id, from: entry.status, reversalId: reversal!.id });
  }
  return voided;
}

/**
 * An invoice the school's shares were credited on was voided (nothing was paid on it): those shares
 * are owed again, for the next invoice. The voided invoice keeps its credit line, as history.
 */
export async function restoreCreditsOfVoidedInvoice(
  tx: TransactionSql,
  ctx: RevenueShareContext,
  invoiceId: string,
): Promise<string[]> {
  const restored = await tx<{ id: string; amount_minor: string }[]>`
    UPDATE app.ai_programme_revenue_share_entries
    SET status = 'owed', credit_invoice_id = NULL, credited_at = NULL,
        updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid
      AND credit_invoice_id = ${invoiceId}::uuid AND status = 'credited'
    RETURNING id::text AS id, amount_minor::text AS amount_minor
  `;
  await ctx.audit(
    restored.map((entry) => ({
      action: "update" as const,
      targetTable: "ai_programme_revenue_share_entries",
      targetId: entry.id,
      oldValues: { status: "credited", credit_invoice_id: invoiceId },
      newValues: { status: "owed", credit_invoice_id: null, reason: "credit_invoice_voided" },
    })),
  );
  return restored.map((entry) => entry.id);
}

export interface DecidedShare {
  id: string;
  to: RevenueShareStatus;
  amountMinor: number;
}

interface AwaitingRow {
  id: string;
  version_id: string;
  override_id: string | null;
  currency_code: string;
  amount_minor: string;
}

async function lockAwaiting(
  tx: TransactionSql,
  entryIds: readonly string[],
): Promise<AwaitingRow[]> {
  if (entryIds.length === 0) return [];
  return tx<AwaitingRow[]>`
    SELECT e.id::text AS id, e.ai_programme_version_id::text AS version_id,
           e.ai_programme_override_id::text AS override_id, c.code AS currency_code,
           e.amount_minor::text AS amount_minor
    FROM app.ai_programme_revenue_share_entries AS e
    JOIN app.currencies AS c ON c.id = e.currency_id
    WHERE e.school_id = current_setting('app.school_id')::uuid
      AND e.id = ANY(${entryIds as string[]}::uuid[]) AND e.status = 'awaiting_approval'
    ORDER BY e.id
    FOR UPDATE OF e
  `;
}

/**
 * A super admin approved these shares: each one still awaiting approval becomes owed (credited on
 * the school's next licence invoice by settling) or payout due, by the payout mode of the programme
 * values it was recorded under. Shares no longer awaiting approval (forfeited or voided since) are
 * left alone and not returned. The caller settles afterwards.
 */
export async function approveShares(
  tx: TransactionSql,
  ctx: RevenueShareContext,
  entryIds: readonly string[],
): Promise<DecidedShare[]> {
  const rows = await lockAwaiting(tx, entryIds);
  const modes = new Map<string, ResolvedAiProgramme["payoutMode"]>();
  const decided: DecidedShare[] = [];
  for (const row of rows) {
    const key = `${row.version_id}|${row.override_id ?? ""}|${row.currency_code}`;
    let mode = modes.get(key);
    if (!mode) {
      const values = await readProgrammeValues(
        tx,
        { versionId: row.version_id, overrideId: row.override_id },
        row.currency_code,
      );
      mode = values.payoutMode;
      modes.set(key, mode);
    }
    const to: RevenueShareStatus = mode === "payout" ? "payout_due" : "owed";
    await tx`
      UPDATE app.ai_programme_revenue_share_entries
      SET status = ${to}, updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
      WHERE school_id = current_setting('app.school_id')::uuid AND id = ${row.id}::uuid
    `;
    decided.push({ id: row.id, to, amountMinor: Number(row.amount_minor) });
  }
  await ctx.audit(
    decided.map((share) => ({
      action: "update" as const,
      targetTable: "ai_programme_revenue_share_entries",
      targetId: share.id,
      oldValues: { status: "awaiting_approval" },
      newValues: { status: share.to, approved: true },
    })),
  );
  return decided;
}

/**
 * A super admin rejected these shares, with a reason: each one still awaiting approval is rejected
 * and never credited or paid. Shares no longer awaiting approval are left alone and not returned.
 */
export async function rejectShares(
  tx: TransactionSql,
  ctx: RevenueShareContext,
  entryIds: readonly string[],
  reason: string,
): Promise<DecidedShare[]> {
  const rows = await lockAwaiting(tx, entryIds);
  const decided: DecidedShare[] = [];
  for (const row of rows) {
    await tx`
      UPDATE app.ai_programme_revenue_share_entries
      SET status = 'rejected', rejected_at = ${ctx.now},
          updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
      WHERE school_id = current_setting('app.school_id')::uuid AND id = ${row.id}::uuid
    `;
    decided.push({ id: row.id, to: "rejected", amountMinor: Number(row.amount_minor) });
  }
  await ctx.audit(
    decided.map((share) => ({
      action: "update" as const,
      targetTable: "ai_programme_revenue_share_entries",
      targetId: share.id,
      oldValues: { status: "awaiting_approval" },
      newValues: { status: "rejected", reason },
    })),
  );
  return decided;
}

export interface SettleChange {
  entryId: string;
  from: RevenueShareStatus;
  to: RevenueShareStatus;
  /** The invoice a credited share was taken off. */
  invoiceId: string | null;
  amountMinor: number;
}

/**
 * Forfeit, credit and move to payout what needs no new figures (app.settle_ai_revenue_share, as of
 * the context's day), and audit every change -- the entries, and each invoice a credit went on.
 */
export async function settleRevenueShare(
  tx: TransactionSql,
  ctx: RevenueShareContext,
): Promise<SettleChange[]> {
  const rows = await tx<
    {
      entry_id: string;
      from_status: RevenueShareStatus;
      to_status: RevenueShareStatus;
      invoice_id: string | null;
      amount_minor: string;
    }[]
  >`
    SELECT entry_id::text AS entry_id, from_status, to_status, invoice_id::text AS invoice_id,
           amount_minor::text AS amount_minor
    FROM app.settle_ai_revenue_share(${utcDay(ctx.now)}::date)
  `;
  const changes = rows.map((row) => ({
    entryId: row.entry_id,
    from: row.from_status,
    to: row.to_status,
    invoiceId: row.invoice_id,
    amountMinor: Number(row.amount_minor),
  }));
  if (changes.length === 0) return changes;

  const credits = new Map<string, { amount: number; entries: string[] }>();
  for (const change of changes) {
    if (change.to !== "credited" || !change.invoiceId) continue;
    const credit = credits.get(change.invoiceId) ?? { amount: 0, entries: [] };
    credit.amount += change.amountMinor;
    credit.entries.push(change.entryId);
    credits.set(change.invoiceId, credit);
  }
  const invoices =
    credits.size === 0
      ? []
      : await tx<{ id: string; total_minor: string; status: string; due_date: string }[]>`
          SELECT id::text AS id, total_minor::text AS total_minor, status, due_date::text AS due_date
          FROM app.license_invoices
          WHERE school_id = current_setting('app.school_id')::uuid
            AND id = ANY(${[...credits.keys()]}::uuid[])
        `;
  await ctx.audit([
    ...changes.map((change) => ({
      action: "update" as const,
      targetTable: "ai_programme_revenue_share_entries",
      targetId: change.entryId,
      oldValues: { status: change.from },
      newValues: {
        status: change.to,
        ...(change.invoiceId ? { credit_invoice_id: change.invoiceId } : {}),
        ...(change.to === "forfeited" ? { forfeit_reason: "unpaid_at_cutoff" } : {}),
      },
    })),
    ...invoices.map((invoice) => ({
      action: "update" as const,
      targetTable: "license_invoices",
      targetId: invoice.id,
      // An update's audit row carries what changed from (ck_audit_logs_payload): the total before
      // the credit came off it.
      oldValues: { total_minor: Number(invoice.total_minor) + credits.get(invoice.id)!.amount },
      newValues: {
        ai_share_credit_minor: credits.get(invoice.id)!.amount,
        ai_share_entries: credits.get(invoice.id)!.entries,
        total_minor: Number(invoice.total_minor),
        status: invoice.status,
        due_date: invoice.due_date,
      },
    })),
  ]);
  return changes;
}

export interface RevenueShareTick {
  snapshotsLocked: number;
  sharesResolved: number;
  changes: SettleChange[];
}

/** The workers' hourly pass for one school: lock what is due, work out what waited, settle. */
export async function runRevenueShareTick(
  tx: TransactionSql,
  ctx: RevenueShareContext,
): Promise<RevenueShareTick> {
  const locked = await lockDueConversionSnapshots(tx, ctx);
  const resolved = await resolvePendingShares(tx, ctx);
  const changes = await settleRevenueShare(tx, ctx);
  return { snapshotsLocked: locked.length, sharesResolved: resolved.length, changes };
}
