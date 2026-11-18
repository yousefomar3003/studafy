/**
 * The Student AI weekly statements (migration 000251, owner's rules of 2026-11-18,
 * docs/billing/ai-programme.md "Weekly statements"). Scheduled every Monday at 06:00 UTC: for the
 * week that just ended (Monday to Sunday, UTC), each school gets a statement per currency -- the
 * student-months it collected from parents (what it owes Studafy, less its revenue share on them)
 * and its licence shares that became final -- and the super admins are told once that statements
 * are waiting for their approval. Nothing is billed, credited or paid before a super admin approves.
 *
 * One system tenant transaction per school, retried on a serialization failure; a school that fails
 * is logged and left for the next run (building is idempotent: a week already stated gets nothing
 * more, and what is left waits for the next week).
 */

import { buildWeeklyStatements, utcDay, weekStartOf, withTransactionRetry } from "@studafy/billing";
import { NOTIFICATION_TYPES } from "@studafy/constants";
import {
  isTemplateLocale,
  NOTIFICATION_CHANNELS,
  renderNotification,
} from "@studafy/notification-templates";

import { emitAuditLogs } from "../../db/audit";
import { withSystemTenantTx } from "../../db/tenant-tx";

import { loadSuperAdmins } from "./license-reminders";

import type { BillingLogger } from "@studafy/billing";
import type { TemplateLocale } from "@studafy/notification-templates";
import type { Sql } from "postgres";

const DAY_MS = 86_400_000;

export interface AiRevenueShareStatementsResult {
  weekStart: string;
  schools: number;
  statements: number;
  schoolsWithStatements: number;
  failedSchools: number;
  superAdminsNotified: number;
}

/** The week a run on `now` states: the last full Monday-to-Sunday week before it (UTC). */
export function statementWeekFor(now: Date): string {
  return weekStartOf(utcDay(new Date(now.getTime() - 7 * DAY_MS)));
}

export async function runAiRevenueShareStatements(
  sql: Sql,
  now: Date,
  log: BillingLogger,
  schoolIds?: readonly string[],
): Promise<AiRevenueShareStatementsResult> {
  const allSchools = await sql<
    { id: string }[]
  >`SELECT id::text AS id FROM app.schools ORDER BY id`;
  const schools = schoolIds ? allSchools.filter((s) => schoolIds.includes(s.id)) : allSchools;
  const weekStart = statementWeekFor(now);
  const result: AiRevenueShareStatementsResult = {
    weekStart,
    schools: schools.length,
    statements: 0,
    schoolsWithStatements: 0,
    failedSchools: 0,
    superAdminsNotified: 0,
  };

  for (const { id: schoolId } of schools) {
    try {
      const built = await withTransactionRetry(() =>
        withSystemTenantTx(sql, { schoolId }, (tx) =>
          buildWeeklyStatements(
            tx,
            { schoolId, now, audit: (entries) => emitAuditLogs(tx, entries) },
            weekStart,
          ),
        ),
      );
      result.statements += built.length;
      if (built.length > 0) result.schoolsWithStatements += 1;
    } catch (err) {
      result.failedSchools += 1;
      log.warn({ err, school_id: schoolId, week_start: weekStart }, "weekly statements failed");
    }
  }

  // Told once per run that built something: a re-run of the same week builds nothing more.
  if (result.statements > 0) {
    const vars = {
      statements: String(result.statements),
      schools: String(result.schoolsWithStatements),
      weekStart,
    };
    const admins = await loadSuperAdmins(
      sql,
      allSchools.map((s) => s.id),
    );
    for (const admin of admins) {
      await withSystemTenantTx(sql, { schoolId: admin.schoolId }, async (tx) => {
        const [settings] = await tx<{ locale: string | null }[]>`
          SELECT locale FROM app.school_settings
          WHERE school_id = current_setting('app.school_id')::uuid
        `;
        const locale: TemplateLocale = isTemplateLocale(settings?.locale ?? "")
          ? (settings!.locale as TemplateLocale)
          : "en";
        const type = NOTIFICATION_TYPES.AI_REVENUE_SHARE_STATEMENTS_READY;
        await tx`
          INSERT INTO app.notifications (id, school_id, user_id, notification_type, title, body, metadata)
          VALUES (
            ${crypto.randomUUID()}::uuid, ${admin.schoolId}::uuid, ${admin.userId}::uuid,
            ${type}::app.notification_type,
            ${renderNotification(type, NOTIFICATION_CHANNELS.PUSH, locale, vars).trim()},
            ${renderNotification(type, NOTIFICATION_CHANNELS.IN_APP, locale, vars).trim()},
            ${tx.json({ kind: "ai_revenue_share_statements", week_start: weekStart })}
          )
        `;
      });
      result.superAdminsNotified += 1;
    }
  }

  log.info({ ...result }, "AI revenue share weekly statements complete");
  return result;
}
