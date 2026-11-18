/**
 * The Student AI line on tuition (phase 3 of the AI revenue-share programme, migration 000238,
 * docs/billing/student-ai-tuition-line.md).
 *
 * For every opted-in student there is one item per academic year: the parent price per month (the
 * price on the phase 2 opt-in, what the parent agreed to, in its currency) times the months charged.
 * With auto-billing on, the item is spread over the student's tuition instalments as planned
 * portions (./plan.ts); the billing worker puts a planned portion on the first Sales Invoice it
 * generates for the student due on or after the portion's due date, which freezes it. With
 * auto-billing off nothing is planned and the school bills the line itself; the parent sees the
 * same line either way, "paid with tuition".
 *
 * `syncStudentAiFeeItems` is the single entry point that brings a student's items and planned
 * portions to the state their opt-ins call for. It is idempotent: it can run any number of times,
 * after any event, and changes nothing when nothing changed. It never touches an invoiced portion
 * (the database refuses too), so a released seat stops future, unbilled charges only; refunds are
 * between the school and the parent, outside Studafy.
 *
 * Every function here runs in a transaction armed for the school that can read its licences,
 * students and instalments and write these tables: `withStudentAiTx` (the API) or the workers'
 * system tenant transaction.
 */

import { setTenantScope, withSystemTx } from "../../../db/tenant-tx";
import { schoolToday } from "../../../lib/school-today";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { formatMinorUnits } from "../currency";

import { listStudentAiOptIns } from "./opt-ins";
import {
  academicYearMonths,
  allocatePortions,
  chargedMonths,
  monthIndex,
  monthKey,
  monthStart,
  portionMonths,
  portionsFingerprint,
} from "./plan";

import type { StudentAiOptIn, StudentAiOptInStatus } from "./opt-ins";
import type { MonthIndex, PortionPlan } from "./plan";
import type { Database, DatabasePools } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { PendingQuery, Row, TransactionSql } from "postgres";

export type StudentAiBilling = "auto" | "outside";

export type StudentAiSyncAction =
  "created" | "updated" | "unchanged" | "removed" | "skipped_no_price" | "skipped_no_months";

export interface StudentAiSyncItemResult {
  academicYearId: string;
  itemId: string | null;
  action: StudentAiSyncAction;
  months: number;
  totalMinor: number;
  plannedPortions: number;
}

export interface StudentAiSyncResult {
  studentId: string;
  items: StudentAiSyncItemResult[];
}

export interface StudentAiBillingSettings {
  auto_billing: boolean;
  /** "2026-11": the first month billed through Studafy after it was last switched back on. */
  auto_billing_since: string | null;
  updated_at: string | null;
}

/** A system transaction armed for the school, with the acting user for the audit trail. */
export function withStudentAiTx<T>(
  database: Database | DatabasePools,
  actor: { schoolId: string; userId?: string; requestId?: string },
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return withSystemTx(database, async (tx) => {
    await setTenantScope(tx, actor.schoolId, actor.requestId);
    if (actor.userId) await tx`SELECT set_config('app.user_id', ${actor.userId}, true)`;
    return fn(tx);
  });
}

// ---------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------

interface SettingsRow {
  auto_billing: boolean;
  auto_billing_since: string | null;
  updated_at: Date | null;
}

async function readSettings(tx: TransactionSql, schoolId: string): Promise<SettingsRow> {
  const [row] = await tx<SettingsRow[]>`
    SELECT auto_billing, auto_billing_since::text AS auto_billing_since, updated_at
    FROM app.student_ai_billing_settings
    WHERE school_id = ${schoolId}::uuid
  `;
  return row ?? { auto_billing: true, auto_billing_since: null, updated_at: null };
}

export async function getStudentAiBillingSettings(
  tx: TransactionSql,
  schoolId: string,
): Promise<StudentAiBillingSettings> {
  const row = await readSettings(tx, schoolId);
  return {
    auto_billing: row.auto_billing,
    auto_billing_since: row.auto_billing_since ? row.auto_billing_since.slice(0, 7) : null,
    updated_at: row.updated_at ? row.updated_at.toISOString() : null,
  };
}

/**
 * Switch auto-billing on or off, then reconcile every student of the school in the same
 * transaction. Only portions not yet on an invoice change: switching off removes them (the school
 * bills the rest itself); switching back on plans the months from the current month on, so months
 * the school billed while it was off are never billed twice.
 */
export async function setStudentAiAutoBilling(
  tx: TransactionSql,
  schoolId: string,
  userId: string | null,
  autoBilling: boolean,
): Promise<{ settings: StudentAiBillingSettings; results: StudentAiSyncResult[] }> {
  const before = await readSettings(tx, schoolId);
  if (before.auto_billing !== autoBilling || before.updated_at === null) {
    const turningOn = autoBilling && !before.auto_billing;
    await tx`
      INSERT INTO app.student_ai_billing_settings (school_id, auto_billing, auto_billing_since, updated_by)
      VALUES (
        ${schoolId}::uuid,
        ${autoBilling},
        ${turningOn ? tx`date_trunc('month', app.school_today())::date` : tx`NULL::date`},
        ${userId}::uuid
      )
      ON CONFLICT (school_id) DO UPDATE
        SET auto_billing = EXCLUDED.auto_billing,
            auto_billing_since = CASE WHEN ${turningOn}
                                      THEN EXCLUDED.auto_billing_since
                                      ELSE app.student_ai_billing_settings.auto_billing_since END,
            updated_by = EXCLUDED.updated_by,
            updated_at = CURRENT_TIMESTAMP
    `;
    await emitAuditLog(tx, {
      action: before.updated_at === null ? "insert" : "update",
      targetTable: "student_ai_billing_settings",
      targetId: schoolId,
      oldValues: before.updated_at === null ? null : { auto_billing: before.auto_billing },
      newValues: { auto_billing: autoBilling },
    });
  }
  const results = await syncSchoolStudentAiFeeItems(tx, schoolId);
  return { settings: await getStudentAiBillingSettings(tx, schoolId), results };
}

// ---------------------------------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------------------------------

interface ItemRow {
  id: string;
  academic_year_id: string;
  license_id: string;
  currency_id: string;
  monthly_price_minor: string;
  start_month: string;
  end_month: string;
  stop_month: string | null;
  months: number;
  total_minor: string;
  status: StudentAiOptInStatus;
  billing: StudentAiBilling;
}

interface PortionRow {
  id: string;
  item_id: string;
  due_date: string;
  first_month: string;
  month_count: number;
  amount_minor: string;
  status: "planned" | "invoiced";
}

/** Of a student's opt-ins for one year, the one that decides the line: the active one, else the latest. */
function decidingOptIn(optIns: readonly StudentAiOptIn[]): StudentAiOptIn {
  const active = optIns.filter((optIn) => optIn.status === "active");
  const pool = active.length > 0 ? active : optIns;
  return [...pool].sort((a, b) => b.startMonth.localeCompare(a.startMonth))[0]!;
}

/** The current month by the school's own date (app.school_today, QA-044), not UTC's. */
async function currentMonth(tx: TransactionSql): Promise<MonthIndex> {
  return monthIndex(await schoolToday(tx));
}

/**
 * Bring one student's Student AI items and planned portions to what their opt-ins call for.
 * Idempotent; see the head of this file.
 */
export async function syncStudentAiFeeItems(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<StudentAiSyncResult> {
  const settings = await readSettings(tx, schoolId);
  const billing: StudentAiBilling = settings.auto_billing ? "auto" : "outside";
  const billingFrom = settings.auto_billing_since ? monthIndex(settings.auto_billing_since) : null;

  const optIns = await listStudentAiOptIns(tx, schoolId, { studentIds: [studentId] });
  const byYear = new Map<string, StudentAiOptIn[]>();
  for (const optIn of optIns) {
    byYear.set(optIn.academicYearId, [...(byYear.get(optIn.academicYearId) ?? []), optIn]);
  }

  const items = await tx<ItemRow[]>`
    SELECT id, academic_year_id, license_id, currency_id, monthly_price_minor::text,
           start_month::text, end_month::text, stop_month::text, months, total_minor::text,
           status, billing
    FROM app.student_ai_fee_items
    WHERE school_id = ${schoolId}::uuid AND student_id = ${studentId}::uuid
    ORDER BY start_month
    FOR UPDATE
  `;
  const portions = await tx<PortionRow[]>`
    SELECT id, item_id, due_date::text, first_month::text, month_count, amount_minor::text, status
    FROM app.student_ai_fee_portions
    WHERE school_id = ${schoolId}::uuid AND student_id = ${studentId}::uuid
    ORDER BY due_date, first_month
    FOR UPDATE
  `;
  const instalmentDueDates =
    billing === "auto"
      ? (
          await tx<{ due_date: string }[]>`
            SELECT DISTINCT due_date::text AS due_date FROM app.installment_cache
            WHERE school_id = ${schoolId}::uuid AND student_id = ${studentId}::uuid
          `
        ).map((row) => row.due_date)
      : [];

  const results: StudentAiSyncItemResult[] = [];
  let thisMonth: MonthIndex | null = null;

  const yearIds = new Set([...byYear.keys(), ...items.map((item) => item.academic_year_id)]);
  for (const yearId of yearIds) {
    const existing = items.find((item) => item.academic_year_id === yearId) ?? null;
    const itemPortions = existing ? portions.filter((p) => p.item_id === existing.id) : [];
    const invoiced = itemPortions.filter((p) => p.status === "invoiced");
    const planned = itemPortions.filter((p) => p.status === "planned");
    const billedMonths = new Set(
      invoiced.flatMap((p) => portionMonths(p.first_month, p.month_count)),
    );

    const [year] = await tx<{ starts_on: string; ends_on: string }[]>`
      SELECT starts_on::text, ends_on::text FROM app.academic_years
      WHERE school_id = ${schoolId}::uuid AND id = ${yearId}::uuid
    `;
    const range = year ? academicYearMonths(year.starts_on, year.ends_on) : null;
    const yearOptIns = byYear.get(yearId) ?? [];

    // Desired state: from the deciding opt-in, or "stopped after what was invoiced" when the
    // opt-in is gone.
    let desired: {
      licenceId: string;
      startMonth: MonthIndex;
      stopMonth: MonthIndex | null;
      status: StudentAiOptInStatus;
      /** The opt-in's price and currency: what the parent agreed to (null when no opt-in). */
      priceMinor: number | null;
      currencyId: string | null;
    } | null = null;
    if (yearOptIns.length > 0 && range) {
      const optIn = decidingOptIn(yearOptIns);
      let stop: MonthIndex | null = null;
      if (optIn.status !== "active") {
        if (optIn.releasedEffectiveMonth) {
          stop = monthIndex(optIn.releasedEffectiveMonth);
        } else {
          thisMonth ??= await currentMonth(tx);
          stop = thisMonth + 1;
        }
      }
      desired = {
        licenceId: optIn.licenceId,
        startMonth: Math.max(monthIndex(optIn.startMonth), range.first),
        stopMonth: stop,
        status: optIn.status,
        priceMinor: optIn.monthlyPriceMinor,
        currencyId: optIn.currencyId,
      };
      if (desired.startMonth > range.last && !existing) {
        results.push(skip(yearId, "skipped_no_months"));
        continue;
      }
    } else if (existing && range && invoiced.length > 0) {
      const lastBilled = Math.max(...billedMonths);
      desired = {
        licenceId: existing.license_id,
        startMonth: monthIndex(existing.start_month),
        stopMonth: Math.max(monthIndex(existing.start_month), lastBilled + 1),
        status: "released",
        priceMinor: null,
        currencyId: null,
      };
    }

    if (!desired || !range) {
      // No opt-in (any more) and nothing invoiced: the line goes.
      if (existing) {
        await tx`DELETE FROM app.student_ai_fee_portions WHERE item_id = ${existing.id}::uuid AND status = 'planned'`;
        await tx`DELETE FROM app.student_ai_fee_items WHERE id = ${existing.id}::uuid`;
        await emitAuditLog(tx, {
          action: "delete",
          targetTable: "student_ai_fee_items",
          targetId: existing.id,
          oldValues: itemAudit(studentId, existing),
        });
        results.push({ ...skip(yearId, "removed"), itemId: existing.id });
      }
      continue;
    }

    // The price and currency are fixed when the line is created: what the parent agreed to.
    let priceMinor: number;
    let currencyId: string;
    if (existing) {
      priceMinor = Number(existing.monthly_price_minor);
      currencyId = existing.currency_id;
    } else if (desired.priceMinor !== null && desired.currencyId !== null) {
      // The monthly price the parent agreed to on the opt-in (phase 2), in its currency.
      priceMinor = desired.priceMinor;
      currencyId = desired.currencyId;
    } else {
      results.push(skip(yearId, "skipped_no_price"));
      continue;
    }

    const startMonth = Math.min(desired.startMonth, range.last);
    // Unclamped: a start after the year's last month charges nothing.
    const charged = chargedMonths(range, desired.startMonth, desired.stopMonth);
    if (!existing && charged.length === 0) {
      // Released before it started, or opted in after the year: nothing to show or bill.
      results.push(skip(yearId, "skipped_no_months"));
      continue;
    }
    const stopMonth =
      desired.status === "active" ? null : Math.max(desired.stopMonth ?? startMonth, startMonth);
    const fields = {
      license_id: desired.licenceId,
      start_month: monthStart(startMonth),
      end_month: monthStart(range.last),
      stop_month: stopMonth === null ? null : monthStart(stopMonth),
      months: charged.length,
      total_minor: String(priceMinor * charged.length),
      status: desired.status,
      billing,
    };

    const plan: PortionPlan[] =
      billing === "auto"
        ? allocatePortions({
            year: range,
            startMonth,
            charged,
            instalmentDueDates,
            monthlyPriceMinor: priceMinor,
            billedMonths,
            billingFrom,
          })
        : [];

    let itemId: string;
    let action: StudentAiSyncAction;
    if (!existing) {
      const [created] = await tx<{ id: string }[]>`
        INSERT INTO app.student_ai_fee_items (
          school_id, student_id, academic_year_id, license_id, currency_id, monthly_price_minor,
          start_month, end_month, stop_month, months, total_minor, status, billing
        ) VALUES (
          ${schoolId}::uuid, ${studentId}::uuid, ${yearId}::uuid, ${fields.license_id}::uuid,
          ${currencyId}::uuid, ${priceMinor}::bigint, ${fields.start_month}::date,
          ${fields.end_month}::date, ${fields.stop_month}::date, ${fields.months},
          ${fields.total_minor}::bigint, ${fields.status}, ${fields.billing}
        )
        RETURNING id
      `;
      itemId = created!.id;
      action = "created";
      await emitAuditLog(tx, {
        action: "insert",
        targetTable: "student_ai_fee_items",
        targetId: itemId,
        newValues: {
          student_id: studentId,
          academic_year_id: yearId,
          monthly_price_minor: priceMinor,
          ...fields,
        },
      });
    } else {
      itemId = existing.id;
      const changed =
        existing.license_id !== fields.license_id ||
        existing.start_month !== fields.start_month ||
        existing.end_month !== fields.end_month ||
        existing.stop_month !== fields.stop_month ||
        existing.months !== fields.months ||
        existing.total_minor !== fields.total_minor ||
        existing.status !== fields.status ||
        existing.billing !== fields.billing;
      action = changed ? "updated" : "unchanged";
      if (changed) {
        await tx`
          UPDATE app.student_ai_fee_items
          SET license_id = ${fields.license_id}::uuid, start_month = ${fields.start_month}::date,
              end_month = ${fields.end_month}::date, stop_month = ${fields.stop_month}::date,
              months = ${fields.months}, total_minor = ${fields.total_minor}::bigint,
              status = ${fields.status}, billing = ${fields.billing},
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ${itemId}::uuid
        `;
        await emitAuditLog(tx, {
          action: "update",
          targetTable: "student_ai_fee_items",
          targetId: itemId,
          oldValues: itemAudit(studentId, existing),
          newValues: { student_id: studentId, academic_year_id: yearId, ...fields },
        });
      }
    }

    const current: PortionPlan[] = planned.map((p) => ({
      dueDate: p.due_date,
      firstMonth: p.first_month,
      monthCount: p.month_count,
      amountMinor: Number(p.amount_minor),
    }));
    if (portionsFingerprint(current) !== portionsFingerprint(plan)) {
      await tx`
        DELETE FROM app.student_ai_fee_portions
        WHERE school_id = ${schoolId}::uuid AND item_id = ${itemId}::uuid AND status = 'planned'
      `;
      for (const portion of plan) {
        await tx`
          INSERT INTO app.student_ai_fee_portions (
            school_id, item_id, student_id, due_date, first_month, month_count, amount_minor
          ) VALUES (
            ${schoolId}::uuid, ${itemId}::uuid, ${studentId}::uuid, ${portion.dueDate}::date,
            ${portion.firstMonth}::date, ${portion.monthCount}, ${portion.amountMinor}::bigint
          )
        `;
      }
      if (action === "unchanged") {
        action = "updated";
        await emitAuditLog(tx, {
          action: "update",
          targetTable: "student_ai_fee_items",
          targetId: itemId,
          oldValues: { planned_portions: current.map(portionAudit) },
          newValues: { planned_portions: plan.map(portionAudit) },
        });
      }
    }

    results.push({
      academicYearId: yearId,
      itemId,
      action,
      months: fields.months,
      totalMinor: priceMinor * charged.length,
      plannedPortions: plan.length,
    });
  }

  return { studentId, items: results };
}

function skip(academicYearId: string, action: StudentAiSyncAction): StudentAiSyncItemResult {
  return { academicYearId, itemId: null, action, months: 0, totalMinor: 0, plannedPortions: 0 };
}

function itemAudit(studentId: string, item: ItemRow): Record<string, unknown> {
  return {
    student_id: studentId,
    academic_year_id: item.academic_year_id,
    license_id: item.license_id,
    start_month: item.start_month,
    end_month: item.end_month,
    stop_month: item.stop_month,
    months: item.months,
    total_minor: item.total_minor,
    status: item.status,
    billing: item.billing,
  };
}

function portionAudit(portion: PortionPlan): Record<string, unknown> {
  return {
    due_date: portion.dueDate,
    first_month: portion.firstMonth,
    month_count: portion.monthCount,
    amount_minor: portion.amountMinor,
  };
}

/** `syncStudentAiFeeItems` for several students. */
export async function syncStudentAiFeeItemsFor(
  tx: TransactionSql,
  schoolId: string,
  studentIds: readonly string[],
): Promise<StudentAiSyncResult[]> {
  const results: StudentAiSyncResult[] = [];
  for (const studentId of [...new Set(studentIds)].sort()) {
    results.push(await syncStudentAiFeeItems(tx, schoolId, studentId));
  }
  return results;
}

/** Every student of the school with an opt-in or a line. */
export async function syncSchoolStudentAiFeeItems(
  tx: TransactionSql,
  schoolId: string,
): Promise<StudentAiSyncResult[]> {
  const optIns = await listStudentAiOptIns(tx, schoolId);
  const withItems = await tx<{ student_id: string }[]>`
    SELECT DISTINCT student_id FROM app.student_ai_fee_items WHERE school_id = ${schoolId}::uuid
  `;
  return syncStudentAiFeeItemsFor(tx, schoolId, [
    ...optIns.map((optIn) => optIn.studentId),
    ...withItems.map((row) => row.student_id),
  ]);
}

/**
 * The reconciliation in its own system transaction, for callers outside one (phase 2's opt-in
 * events after commit, the fee-schedule generator).
 */
export function syncStudentAiFeeItemsInOwnTx(
  database: Database | DatabasePools,
  actor: { schoolId: string; userId?: string; requestId?: string },
  studentIds: readonly string[],
): Promise<StudentAiSyncResult[]> {
  return withStudentAiTx(database, actor, (tx) =>
    syncStudentAiFeeItemsFor(tx, actor.schoolId, studentIds),
  );
}

/**
 * The re-sync after another transaction committed (phase 2's opt-in, release or transfer; the
 * fee-schedule generator), best effort: the change itself stands, and a failure is logged at error
 * level with the school and students, so it is seen -- `POST /api/finance/student-ai/sync` (the
 * finance page's Recalculate) is the retry, and it is idempotent.
 */
export async function resyncStudentAiAfterCommit(
  database: Database | DatabasePools,
  actor: { schoolId: string; userId?: string; requestId?: string },
  studentIds: readonly string[],
  log: Pick<Logger, "error">,
  trigger: string,
): Promise<void> {
  if (studentIds.length === 0) return;
  try {
    await syncStudentAiFeeItemsInOwnTx(database, actor, studentIds);
  } catch (err) {
    log.error(
      { err, school_id: actor.schoolId, student_ids: [...new Set(studentIds)], trigger },
      "student ai: re-sync of the tuition line failed; POST /api/finance/student-ai/sync retries it",
    );
  }
}

// ---------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------

/** The line as parents and finance see it. Never carries the licence price or the revenue share. */
export interface StudentAiLine {
  student_id: string;
  academic_year_id: string;
  academic_year_name: string;
  currency: string;
  currency_minor_unit: number;
  monthly_price: string;
  monthly_price_minor: number;
  months: number;
  total: string;
  total_minor: number;
  /** "2026-09". */
  start_month: string;
  end_month: string;
  /** True when the student joined after the year's first month (pays the remaining months). */
  late_start: boolean;
  /** "2027-01": the first month no longer charged (released or transferred seat); else null. */
  stopped_from: string | null;
  status: StudentAiOptInStatus;
  /** auto: on the fee schedule; outside: the school bills it. Either way "paid with tuition". */
  billing: StudentAiBilling;
  invoiced: string;
  invoiced_minor: number;
  planned: string;
  planned_minor: number;
}

/**
 * The line as a parent sees it in the family view: the year, the months it runs and where it
 * stands, never an amount. The school tells parents the price (owner, 2026-11-18); finance's own
 * list (`listStudentAiLines`) keeps the amounts.
 */
export interface FamilyStudentAiLine {
  academic_year_id: string;
  academic_year_name: string;
  start_month: string;
  end_month: string;
  late_start: boolean;
  stopped_from: string | null;
  status: StudentAiOptInStatus;
}

export function toFamilyStudentAiLine(line: StudentAiLine): FamilyStudentAiLine {
  return {
    academic_year_id: line.academic_year_id,
    academic_year_name: line.academic_year_name,
    start_month: line.start_month,
    end_month: line.end_month,
    late_start: line.late_start,
    stopped_from: line.stopped_from,
    status: line.status,
  };
}

interface LineRow {
  student_id: string;
  academic_year_id: string;
  academic_year_name: string;
  starts_on: string;
  ends_on: string;
  currency: string;
  currency_minor_unit: number;
  monthly_price_minor: string;
  months: number;
  total_minor: string;
  start_month: string;
  end_month: string;
  stop_month: string | null;
  status: StudentAiOptInStatus;
  billing: StudentAiBilling;
  invoiced_minor: string;
  planned_minor: string;
}

function toLine(row: LineRow): StudentAiLine {
  const minor = row.currency_minor_unit;
  const range = academicYearMonths(row.starts_on, row.ends_on);
  const start = monthIndex(row.start_month);
  return {
    student_id: row.student_id,
    academic_year_id: row.academic_year_id,
    academic_year_name: row.academic_year_name,
    currency: row.currency,
    currency_minor_unit: minor,
    monthly_price: formatMinorUnits(BigInt(row.monthly_price_minor), minor),
    monthly_price_minor: Number(row.monthly_price_minor),
    months: row.months,
    total: formatMinorUnits(BigInt(row.total_minor), minor),
    total_minor: Number(row.total_minor),
    start_month: monthKey(start),
    end_month: monthKey(monthIndex(row.end_month)),
    late_start: range !== null && start > range.first,
    stopped_from: row.stop_month ? monthKey(monthIndex(row.stop_month)) : null,
    status: row.status,
    billing: row.billing,
    invoiced: formatMinorUnits(BigInt(row.invoiced_minor), minor),
    invoiced_minor: Number(row.invoiced_minor),
    planned: formatMinorUnits(BigInt(row.planned_minor), minor),
    planned_minor: Number(row.planned_minor),
  };
}

function lineQuery(tx: TransactionSql, schoolId: string, filter: PendingQuery<Row[]>) {
  return tx<LineRow[]>`
    SELECT item.student_id, item.academic_year_id, year.name AS academic_year_name,
           year.starts_on::text, year.ends_on::text,
           c.code AS currency, c.minor_unit AS currency_minor_unit,
           item.monthly_price_minor::text, item.months, item.total_minor::text,
           item.start_month::text, item.end_month::text, item.stop_month::text,
           item.status, item.billing,
           coalesce(sum(p.amount_minor) FILTER (WHERE p.status = 'invoiced'), 0)::text
             AS invoiced_minor,
           coalesce(sum(p.amount_minor) FILTER (WHERE p.status = 'planned'), 0)::text
             AS planned_minor
    FROM app.student_ai_fee_items AS item
    JOIN app.academic_years AS year
      ON year.id = item.academic_year_id AND year.school_id = item.school_id
    JOIN app.currencies AS c ON c.id = item.currency_id
    LEFT JOIN app.student_ai_fee_portions AS p
      ON p.item_id = item.id AND p.school_id = item.school_id
    WHERE item.school_id = ${schoolId}::uuid ${filter}
    GROUP BY item.id, year.id, c.id
    ORDER BY year.starts_on DESC, item.student_id
  `;
}

/**
 * The lines of the given students, newest academic year first. In a parent's own transaction the
 * row-level policy limits this to their children as well.
 */
export async function studentAiLinesFor(
  tx: TransactionSql,
  schoolId: string,
  studentIds: readonly string[],
): Promise<Map<string, StudentAiLine[]>> {
  const lines = new Map<string, StudentAiLine[]>();
  if (studentIds.length === 0) return lines;
  const rows = await lineQuery(
    tx,
    schoolId,
    tx`AND item.student_id = ANY(${[...studentIds]}::uuid[])`,
  );
  for (const row of rows) {
    const line = toLine(row);
    lines.set(line.student_id, [...(lines.get(line.student_id) ?? []), line]);
  }
  return lines;
}

export interface StudentAiFinanceLine extends StudentAiLine {
  student_name: string;
  admission_number: string;
}

/** Every line of the school (finance's list), with the student's identity. */
export async function listStudentAiLines(
  tx: TransactionSql,
  schoolId: string,
  academicYearId?: string,
): Promise<StudentAiFinanceLine[]> {
  const rows = await lineQuery(
    tx,
    schoolId,
    academicYearId ? tx`AND item.academic_year_id = ${academicYearId}::uuid` : tx``,
  );
  if (rows.length === 0) return [];
  const identities = await tx<{ id: string; name: string; admission_number: string }[]>`
    SELECT id, coalesce(preferred_name, first_name) || ' ' || last_name AS name, admission_number
    FROM app.students
    WHERE school_id = ${schoolId}::uuid AND id = ANY(${[...new Set(rows.map((r) => r.student_id))]}::uuid[])
  `;
  const byId = new Map(identities.map((row) => [row.id, row]));
  // Newest academic year first (as queried), then by student name.
  return rows
    .map((row) => {
      const identity = byId.get(row.student_id);
      const line: StudentAiFinanceLine = {
        ...toLine(row),
        student_name: identity?.name ?? "",
        admission_number: identity?.admission_number ?? "",
      };
      return { line, startsOn: row.starts_on };
    })
    .sort(
      (a, b) =>
        b.startsOn.localeCompare(a.startsOn) ||
        a.line.student_name.localeCompare(b.line.student_name) ||
        a.line.student_id.localeCompare(b.line.student_id),
    )
    .map(({ line }) => line);
}
