import {
  insertSnapshot,
  licenceInProgramme,
  measureConversion,
  measurementPeriods,
  periodFor,
  readProgrammeValues,
  recordEarlierPaymentShares,
  resolvePendingShares,
  utcDay,
} from "@studafy/billing";
import { ERROR_CODES } from "@studafy/constants";
import {
  AI_PROGRAMME_LIMITS,
  computeRevenueShare,
  conversionMeasureDay,
} from "@studafy/license-pricing";

import { setTenantScope, withSystemTx } from "../../db/tenant-tx";

import { auditLicenseChange, licenseError } from "./context";
import { settleShares } from "./invoices";
import { revenueShareMeasures, shareContext } from "./revenue-share-context";

import type { LicenseActor } from "./context";
import type { Changed, LicenseRecord } from "./service";
import type { Database, DatabasePools } from "../../db/client";
import type { Logger } from "../../logger";
import type { RecordedShare, RevenueShareStatus } from "@studafy/billing";
import type { LicenseCommitment } from "@studafy/license-pricing";
import type { TransactionSql } from "postgres";

/**
 * The Student AI revenue share in the API (migration 000237, docs/billing/ai-programme.md): the
 * ledger and its totals for the super admin's console and the school's own read, a licence's
 * conversion measurements and the share rate they give, the super admin's re-measure (before the
 * lock), recompute and payout. The engine itself -- measuring, locking, computing a payment's share,
 * settling -- is @studafy/billing's, shared with the workers.
 */

// ---------------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------------

export interface RevenueShareEntryView {
  id: string;
  kind: "share" | "reversal";
  reversesEntryId: string | null;
  licenseId: string;
  invoiceId: string;
  invoiceNumber: string;
  paymentId: string;
  instalmentId: string;
  instalmentPosition: number;
  receivedOn: string;
  periodFrom: string;
  periodTo: string;
  measurementPeriodStart: string;
  currencyCode: string;
  minorUnit: number;
  collectedMinor: number;
  baseMinor: number;
  commitment: LicenseCommitment;
  programmeVersionId: string;
  programmeOverrideId: string | null;
  seats: number | null;
  conversionBps: number | null;
  conversionShareBps: number;
  floorApplied: boolean;
  uploadConsistencyBps: number | null;
  bonusBps: number;
  capped: boolean;
  multiplierBps: number;
  totalBps: number;
  amountMinor: number;
  conversionPending: boolean;
  bonusPending: boolean;
  status: RevenueShareStatus;
  computedAt: string;
  creditInvoiceId: string | null;
  creditInvoiceNumber: string | null;
  creditedAt: string | null;
  payoutId: string | null;
  forfeitedAt: string | null;
  forfeitReason: "late_payment" | "unpaid_at_cutoff" | null;
  voidedAt: string | null;
}

interface EntryRow {
  id: string;
  kind: "share" | "reversal";
  reverses_entry_id: string | null;
  license_id: string;
  invoice_id: string;
  invoice_number: string;
  payment_id: string;
  instalment_id: string;
  instalment_position: number;
  received_on: string;
  period_from: string;
  period_to: string;
  measurement_period_start: string;
  currency_code: string;
  minor_unit: number;
  collected_minor: string;
  base_minor: string;
  commitment: LicenseCommitment;
  version_id: string;
  override_id: string | null;
  seats: number | null;
  conversion_bps: number | null;
  conversion_share_bps: number;
  floor_applied: boolean;
  upload_consistency_bps: number | null;
  bonus_bps: number;
  capped: boolean;
  multiplier_bps: number;
  total_bps: number;
  amount_minor: string;
  conversion_pending: boolean;
  bonus_pending: boolean;
  status: RevenueShareStatus;
  computed_at: Date;
  credit_invoice_id: string | null;
  credit_invoice_number: string | null;
  credited_at: Date | null;
  payout_id: string | null;
  forfeited_at: Date | null;
  forfeit_reason: "late_payment" | "unpaid_at_cutoff" | null;
  voided_at: Date | null;
}

function toEntry(row: EntryRow): RevenueShareEntryView {
  return {
    id: row.id,
    kind: row.kind,
    reversesEntryId: row.reverses_entry_id,
    licenseId: row.license_id,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    paymentId: row.payment_id,
    instalmentId: row.instalment_id,
    instalmentPosition: row.instalment_position,
    receivedOn: row.received_on,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    measurementPeriodStart: row.measurement_period_start,
    currencyCode: row.currency_code,
    minorUnit: row.minor_unit,
    collectedMinor: Number(row.collected_minor),
    baseMinor: Number(row.base_minor),
    commitment: row.commitment,
    programmeVersionId: row.version_id,
    programmeOverrideId: row.override_id,
    seats: row.seats,
    conversionBps: row.conversion_bps,
    conversionShareBps: row.conversion_share_bps,
    floorApplied: row.floor_applied,
    uploadConsistencyBps: row.upload_consistency_bps,
    bonusBps: row.bonus_bps,
    capped: row.capped,
    multiplierBps: row.multiplier_bps,
    totalBps: row.total_bps,
    amountMinor: Number(row.amount_minor),
    conversionPending: row.conversion_pending,
    bonusPending: row.bonus_pending,
    status: row.status,
    computedAt: row.computed_at.toISOString(),
    creditInvoiceId: row.credit_invoice_id,
    creditInvoiceNumber: row.credit_invoice_number,
    creditedAt: row.credited_at?.toISOString() ?? null,
    payoutId: row.payout_id,
    forfeitedAt: row.forfeited_at?.toISOString() ?? null,
    forfeitReason: row.forfeit_reason,
    voidedAt: row.voided_at?.toISOString() ?? null,
  };
}

export interface RevenueShareFilters {
  licenseId?: string;
  status?: RevenueShareStatus;
}

/** The armed school's ledger, newest payment first. */
export async function listRevenueShareEntries(
  tx: TransactionSql,
  filters: RevenueShareFilters = {},
): Promise<RevenueShareEntryView[]> {
  const rows = await tx<EntryRow[]>`
    SELECT e.id::text AS id, e.kind, e.reverses_entry_id::text AS reverses_entry_id,
           e.license_id::text AS license_id, e.invoice_id::text AS invoice_id,
           i.number AS invoice_number, e.payment_id::text AS payment_id,
           e.instalment_id::text AS instalment_id, inst.position AS instalment_position,
           e.received_on::text AS received_on, e.period_from::text AS period_from,
           e.period_to::text AS period_to,
           e.measurement_period_start::text AS measurement_period_start,
           c.code AS currency_code, c.minor_unit::int AS minor_unit,
           e.collected_minor::text AS collected_minor, e.base_minor::text AS base_minor,
           e.commitment, e.ai_programme_version_id::text AS version_id,
           e.ai_programme_override_id::text AS override_id, e.seats, e.conversion_bps,
           e.conversion_share_bps, e.floor_applied, e.upload_consistency_bps, e.bonus_bps,
           e.capped, e.multiplier_bps, e.total_bps, e.amount_minor::text AS amount_minor,
           e.conversion_pending, e.bonus_pending, e.status, e.computed_at,
           e.credit_invoice_id::text AS credit_invoice_id, ci.number AS credit_invoice_number,
           e.credited_at, e.payout_id::text AS payout_id, e.forfeited_at, e.forfeit_reason,
           e.voided_at
    FROM app.ai_programme_revenue_share_entries AS e
    JOIN app.license_invoices AS i ON i.id = e.invoice_id AND i.school_id = e.school_id
    JOIN app.license_invoice_instalments AS inst
      ON inst.id = e.instalment_id AND inst.school_id = e.school_id
    JOIN app.currencies AS c ON c.id = e.currency_id
    LEFT JOIN app.license_invoices AS ci
      ON ci.id = e.credit_invoice_id AND ci.school_id = e.school_id
    WHERE e.school_id = current_setting('app.school_id')::uuid
      ${filters.licenseId ? tx`AND e.license_id = ${filters.licenseId}::uuid` : tx``}
      ${filters.status ? tx`AND e.status = ${filters.status}` : tx``}
    ORDER BY e.received_on DESC, e.created_at DESC, inst.position DESC, e.kind
  `;
  return rows.map(toEntry);
}

export interface RevenueShareTotals {
  currencyCode: string;
  minorUnit: number;
  /** The Student AI part of the money collected, on every share not voided. */
  baseMinor: number;
  /** Provisional: not final yet. */
  pendingMinor: number;
  /** Final, waiting for a super admin's approval on the school's weekly statement. */
  awaitingApprovalMinor: number;
  owedMinor: number;
  creditedMinor: number;
  payoutDueMinor: number;
  paidOutMinor: number;
  forfeitedMinor: number;
  /** Rejected by a super admin: never given. */
  rejectedMinor: number;
  /** What the school has earned so far (approved): credited + paid out + owed + payout due. */
  earnedMinor: number;
}

/** Totals per currency, from the ledger. A reversal nets against the status it sits in. */
export function revenueShareTotals(
  entries: readonly RevenueShareEntryView[],
): RevenueShareTotals[] {
  const totals = new Map<string, RevenueShareTotals>();
  for (const entry of entries) {
    const t = totals.get(entry.currencyCode) ?? {
      currencyCode: entry.currencyCode,
      minorUnit: entry.minorUnit,
      baseMinor: 0,
      pendingMinor: 0,
      awaitingApprovalMinor: 0,
      owedMinor: 0,
      creditedMinor: 0,
      payoutDueMinor: 0,
      paidOutMinor: 0,
      forfeitedMinor: 0,
      rejectedMinor: 0,
      earnedMinor: 0,
    };
    if (entry.status !== "void") t.baseMinor += entry.baseMinor;
    const amount = entry.amountMinor;
    if (entry.status === "pending") t.pendingMinor += amount;
    if (entry.status === "awaiting_approval") t.awaitingApprovalMinor += amount;
    if (entry.status === "owed") t.owedMinor += amount;
    if (entry.status === "credited") t.creditedMinor += amount;
    if (entry.status === "payout_due") t.payoutDueMinor += amount;
    if (entry.status === "paid_out") t.paidOutMinor += amount;
    if (entry.status === "forfeited") t.forfeitedMinor += amount;
    if (entry.status === "rejected") t.rejectedMinor += amount;
    t.earnedMinor = t.owedMinor + t.creditedMinor + t.payoutDueMinor + t.paidOutMinor;
    totals.set(entry.currencyCode, t);
  }
  return [...totals.values()].sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
}

export interface PayoutView {
  id: string;
  currencyCode: string;
  amountMinor: number;
  reference: string;
  paidOn: string;
  note: string | null;
  recordedBy: string;
  createdAt: string;
}

export async function listPayouts(tx: TransactionSql): Promise<PayoutView[]> {
  const rows = await tx<
    {
      id: string;
      currency_code: string;
      amount_minor: string;
      reference: string;
      paid_on: string;
      note: string | null;
      recorded_by: string;
      created_at: Date;
    }[]
  >`
    SELECT p.id::text AS id, c.code AS currency_code, p.amount_minor::text AS amount_minor,
           p.reference, p.paid_on::text AS paid_on, p.note, p.recorded_by::text AS recorded_by,
           p.created_at
    FROM app.ai_programme_revenue_share_payouts AS p
    JOIN app.currencies AS c ON c.id = p.currency_id
    WHERE p.school_id = current_setting('app.school_id')::uuid
    ORDER BY p.paid_on DESC, p.created_at DESC
  `;
  return rows.map((row) => ({
    id: row.id,
    currencyCode: row.currency_code,
    amountMinor: Number(row.amount_minor),
    reference: row.reference,
    paidOn: row.paid_on,
    note: row.note,
    recordedBy: row.recorded_by,
    createdAt: row.created_at.toISOString(),
  }));
}

export interface SchoolRevenueShareView {
  totals: RevenueShareTotals[];
  entries: RevenueShareEntryView[];
  payouts: PayoutView[];
}

/** The armed school's revenue share: its ledger, totals and payouts (one licence's, when given). */
export async function schoolRevenueShare(
  tx: TransactionSql,
  filters: RevenueShareFilters = {},
): Promise<SchoolRevenueShareView> {
  const entries = await listRevenueShareEntries(tx, filters);
  return {
    totals: revenueShareTotals(entries),
    entries,
    payouts: await listPayouts(tx),
  };
}

export interface SnapshotView {
  id: string;
  periodStart: string;
  measureOn: string;
  asOf: string;
  enrolledCount: number;
  optedInCount: number;
  conversionBps: number;
  seats: number;
  conversionShareBps: number;
  floorApplied: boolean;
  locked: boolean;
  source: "scheduled" | "super_admin";
  reason: string | null;
  measuredBy: string | null;
  measuredAt: string;
}

async function licenceSnapshots(tx: TransactionSql, licenseId: string): Promise<SnapshotView[]> {
  const rows = await tx<
    {
      id: string;
      period_start: string;
      measure_on: string;
      as_of: string;
      enrolled_count: number;
      opted_in_count: number;
      conversion_bps: number;
      seats: number;
      conversion_share_bps: number;
      floor_applied: boolean;
      locked: boolean;
      source: "scheduled" | "super_admin";
      reason: string | null;
      measured_by: string | null;
      measured_at: Date;
    }[]
  >`
    SELECT id::text AS id, period_start::text AS period_start, measure_on::text AS measure_on,
           as_of::text AS as_of, enrolled_count, opted_in_count, conversion_bps, seats,
           conversion_share_bps, floor_applied, locked, source, reason,
           measured_by::text AS measured_by, measured_at
    FROM app.ai_programme_conversion_snapshots
    WHERE school_id = current_setting('app.school_id')::uuid AND license_id = ${licenseId}::uuid
    ORDER BY period_start DESC, measured_at DESC
  `;
  return rows.map((row) => ({
    id: row.id,
    periodStart: row.period_start,
    measureOn: row.measure_on,
    asOf: row.as_of,
    enrolledCount: row.enrolled_count,
    optedInCount: row.opted_in_count,
    conversionBps: row.conversion_bps,
    seats: row.seats,
    conversionShareBps: row.conversion_share_bps,
    floorApplied: row.floor_applied,
    locked: row.locked,
    source: row.source,
    reason: row.reason,
    measuredBy: row.measured_by,
    measuredAt: row.measured_at.toISOString(),
  }));
}

export interface MeasurementPeriodView {
  periodStart: string;
  measureOn: string;
  /** The locked measurement, once the measurement day has come. */
  locked: SnapshotView | null;
  /** Every measurement of the period, newest first (re-measures before the lock, and the lock). */
  measurements: SnapshotView[];
}

export interface LicenseRevenueShareView {
  licenseId: string;
  currencyCode: string;
  commitment: LicenseCommitment;
  periods: MeasurementPeriodView[];
  /**
   * The share a payment recorded today would get (before the content bonus, which depends on the
   * days it pays for): the current period's locked conversion, else its latest re-measure
   * (provisional), else none (pending).
   */
  rate: {
    periodStart: string;
    conversionSource: "locked" | "provisional" | "none";
    conversionBps: number | null;
    conversionShareBps: number;
    floorApplied: boolean;
    multiplierBps: number;
    maxShareBps: number;
    payoutMode: "invoice_credit" | "payout";
  };
  totals: RevenueShareTotals[];
  entries: RevenueShareEntryView[];
}

/** One licence's revenue share: its measurement periods, the rate in force, its ledger. */
export async function licenseRevenueShare(
  tx: TransactionSql,
  license: LicenseRecord,
  now: Date = new Date(),
): Promise<LicenseRevenueShareView> {
  const values = await readProgrammeValues(
    tx,
    { versionId: license.aiProgrammeVersionId, overrideId: license.aiProgrammeOverrideId },
    license.currencyCode,
  );
  const commitment = await revenueShareMeasures().licenceCommitment(
    tx,
    license.schoolId,
    license.id,
  );
  const snapshots = await licenceSnapshots(tx, license.id);
  const periods = (await measurementPeriods(tx, license.id)).map((periodStart) => {
    const measurements = snapshots.filter((s) => s.periodStart === periodStart);
    return {
      periodStart,
      measureOn: conversionMeasureDay(periodStart, license.startsAt.toISOString()),
      locked: measurements.find((s) => s.locked) ?? null,
      measurements,
    };
  });
  const current = periodFor(
    periods.map((p) => p.periodStart),
    utcDay(now),
  );
  const period = periods.find((p) => p.periodStart === current)!;
  const source = period.locked ?? period.measurements[0] ?? null;
  const preview = computeRevenueShare(values, {
    conversionBps: source?.conversionBps ?? null,
    uploadConsistencyBps: 0,
    seats: source?.seats ?? license.studentSeats,
    commitment,
    baseMinor: 0,
  });
  const entries = await listRevenueShareEntries(tx, { licenseId: license.id });
  return {
    licenseId: license.id,
    currencyCode: license.currencyCode,
    commitment,
    periods: periods.reverse(),
    rate: {
      periodStart: current,
      conversionSource: period.locked ? "locked" : source ? "provisional" : "none",
      conversionBps: source?.conversionBps ?? null,
      conversionShareBps: preview.conversionShareBps,
      floorApplied: preview.floorApplied,
      multiplierBps: preview.multiplierBps,
      maxShareBps: values.maxShareBps,
      payoutMode: values.payoutMode,
    },
    totals: revenueShareTotals(entries),
    entries,
  };
}

// ---------------------------------------------------------------------------------------------------
// The super admin's changes
// ---------------------------------------------------------------------------------------------------

export function requireReason(reason: string | null | undefined, actor: LicenseActor): string {
  const trimmed = (reason ?? "").trim();
  if (trimmed === "" || trimmed.length > AI_PROGRAMME_LIMITS.reasonMaxLength) {
    throw licenseError(422, ERROR_CODES.AI_PROGRAMME_REASON_REQUIRED, actor.locale);
  }
  return trimmed;
}

/**
 * Measure a licence period's conversion again, now, with a reason (audited) -- only before the
 * period's measurement is locked (409 AI_REVENUE_SHARE_CONVERSION_LOCKED after). The period is the
 * one today falls in unless `periodStart` names another of the licence's periods.
 */
export async function remeasureConversion(
  tx: TransactionSql,
  schoolId: string,
  license: LicenseRecord,
  input: { reason: string; periodStart?: string | null },
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<LicenseRevenueShareView> {
  const reason = requireReason(input.reason, actor);
  const periods = await measurementPeriods(tx, license.id);
  const periodStart = input.periodStart ?? periodFor(periods, utcDay(now));
  if (!periods.includes(periodStart)) {
    throw licenseError(422, ERROR_CODES.VALIDATION_FAILED, actor.locale);
  }
  const [locked] = await tx<{ id: string }[]>`
    SELECT id::text AS id FROM app.ai_programme_conversion_snapshots
    WHERE school_id = current_setting('app.school_id')::uuid AND license_id = ${license.id}::uuid
      AND period_start = ${periodStart}::date AND locked
  `;
  if (locked) throw licenseError(409, ERROR_CODES.AI_REVENUE_SHARE_CONVERSION_LOCKED, actor.locale);
  const ctx = shareContext(tx, schoolId, actor, now);
  const measurement = await measureConversion(tx, ctx, license.id, periodStart, utcDay(now));
  await insertSnapshot(tx, ctx, measurement, {
    source: "super_admin",
    reason,
    measuredBy: actor.userId,
  });
  return licenseRevenueShare(tx, license, now);
}

/**
 * Work the school's pending shares out again and settle (forfeit, credit, payout due): what the
 * workers do every hour, on demand. Every change is audited.
 */
export async function recomputeRevenueShare(
  tx: TransactionSql,
  schoolId: string,
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<Changed<{ recorded: number; resolved: number; settled: number }>> {
  const ctx = shareContext(tx, schoolId, actor, now);
  // A payment recorded before its licence entered the programme, whose entries were not recorded
  // when it did (the after-commit step failed, or it entered another way): recorded now.
  let recorded = 0;
  for (const licenseId of await programmeLicenceIds(tx)) {
    recorded += (await recordEarlierPaymentShares(tx, ctx, licenseId)).length;
  }
  const resolved = await resolvePendingShares(tx, ctx);
  const settled = await settleSharesCounted(tx, schoolId, actor, now);
  return {
    result: { recorded, resolved: resolved.length, settled: settled.count },
    versions: settled.versions,
    pending: settled.pending,
  };
}

/** The armed school's licences that can still earn and are in the Student AI programme. */
async function programmeLicenceIds(tx: TransactionSql): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    SELECT l.id::text AS id
    FROM app.school_licenses AS l
    WHERE l.school_id = current_setting('app.school_id')::uuid
      AND l.status IN ('awaiting_payment', 'active', 'suspended')
    ORDER BY l.starts_at, l.id
  `;
  const ids: string[] = [];
  for (const row of rows) if (await licenceInProgramme(tx, row.id)) ids.push(row.id);
  return ids;
}

/**
 * Once a licence has entered the programme (the school opened its first opt-in window), record the
 * revenue share of the payments recorded on it this period before it did
 * (`recordEarlierPaymentShares`: new entries only, idempotent). Run after the window's transaction
 * commits, in a system transaction armed for the school with the acting user (the ledger is written
 * by the system role, never the school's). Best effort: the window stands, and a failure is logged
 * at error level -- the super admin's recompute records what is missing.
 */
export async function recordEarlierSharesAfterCommit(
  database: Database | DatabasePools,
  actor: LicenseActor,
  licenseId: string,
  log: Pick<Logger, "error">,
  now: Date = new Date(),
): Promise<RecordedShare[]> {
  try {
    return await withSystemTx(database, async (tx) => {
      await setTenantScope(tx, actor.homeSchoolId, actor.requestId);
      await tx`SELECT set_config('app.user_id', ${actor.userId}, true)`;
      return recordEarlierPaymentShares(
        tx,
        shareContext(tx, actor.homeSchoolId, actor, now),
        licenseId,
      );
    });
  } catch (err) {
    log.error(
      { err, school_id: actor.homeSchoolId, license_id: licenseId },
      "ai revenue share: recording the shares of earlier payments failed; the console's recompute records them",
    );
    return [];
  }
}

async function settleSharesCounted(
  tx: TransactionSql,
  schoolId: string,
  actor: LicenseActor,
  now: Date,
): Promise<Omit<Changed<unknown>, "result"> & { count: number }> {
  const [before] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.ai_programme_revenue_share_entries
    WHERE school_id = current_setting('app.school_id')::uuid AND status IN ('owed', 'pending')
  `;
  const settled = await settleShares(tx, schoolId, actor, now);
  const [after] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.ai_programme_revenue_share_entries
    WHERE school_id = current_setting('app.school_id')::uuid AND status IN ('owed', 'pending')
  `;
  return { ...settled, count: before!.count - after!.count };
}

export interface RecordPayoutInput {
  currencyCode: string;
  /** The amount the super admin saw due; refused when it has changed since. */
  amountMinor: number;
  reference: string;
  paidOn: string;
  note?: string | null;
}

/**
 * Record a payout of every share due to be paid out in a currency (net of reversals), with the
 * transfer's reference: those entries become paid_out. 409 AI_REVENUE_SHARE_NOTHING_DUE when nothing
 * is due; 409 AI_REVENUE_SHARE_PAYOUT_CHANGED when the amount due is not `amountMinor`.
 */
export async function recordRevenueSharePayout(
  tx: TransactionSql,
  schoolId: string,
  input: RecordPayoutInput,
  actor: LicenseActor,
): Promise<PayoutView> {
  const due = await tx<{ id: string; amount_minor: string; currency_id: string }[]>`
    SELECT e.id::text AS id, e.amount_minor::text AS amount_minor, e.currency_id::text AS currency_id
    FROM app.ai_programme_revenue_share_entries AS e
    JOIN app.currencies AS c ON c.id = e.currency_id
    WHERE e.school_id = current_setting('app.school_id')::uuid
      AND e.status = 'payout_due' AND c.code = ${input.currencyCode}
    ORDER BY e.computed_at, e.id
    FOR UPDATE OF e
  `;
  const net = due.reduce((sum, entry) => sum + Number(entry.amount_minor), 0);
  if (due.length === 0 || net <= 0) {
    throw licenseError(409, ERROR_CODES.AI_REVENUE_SHARE_NOTHING_DUE, actor.locale);
  }
  if (net !== input.amountMinor) {
    throw licenseError(409, ERROR_CODES.AI_REVENUE_SHARE_PAYOUT_CHANGED, actor.locale);
  }
  const reference = input.reference.trim();
  const note = input.note?.trim() || null;
  const [payout] = await tx<{ id: string }[]>`
    INSERT INTO app.ai_programme_revenue_share_payouts (
      school_id, currency_id, amount_minor, reference, paid_on, note, recorded_by
    ) VALUES (
      ${schoolId}::uuid, ${due[0]!.currency_id}::uuid, ${net}, ${reference},
      ${input.paidOn}::date, ${note}, ${actor.userId}::uuid
    )
    RETURNING id::text AS id
  `;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "insert",
    targetTable: "ai_programme_revenue_share_payouts",
    targetId: payout!.id,
    newValues: {
      currency_code: input.currencyCode,
      amount_minor: net,
      reference,
      paid_on: input.paidOn,
      entries: due.map((entry) => entry.id),
    },
  });
  await tx`
    UPDATE app.ai_programme_revenue_share_entries
    SET status = 'paid_out', payout_id = ${payout!.id}::uuid,
        updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid
      AND id = ANY(${due.map((entry) => entry.id)}::uuid[])
  `;
  for (const entry of due) {
    await auditLicenseChange(tx, schoolId, actor, {
      action: "update",
      targetTable: "ai_programme_revenue_share_entries",
      targetId: entry.id,
      oldValues: { status: "payout_due" },
      newValues: { status: "paid_out", payout_id: payout!.id },
    });
  }
  return (await listPayouts(tx)).find((p) => p.id === payout!.id)!;
}
