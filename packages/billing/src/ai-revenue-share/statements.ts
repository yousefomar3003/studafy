import { computeRevenueShare, monthEnd, monthIndex, monthStart } from "@studafy/license-pricing";

import { lockedSnapshot, readLicence, utcDay } from "./engine";
import { REVENUE_SHARE_MEASURES } from "./measures";
import { readProgrammeValues } from "./programme";

import type { RevenueShareContext } from "./engine";
import type { TransactionSql } from "postgres";

/**
 * Collected Student AI months and the weekly statements (migration 000251, owner's rules of
 * 2026-11-18, docs/billing/ai-programme.md "Weekly statements"). Shared by the workers (the hourly
 * detector, the Monday statements) and the API (the console's recompute).
 *
 * Every function runs in the caller's transaction, scoped to the school (app.school_id), as
 * studafy_admin, and hands each change to `ctx.audit`.
 */

const measuresOf = (ctx: RevenueShareContext) => ctx.measures ?? REVENUE_SHARE_MEASURES;

/** ERPNext statuses of a sales invoice that is not (or no longer) money the school collected. */
const NOT_COLLECTED_STATUSES = ["Cancelled", "Draft", "Return", "Credit Note Issued"];

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The Monday of the week (Mon-Sun, UTC) a day falls in. */
export function weekStartOf(day: string): string {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number) as [number, number, number];
  const isoDow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
  return addDays(day.slice(0, 10), 1 - isoDow);
}

// ---------------------------------------------------------------------------------------------------
// Collected months
// ---------------------------------------------------------------------------------------------------

export interface CollectedMonths {
  recorded: number;
  voided: number;
}

/**
 * Record the Student AI months the school has collected from parents: every month of a tuition
 * portion billed through Studafy (auto-billing) whose ERPNext invoice is paid in full -- a part
 * payment is not enough: Studafy cannot tell which fees it paid. One row per student and month,
 * priced at what the school owes Studafy for it (the licence's programme seat price, in the
 * licence's currency). A month already recorded is left alone. A month not yet on a statement whose
 * invoice was cancelled or returned since is void. Idempotent.
 */
export async function recordCollectedStudentAiMonths(
  tx: TransactionSql,
  ctx: RevenueShareContext,
): Promise<CollectedMonths> {
  const portions = await tx<
    {
      portion_id: string;
      student_id: string;
      first_month: string;
      month_count: number;
      academic_year_id: string;
      license_id: string;
    }[]
  >`
    SELECT p.id::text AS portion_id, p.student_id::text AS student_id,
           p.first_month::text AS first_month, p.month_count,
           i.academic_year_id::text AS academic_year_id, i.license_id::text AS license_id
    FROM app.student_ai_fee_portions AS p
    JOIN app.student_ai_fee_items AS i ON i.id = p.item_id AND i.school_id = p.school_id
    JOIN app.invoice_cache AS ic
      ON ic.school_id = p.school_id AND ic.erpnext_docname = p.erpnext_invoice_docname
    WHERE p.school_id = current_setting('app.school_id')::uuid
      AND p.status = 'invoiced' AND i.billing = 'auto'
      AND ic.total_amount_minor > 0 AND ic.outstanding_amount_minor = 0
      AND ic.erpnext_status <> ALL(${NOT_COLLECTED_STATUSES}::text[])
      AND (SELECT count(*) FROM app.student_ai_months AS m
           WHERE m.school_id = p.school_id AND m.portion_id = p.id) < p.month_count
    ORDER BY p.first_month, p.id
  `;
  const collectedOn = utcDay(ctx.now);
  const prices = new Map<string, { currencyId: string; priceMinor: number } | null>();
  let recorded = 0;
  for (const portion of portions) {
    const [optIn] = await tx<{ id: string }[]>`
      SELECT id::text AS id FROM app.ai_optins
      WHERE school_id = current_setting('app.school_id')::uuid
        AND student_id = ${portion.student_id}::uuid
        AND academic_year_id = ${portion.academic_year_id}::uuid
      ORDER BY (status = 'active') DESC, opted_in_at DESC
      LIMIT 1
    `;
    if (!optIn) continue;
    if (!prices.has(portion.license_id)) {
      const licence = await readLicence(tx, portion.license_id);
      // No licence, or no programme price in its currency: the month cannot be priced yet.
      const priceMinor = licence
        ? (await readProgrammeValues(tx, licence.stamp, licence.currencyCode)).licensePriceMinor
        : null;
      prices.set(
        portion.license_id,
        licence && priceMinor !== null ? { currencyId: licence.currencyId, priceMinor } : null,
      );
    }
    const price = prices.get(portion.license_id);
    if (!price) continue;
    const first = monthIndex(portion.first_month);
    for (let index = first; index < first + portion.month_count; index += 1) {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.student_ai_months (
          school_id, student_id, optin_id, license_id, month, portion_id, currency_id,
          price_minor, collected_on
        ) VALUES (
          ${ctx.schoolId}::uuid, ${portion.student_id}::uuid, ${optIn.id}::uuid,
          ${portion.license_id}::uuid, ${monthStart(index)}::date, ${portion.portion_id}::uuid,
          ${price.currencyId}::uuid, ${price.priceMinor}, ${collectedOn}::date
        )
        ON CONFLICT (school_id, student_id, month) DO NOTHING
        RETURNING id::text AS id
      `;
      if (!row) continue;
      recorded += 1;
      await ctx.audit([
        {
          action: "insert",
          targetTable: "student_ai_months",
          targetId: row.id,
          oldValues: null,
          newValues: {
            student_id: portion.student_id,
            optin_id: optIn.id,
            license_id: portion.license_id,
            month: monthStart(index),
            portion_id: portion.portion_id,
            price_minor: price.priceMinor,
            collected_on: collectedOn,
          },
        },
      ]);
    }
  }

  const voided = await tx<{ id: string }[]>`
    UPDATE app.student_ai_months AS m
    SET status = 'void', voided_at = ${ctx.now}, updated_at = GREATEST(CURRENT_TIMESTAMP, m.updated_at)
    FROM app.student_ai_fee_portions AS p
    JOIN app.invoice_cache AS ic
      ON ic.school_id = p.school_id AND ic.erpnext_docname = p.erpnext_invoice_docname
    WHERE m.school_id = current_setting('app.school_id')::uuid
      AND p.school_id = m.school_id AND p.id = m.portion_id
      AND m.status = 'collected' AND m.statement_id IS NULL
      AND ic.erpnext_status = ANY(${NOT_COLLECTED_STATUSES}::text[])
    RETURNING m.id::text AS id
  `;
  await ctx.audit(
    voided.map((row) => ({
      action: "update" as const,
      targetTable: "student_ai_months",
      targetId: row.id,
      oldValues: { status: "collected" },
      newValues: { status: "void", reason: "tuition_invoice_cancelled" },
    })),
  );
  return { recorded, voided: voided.length };
}

// ---------------------------------------------------------------------------------------------------
// Weekly statements
// ---------------------------------------------------------------------------------------------------

export interface WeeklyStatementRecord {
  id: string;
  weekStart: string;
  weekEnd: string;
  currencyId: string;
  monthsCount: number;
  grossMinor: number;
  shareMinor: number;
  netMinor: number;
  licenceShareCount: number;
  licenceShareMinor: number;
}

interface MonthRow {
  id: string;
  license_id: string;
  currency_id: string;
  price_minor: string;
  collected_on: string;
}

/**
 * The share on one collected month: the conversion of the month it was collected in (its locked
 * snapshot) and the upload bonus of the month before, capped, times the month-to-month multiplier
 * -- all from the licence's programme values. Null while a part is not known yet (the month's
 * conversion not locked, the previous month's uploads not measured): it waits for a later statement.
 */
async function monthShare(
  tx: TransactionSql,
  ctx: RevenueShareContext,
  month: MonthRow,
): Promise<{ bps: number; minor: number } | null> {
  const licence = await readLicence(tx, month.license_id);
  if (!licence) return null;
  const collectedIn = monthIndex(month.collected_on);
  const snapshot = await lockedSnapshot(tx, licence.id, monthStart(collectedIn));
  if (!snapshot) return null;
  const upload = await measuresOf(ctx).uploadConsistencyForPeriod(tx, {
    schoolId: ctx.schoolId,
    licenseId: licence.id,
    from: monthStart(collectedIn - 1),
    to: monthEnd(collectedIn - 1),
  });
  if (upload === null) return null;
  const values = await readProgrammeValues(tx, licence.stamp, licence.currencyCode);
  const commitment = await measuresOf(ctx).licenceCommitment(tx, ctx.schoolId, licence.id);
  const result = computeRevenueShare(values, {
    conversionBps: snapshot.conversionBps,
    uploadConsistencyBps: upload,
    seats: snapshot.seats,
    commitment,
    baseMinor: Number(month.price_minor),
  });
  return { bps: result.totalBps, minor: result.amountMinor };
}

/**
 * The school's statements for the week starting `weekStart` (a Monday), one per currency: the
 * student-months collected before the week ended and not on a statement yet, each with its share,
 * and the licence shares that became final before the week ended and are not on one yet. A month
 * whose share is not known yet waits for a later week. Idempotent: a week already stated gets
 * nothing more (what is left waits for the next one).
 */
export async function buildWeeklyStatements(
  tx: TransactionSql,
  ctx: RevenueShareContext,
  weekStart: string,
): Promise<WeeklyStatementRecord[]> {
  if (weekStartOf(weekStart) !== weekStart) throw new RangeError(`${weekStart} is not a Monday`);
  const weekEnd = addDays(weekStart, 6);
  const cutoff = addDays(weekStart, 7);

  const months = await tx<MonthRow[]>`
    SELECT id::text AS id, license_id::text AS license_id, currency_id::text AS currency_id,
           price_minor::text AS price_minor, collected_on::text AS collected_on
    FROM app.student_ai_months
    WHERE school_id = current_setting('app.school_id')::uuid
      AND status = 'collected' AND statement_id IS NULL AND collected_on < ${cutoff}::date
    ORDER BY collected_on, id
    FOR UPDATE
  `;
  const shares = await tx<{ id: string; currency_id: string; amount_minor: string }[]>`
    SELECT id::text AS id, currency_id::text AS currency_id, amount_minor::text AS amount_minor
    FROM app.ai_programme_revenue_share_entries
    WHERE school_id = current_setting('app.school_id')::uuid
      AND status = 'awaiting_approval' AND statement_id IS NULL
      AND final_at < (${cutoff}::date::timestamp AT TIME ZONE 'UTC')
    ORDER BY final_at, id
    FOR UPDATE
  `;

  interface Group {
    months: { id: string; price: number; bps: number; share: number }[];
    shares: { id: string; amount: number }[];
  }
  const groups = new Map<string, Group>();
  const groupOf = (currencyId: string) => {
    const group = groups.get(currencyId) ?? { months: [], shares: [] };
    groups.set(currencyId, group);
    return group;
  };
  for (const month of months) {
    const share = await monthShare(tx, ctx, month);
    if (!share) continue;
    groupOf(month.currency_id).months.push({
      id: month.id,
      price: Number(month.price_minor),
      bps: share.bps,
      share: share.minor,
    });
  }
  for (const share of shares) {
    groupOf(share.currency_id).shares.push({ id: share.id, amount: Number(share.amount_minor) });
  }

  const built: WeeklyStatementRecord[] = [];
  for (const [currencyId, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.months.length === 0 && group.shares.length === 0) continue;
    const gross = group.months.reduce((sum, m) => sum + m.price, 0);
    const share = group.months.reduce((sum, m) => sum + m.share, 0);
    const licenceShare = group.shares.reduce((sum, s) => sum + s.amount, 0);
    const [statement] = await tx<{ id: string }[]>`
      INSERT INTO app.ai_programme_weekly_statements (
        school_id, week_start, week_end, currency_id, months_count, gross_minor, share_minor,
        net_minor, licence_share_count, licence_share_minor
      ) VALUES (
        ${ctx.schoolId}::uuid, ${weekStart}::date, ${weekEnd}::date, ${currencyId}::uuid,
        ${group.months.length}, ${gross}, ${share}, ${gross - share}, ${group.shares.length},
        ${licenceShare}
      )
      ON CONFLICT (school_id, week_start, currency_id) DO NOTHING
      RETURNING id::text AS id
    `;
    if (!statement) continue;
    for (const month of group.months) {
      await tx`
        UPDATE app.student_ai_months
        SET statement_id = ${statement.id}::uuid, share_bps = ${month.bps},
            share_minor = ${month.share}, updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
        WHERE school_id = current_setting('app.school_id')::uuid AND id = ${month.id}::uuid
      `;
    }
    if (group.shares.length > 0) {
      await tx`
        UPDATE app.ai_programme_revenue_share_entries
        SET statement_id = ${statement.id}::uuid, updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
        WHERE school_id = current_setting('app.school_id')::uuid
          AND id = ANY(${group.shares.map((s) => s.id)}::uuid[])
      `;
    }
    const record: WeeklyStatementRecord = {
      id: statement.id,
      weekStart,
      weekEnd,
      currencyId,
      monthsCount: group.months.length,
      grossMinor: gross,
      shareMinor: share,
      netMinor: gross - share,
      licenceShareCount: group.shares.length,
      licenceShareMinor: licenceShare,
    };
    await ctx.audit([
      {
        action: "insert",
        targetTable: "ai_programme_weekly_statements",
        targetId: statement.id,
        oldValues: null,
        newValues: {
          week_start: weekStart,
          currency_id: currencyId,
          months_count: record.monthsCount,
          gross_minor: gross,
          share_minor: share,
          net_minor: gross - share,
          licence_share_count: record.licenceShareCount,
          licence_share_minor: licenceShare,
          student_ai_months: group.months.map((m) => m.id),
          revenue_share_entries: group.shares.map((s) => s.id),
        },
      },
    ]);
    built.push(record);
  }
  return built;
}
