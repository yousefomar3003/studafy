/**
 * Scheduled-publish sweep for announcements (ST-194).
 *
 * Finds every `scheduled` announcement whose `scheduled_at` is due and publishes it via
 * @studafy/announcements' `publishAnnouncement` — the same function the API calls synchronously for
 * an immediate send, so "publish now" and "publish once the schedule catches up" are one code path,
 * not two that could drift.
 *
 * Each school runs in its own transaction, mirroring the report-expiry, dunning, seat and
 * storage-quota sweeps: a database error rolls that school's step back and is counted for ops
 * telemetry while the schools after it proceed. The pipeline is crash-safe because
 * `publishAnnouncement`'s claim (`UPDATE ... WHERE status = 'scheduled'`) is the idempotency
 * boundary — a school that failed mid-sweep is simply selected again next tick, and an announcement
 * already claimed by a previous tick is not re-selected.
 */

import { publishAnnouncement } from "@studafy/announcements";

import { withSystemTenantTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import type { Sql } from "postgres";

export interface PublishDueAnnouncementsResult {
  schools: number;
  published: number;
  /** Schools whose sweep step aborted (database error) — ops telemetry, job continues. */
  failed: number;
}

export interface SweepLogger {
  warn: (fields: Record<string, unknown>, message: string) => void;
}

const silentLogger: SweepLogger = { warn: () => undefined };

export async function publishDueAnnouncements(
  sql: Sql,
  now: Date,
  log: SweepLogger = silentLogger,
): Promise<PublishDueAnnouncementsResult> {
  const schoolIds = await loadSchoolIds(sql);
  const result: PublishDueAnnouncementsResult = {
    schools: schoolIds.length,
    published: 0,
    failed: 0,
  };

  for (const schoolId of schoolIds) {
    try {
      const published = await publishDueForSchool(sql, schoolId, now);
      result.published += published;
    } catch (error) {
      result.failed += 1;
      log.warn(
        { school_id: schoolId, error },
        "announcement publish sweep failed for school; rolled back and skipped",
      );
    }
  }

  return result;
}

async function publishDueForSchool(sql: Sql, schoolId: string, now: Date): Promise<number> {
  return withSystemTenantTx(sql, { schoolId }, async (tx) => {
    const due = await tx<{ id: string }[]>`
      SELECT id FROM app.announcements
      WHERE school_id = current_setting('app.school_id')::uuid
        AND status = 'scheduled'
        AND scheduled_at <= ${now}::timestamptz
      ORDER BY scheduled_at ASC
    `;
    let published = 0;
    for (const row of due) {
      const outcome = await publishAnnouncement(tx, schoolId, row.id, now);
      if (outcome.published) published += 1;
    }
    return published;
  });
}
