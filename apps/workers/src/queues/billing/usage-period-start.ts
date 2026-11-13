/**
 * Start the month's feature usage periods (session 3 of docs/billing/feature-licensing.md). On the
 * 1st of each month (UTC), per school: open a zero meter row in app.feature_usage_meters for every
 * seat holder of an active license, for each metered feature their seat's tier includes.
 *
 * Usage is keyed by calendar month, so a new month's counting starts at zero whether or not this
 * runs: `requireFeature`'s conditional upsert creates the row on first use. What this adds is that
 * the period exists from its first minute -- the school's usage report lists every holder at zero
 * rather than only those who used something -- and that the first request of the month updates a
 * row instead of racing to create one. A re-run inserts nothing (ON CONFLICT DO NOTHING); meter rows
 * are counters and are not audited, as in session 1.
 */

import { FEATURES } from "@studafy/constants";

import { withSystemTenantTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import type { BillingLogger } from "@studafy/billing";
import type { Sql, TransactionSql } from "postgres";

export interface UsagePeriodStartResult {
  schools: number;
  periodStart: string;
  metersOpened: number;
  failedSchools: number;
}

/** The first day of `now`'s month, UTC, as YYYY-MM-DD. */
export function monthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

/** Metered features (those with a unit), with their audience. */
const METERED = Object.entries(FEATURES)
  .filter(([, feature]) => feature.unit !== null)
  .map(([key, feature]) => ({ key, audience: feature.audience as string }));

export async function openUsagePeriods(tx: TransactionSql, now: Date): Promise<number> {
  const opened = await tx<{ user_id: string }[]>`
    INSERT INTO app.feature_usage_meters (school_id, user_id, feature_key, period_start, used)
    SELECT DISTINCT s.school_id, s.user_id, f.key, ${monthStart(now)}::date, 0
    FROM app.license_seats AS s
    JOIN app.school_licenses AS l ON l.id = s.license_id AND l.school_id = s.school_id
    JOIN app.plans AS p ON p.id = CASE s.audience
                                    WHEN 'student' THEN l.student_plan_id
                                    WHEN 'teacher' THEN l.teacher_plan_id
                                    ELSE l.parent_plan_id
                                  END
    JOIN unnest(${METERED.map((f) => f.key)}::text[], ${METERED.map((f) => f.audience)}::text[])
      AS f (key, audience) ON f.audience = s.audience
    JOIN app.features AS af ON af.key = f.key
    WHERE s.school_id = current_setting('app.school_id')::uuid
      AND s.unassigned_at IS NULL
      AND l.status = 'active'
      AND l.starts_at <= ${now}
      AND l.ends_at > ${now}
      AND (
        p.includes_all_features
        OR EXISTS (
          SELECT 1 FROM app.plan_features AS pf WHERE pf.plan_id = p.id AND pf.feature_key = f.key
        )
      )
    ON CONFLICT ON CONSTRAINT pk_feature_usage_meters DO NOTHING
    RETURNING user_id::text AS user_id
  `;
  return opened.length;
}

export async function runUsagePeriodStart(
  sql: Sql,
  now: Date,
  log: BillingLogger,
  schoolIds?: readonly string[],
): Promise<UsagePeriodStartResult> {
  const schools = schoolIds ?? (await loadSchoolIds(sql));
  const result: UsagePeriodStartResult = {
    schools: schools.length,
    periodStart: monthStart(now),
    metersOpened: 0,
    failedSchools: 0,
  };
  for (const schoolId of schools) {
    try {
      result.metersOpened += await withSystemTenantTx(sql, { schoolId }, (tx) =>
        openUsagePeriods(tx, now),
      );
    } catch (err) {
      result.failedSchools += 1;
      log.warn({ err, school_id: schoolId }, "usage period start failed for school");
    }
  }
  log.info({ ...result }, "usage periods started");
  return result;
}
