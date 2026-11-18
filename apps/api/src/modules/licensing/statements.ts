import { approveShares, rejectShares } from "@studafy/billing";
import { ERROR_CODES } from "@studafy/constants";

import { auditLicenseChange, licenseError } from "./context";
import { activatePaidStatement, forEachSchool, issueInvoice, settleShares } from "./invoices";
import { requireReason } from "./revenue-share";
import { shareContext } from "./revenue-share-context";

import type { LicenseActor } from "./context";
import type { Database, DatabasePools } from "../../db/client";
import type { TransactionSql } from "postgres";

/**
 * The Student AI weekly statements in the API (migration 000251, owner's rules of 2026-11-18,
 * docs/billing/ai-programme.md "Weekly statements"): the super admin's queue across schools, one
 * statement with its student-months and licence shares, and the decision -- approve (Studafy bills
 * the net: a licence invoice of kind ai_statement; the listed licence shares become owed or payout
 * due), hold (with a note), or reject (with a reason: the months wait for a later statement, the
 * licence shares are rejected). Paying the statement's invoice activates its months. The workers
 * build the statements (@studafy/billing `buildWeeklyStatements`).
 */

export const STATEMENT_STATUSES = ["awaiting_approval", "held", "approved", "rejected"] as const;
export type StatementStatus = (typeof STATEMENT_STATUSES)[number];

export interface StatementView {
  id: string;
  schoolId: string;
  weekStart: string;
  weekEnd: string;
  currencyCode: string;
  minorUnit: number;
  monthsCount: number;
  grossMinor: number;
  shareMinor: number;
  netMinor: number;
  licenceShareCount: number;
  licenceShareMinor: number;
  status: StatementStatus;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  createdAt: string;
}

export interface PlatformStatementView extends StatementView {
  schoolName: string;
}

export interface StatementMonthView {
  id: string;
  studentId: string;
  studentName: string;
  month: string;
  collectedOn: string;
  priceMinor: number;
  shareBps: number | null;
  shareMinor: number | null;
  status: "collected" | "billed" | "activated" | "void";
}

export interface StatementShareView {
  id: string;
  licenseId: string;
  invoiceNumber: string;
  periodFrom: string;
  periodTo: string;
  measurementPeriodStart: string;
  totalBps: number;
  amountMinor: number;
  status: string;
}

export interface StatementDetail extends StatementView {
  months: StatementMonthView[];
  shares: StatementShareView[];
}

interface StatementRow {
  id: string;
  school_id: string;
  week_start: string;
  week_end: string;
  currency_code: string;
  minor_unit: number;
  months_count: number;
  gross_minor: string;
  share_minor: string;
  net_minor: string;
  licence_share_count: number;
  licence_share_minor: string;
  status: StatementStatus;
  decided_at: Date | null;
  decided_by: string | null;
  decision_note: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  created_at: Date;
}

function toStatement(row: StatementRow): StatementView {
  return {
    id: row.id,
    schoolId: row.school_id,
    weekStart: row.week_start,
    weekEnd: row.week_end,
    currencyCode: row.currency_code,
    minorUnit: row.minor_unit,
    monthsCount: row.months_count,
    grossMinor: Number(row.gross_minor),
    shareMinor: Number(row.share_minor),
    netMinor: Number(row.net_minor),
    licenceShareCount: row.licence_share_count,
    licenceShareMinor: Number(row.licence_share_minor),
    status: row.status,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decidedBy: row.decided_by,
    decisionNote: row.decision_note,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    createdAt: row.created_at.toISOString(),
  };
}

function statementsQuery(
  tx: TransactionSql,
  filters: { id?: string; statuses?: readonly StatementStatus[] },
) {
  return tx<StatementRow[]>`
    SELECT s.id::text AS id, s.school_id::text AS school_id, s.week_start::text AS week_start,
           s.week_end::text AS week_end, c.code AS currency_code, c.minor_unit::int AS minor_unit,
           s.months_count, s.gross_minor::text AS gross_minor, s.share_minor::text AS share_minor,
           s.net_minor::text AS net_minor, s.licence_share_count,
           s.licence_share_minor::text AS licence_share_minor, s.status, s.decided_at,
           s.decided_by::text AS decided_by, s.decision_note, s.invoice_id::text AS invoice_id,
           i.number AS invoice_number, s.created_at
    FROM app.ai_programme_weekly_statements AS s
    JOIN app.currencies AS c ON c.id = s.currency_id
    LEFT JOIN app.license_invoices AS i ON i.id = s.invoice_id AND i.school_id = s.school_id
    WHERE s.school_id = current_setting('app.school_id')::uuid
      ${filters.id ? tx`AND s.id = ${filters.id}::uuid` : tx``}
      ${filters.statuses ? tx`AND s.status = ANY(${filters.statuses as StatementStatus[]}::text[])` : tx``}
    ORDER BY s.week_start DESC, c.code
  `;
}

/** The armed school's statements, newest week first (all statuses unless given). */
export async function schoolStatements(
  tx: TransactionSql,
  statuses?: readonly StatementStatus[],
): Promise<StatementView[]> {
  return (await statementsQuery(tx, statuses ? { statuses } : {})).map(toStatement);
}

/** Statements across schools for the super admin's queue: awaiting approval and held first. */
export async function listStatementsAcrossSchools(
  database: Database | DatabasePools,
  filters: { status?: StatementStatus },
): Promise<PlatformStatementView[]> {
  const statuses = filters.status ? [filters.status] : undefined;
  const items = await forEachSchool(
    database,
    null,
    (tx) => [statementsQuery(tx, statuses ? { statuses } : {})] as const,
    ([rows], school) => rows.map((row) => ({ ...toStatement(row), schoolName: school.name })),
  );
  const rank = (status: StatementStatus) =>
    status === "awaiting_approval" ? 0 : status === "held" ? 1 : 2;
  return items.sort(
    (a, b) =>
      rank(a.status) - rank(b.status) ||
      b.weekStart.localeCompare(a.weekStart) ||
      a.schoolName.localeCompare(b.schoolName),
  );
}

/** One statement of the armed school with its student-months and licence shares; null if none. */
export async function statementDetail(
  tx: TransactionSql,
  statementId: string,
): Promise<StatementDetail | null> {
  const [row] = await statementsQuery(tx, { id: statementId });
  if (!row) return null;
  const months = await tx<
    {
      id: string;
      student_id: string;
      student_name: string;
      month: string;
      collected_on: string;
      price_minor: string;
      share_bps: number | null;
      share_minor: string | null;
      status: StatementMonthView["status"];
    }[]
  >`
    SELECT m.id::text AS id, m.student_id::text AS student_id,
           btrim(concat_ws(' ', st.first_name, st.last_name)) AS student_name,
           m.month::text AS month, m.collected_on::text AS collected_on,
           m.price_minor::text AS price_minor, m.share_bps, m.share_minor::text AS share_minor,
           m.status
    FROM app.student_ai_months AS m
    JOIN app.students AS st ON st.id = m.student_id AND st.school_id = m.school_id
    WHERE m.school_id = current_setting('app.school_id')::uuid
      AND m.statement_id = ${statementId}::uuid
    ORDER BY student_name, m.month
  `;
  const shares = await tx<
    {
      id: string;
      license_id: string;
      invoice_number: string;
      period_from: string;
      period_to: string;
      measurement_period_start: string;
      total_bps: number;
      amount_minor: string;
      status: string;
    }[]
  >`
    SELECT e.id::text AS id, e.license_id::text AS license_id, i.number AS invoice_number,
           e.period_from::text AS period_from, e.period_to::text AS period_to,
           e.measurement_period_start::text AS measurement_period_start, e.total_bps,
           e.amount_minor::text AS amount_minor, e.status
    FROM app.ai_programme_revenue_share_entries AS e
    JOIN app.license_invoices AS i ON i.id = e.invoice_id AND i.school_id = e.school_id
    WHERE e.school_id = current_setting('app.school_id')::uuid
      AND e.statement_id = ${statementId}::uuid
    ORDER BY e.period_from, i.number
  `;
  return {
    ...toStatement(row),
    months: months.map((m) => ({
      id: m.id,
      studentId: m.student_id,
      studentName: m.student_name,
      month: m.month,
      collectedOn: m.collected_on,
      priceMinor: Number(m.price_minor),
      shareBps: m.share_bps,
      shareMinor: m.share_minor === null ? null : Number(m.share_minor),
      status: m.status,
    })),
    shares: shares.map((s) => ({
      id: s.id,
      licenseId: s.license_id,
      invoiceNumber: s.invoice_number,
      periodFrom: s.period_from,
      periodTo: s.period_to,
      measurementPeriodStart: s.measurement_period_start,
      totalBps: s.total_bps,
      amountMinor: Number(s.amount_minor),
      status: s.status,
    })),
  };
}

// ---------------------------------------------------------------------------------------------------
// The super admin's decision
// ---------------------------------------------------------------------------------------------------

interface LiveStatement {
  statement: { id: string; status: StatementStatus; week_start: string; currency_id: string };
  months: { id: string; license_id: string; price_minor: string; share_minor: string }[];
  shares: { id: string; amount_minor: string }[];
}

/**
 * The statement, locked, with what it still bills and credits: its months still collected and its
 * licence shares still awaiting approval (one may have been forfeited or voided since it was built).
 * 404 when there is none; 409 AI_REVENUE_SHARE_STATEMENT_DECIDED once approved or rejected.
 */
async function lockUndecided(
  tx: TransactionSql,
  statementId: string,
  actor: LicenseActor,
): Promise<LiveStatement> {
  const [statement] = await tx<LiveStatement["statement"][]>`
    SELECT id::text AS id, status, week_start::text AS week_start, currency_id::text AS currency_id
    FROM app.ai_programme_weekly_statements
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${statementId}::uuid
    FOR UPDATE
  `;
  if (!statement) throw licenseError(404, ERROR_CODES.RESOURCE_NOT_FOUND, actor.locale);
  if (statement.status !== "awaiting_approval" && statement.status !== "held") {
    throw licenseError(409, ERROR_CODES.AI_REVENUE_SHARE_STATEMENT_DECIDED, actor.locale);
  }
  const months = await tx<LiveStatement["months"]>`
    SELECT id::text AS id, license_id::text AS license_id, price_minor::text AS price_minor,
           share_minor::text AS share_minor
    FROM app.student_ai_months
    WHERE school_id = current_setting('app.school_id')::uuid
      AND statement_id = ${statementId}::uuid AND status = 'collected'
    ORDER BY month, id
    FOR UPDATE
  `;
  const shares = await tx<LiveStatement["shares"]>`
    SELECT id::text AS id, amount_minor::text AS amount_minor
    FROM app.ai_programme_revenue_share_entries
    WHERE school_id = current_setting('app.school_id')::uuid
      AND statement_id = ${statementId}::uuid AND status = 'awaiting_approval'
    ORDER BY id
    FOR UPDATE
  `;
  return { statement, months, shares };
}

export interface ApproveStatementInput {
  /** The net the super admin saw (what the school will owe for the months); refused if changed. */
  expectedNetMinor: number;
  /** The licence shares the super admin saw; refused if changed. */
  expectedLicenceShareMinor: number;
  note?: string | null;
}

/**
 * Approve a statement: its licence shares become owed (or payout due) and settle; its months are
 * billed on a licence invoice of kind ai_statement for the net (the months less the share on them,
 * then any owed shares credited too), and are activated when that invoice is paid -- at once when
 * nothing is left to pay. 409 AI_REVENUE_SHARE_STATEMENT_CHANGED when its figures are no longer the
 * ones the super admin saw.
 */
export async function approveStatement(
  tx: TransactionSql,
  schoolId: string,
  statementId: string,
  input: ApproveStatementInput,
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<StatementDetail> {
  const live = await lockUndecided(tx, statementId, actor);
  const gross = live.months.reduce((sum, m) => sum + Number(m.price_minor), 0);
  const share = live.months.reduce((sum, m) => sum + Number(m.share_minor), 0);
  const licenceShare = live.shares.reduce((sum, s) => sum + Number(s.amount_minor), 0);
  if (
    gross - share !== input.expectedNetMinor ||
    licenceShare !== input.expectedLicenceShareMinor
  ) {
    throw licenseError(409, ERROR_CODES.AI_REVENUE_SHARE_STATEMENT_CHANGED, actor.locale);
  }
  const ctx = shareContext(tx, schoolId, actor, now);
  await approveShares(
    tx,
    ctx,
    live.shares.map((s) => s.id),
  );

  let invoiceId: string | null = null;
  if (live.months.length > 0) {
    // The licence the months were sold under (the latest, should a renewal's months be on it too).
    const [licence] = await tx<{ id: string }[]>`
      SELECT id::text AS id FROM app.school_licenses
      WHERE school_id = current_setting('app.school_id')::uuid
        AND id = ANY(${[...new Set(live.months.map((m) => m.license_id))]}::uuid[])
      ORDER BY starts_at DESC, id
      LIMIT 1
    `;
    const invoice = await issueInvoice(
      tx,
      schoolId,
      {
        licenseId: licence!.id,
        quoteId: null,
        currencyId: live.statement.currency_id,
        lines: [],
        planIds: {},
        statement: {
          monthsDescription: `Student AI: ${live.months.length} student-months collected, week of ${live.statement.week_start}`,
          monthsMinor: gross,
          shareDescription: "Student AI revenue share on those months",
          shareMinor: share,
        },
      },
      actor,
      now,
    );
    invoiceId = invoice.id;
    await tx`
      UPDATE app.student_ai_months
      SET status = 'billed', billed_at = ${now}, updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
      WHERE school_id = current_setting('app.school_id')::uuid
        AND id = ANY(${live.months.map((m) => m.id)}::uuid[])
    `;
  }

  const note = input.note?.trim() || null;
  await tx`
    UPDATE app.ai_programme_weekly_statements
    SET status = 'approved', decided_at = ${now}, decided_by = ${actor.userId}::uuid,
        decision_note = ${note}, invoice_id = ${invoiceId}::uuid,
        updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${statementId}::uuid
  `;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "ai_programme_weekly_statements",
    targetId: statementId,
    oldValues: { status: live.statement.status },
    newValues: {
      status: "approved",
      invoice_id: invoiceId,
      months_minor: gross,
      share_minor: share,
      net_minor: gross - share,
      licence_share_minor: licenceShare,
      student_ai_months: live.months.map((m) => m.id),
      revenue_share_entries: live.shares.map((s) => s.id),
      ...(note ? { note } : {}),
    },
  });
  // The approved licence shares are credited on the school's next open invoice (this one included).
  await settleShares(tx, schoolId, actor, now);
  if (invoiceId) await activatePaidStatement(tx, schoolId, invoiceId, actor, now);
  return (await statementDetail(tx, statementId))!;
}

/** Hold a statement, with a note: it waits, and can be approved or rejected later. */
export async function holdStatement(
  tx: TransactionSql,
  schoolId: string,
  statementId: string,
  note: string,
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<StatementDetail> {
  const reason = requireReason(note, actor);
  const live = await lockUndecided(tx, statementId, actor);
  await tx`
    UPDATE app.ai_programme_weekly_statements
    SET status = 'held', decided_at = ${now}, decided_by = ${actor.userId}::uuid,
        decision_note = ${reason}, updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${statementId}::uuid
  `;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "ai_programme_weekly_statements",
    targetId: statementId,
    oldValues: { status: live.statement.status },
    newValues: { status: "held", note: reason },
  });
  return (await statementDetail(tx, statementId))!;
}

/**
 * Reject a statement, with a reason: its licence shares are rejected (never given); its months
 * leave it and wait for a later statement (the school still collected them).
 */
export async function rejectStatement(
  tx: TransactionSql,
  schoolId: string,
  statementId: string,
  reason: string,
  actor: LicenseActor,
  now: Date = new Date(),
): Promise<StatementDetail> {
  const why = requireReason(reason, actor);
  const live = await lockUndecided(tx, statementId, actor);
  await rejectShares(
    tx,
    shareContext(tx, schoolId, actor, now),
    live.shares.map((s) => s.id),
    why,
  );
  if (live.months.length > 0) {
    await tx`
      UPDATE app.student_ai_months
      SET statement_id = NULL, share_bps = NULL, share_minor = NULL,
          updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
      WHERE school_id = current_setting('app.school_id')::uuid
        AND id = ANY(${live.months.map((m) => m.id)}::uuid[])
    `;
  }
  await tx`
    UPDATE app.ai_programme_weekly_statements
    SET status = 'rejected', decided_at = ${now}, decided_by = ${actor.userId}::uuid,
        decision_note = ${why}, updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${statementId}::uuid
  `;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "ai_programme_weekly_statements",
    targetId: statementId,
    oldValues: { status: live.statement.status },
    newValues: {
      status: "rejected",
      reason: why,
      released_months: live.months.map((m) => m.id),
      rejected_entries: live.shares.map((s) => s.id),
    },
  });
  return (await statementDetail(tx, statementId))!;
}
