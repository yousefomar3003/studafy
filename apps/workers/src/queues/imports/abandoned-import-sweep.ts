/**
 * Abandoned student-import purge sweep (ST-190 follow-up).
 *
 * An uploaded CSV that is never confirmed sits in app.student_imports forever in `uploaded` or
 * `validated` status: the import UI's review step is a dry run the admin can walk away from at any
 * point (close the tab, upload a different file, never come back), and there is no
 * `DELETE /api/imports/students/{importId}` for the client to call even if it wanted to clean up
 * after itself — see apps/web/src/features/admin/students/ImportStudentsPage.tsx's doc comment.
 * Each such row's `rows_data`/`errors` JSONB can be as large as the 10,000-row upload cap, so this
 * is the DB-side closure: once a day it finds unconfirmed imports older than the retention window
 * and deletes them, per school like the dunning/seat/storage/report sweeps, so a school's table
 * doesn't grow without bound.
 *
 * Deliberately scoped to `uploaded`/`validated` only. A `confirmed`/`processing`/`completed`/
 * `failed` row already committed to (or already ran) student creation — that's a real outcome with
 * a summary worth keeping, not an abandoned draft, so it is never a candidate here.
 */

import { withSystemTenantTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import type { Sql } from "postgres";

/** How long an unconfirmed upload survives before this sweep removes it. Generous enough that an
 * admin who uploaded before lunch and confirms after it is never affected. */
export const ABANDONED_IMPORT_RETENTION_HOURS = 48;

export interface PurgeAbandonedImportsResult {
  schools: number;
  /** Unconfirmed import rows removed across every school. */
  removed: number;
  /** Schools whose purge aborted (database error) — ops telemetry, sweep continues. */
  failed: number;
}

export interface PurgeLogger {
  warn: (fields: Record<string, unknown>, message: string) => void;
}

const silentLogger: PurgeLogger = { warn: () => undefined };

export async function purgeAbandonedStudentImports(
  sql: Sql,
  now: Date,
  log: PurgeLogger = silentLogger,
): Promise<PurgeAbandonedImportsResult> {
  const cutoff = new Date(now.getTime() - ABANDONED_IMPORT_RETENTION_HOURS * 60 * 60 * 1000);
  const schoolIds = await loadSchoolIds(sql);
  const result: PurgeAbandonedImportsResult = { schools: schoolIds.length, removed: 0, failed: 0 };

  for (const schoolId of schoolIds) {
    try {
      const removed = await withSystemTenantTx(sql, { schoolId }, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          DELETE FROM app.student_imports
          WHERE school_id = current_setting('app.school_id')::uuid
            AND status IN ('uploaded', 'validated')
            AND created_at < ${cutoff}
          RETURNING id
        `;
        return rows.length;
      });
      result.removed += removed;
    } catch (error) {
      result.failed += 1;
      log.warn(
        { school_id: schoolId, error },
        "abandoned import purge failed for school; rolled back and skipped",
      );
    }
  }

  return result;
}
