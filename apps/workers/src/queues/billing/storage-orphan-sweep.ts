/**
 * Orphaned-file report for the daily storage-quota reconciliation (runs inside it, per school).
 *
 * Until 2026-11 deleting a material, an assignment, an attachment or a question picture removed
 * only the row: the stored object stayed in permanent/<schoolId>/ and kept counting toward the
 * school's quota. The API now frees those objects as it deletes (apps/api/src/modules/storage/
 * free-objects.ts); this finds the ones left behind before that, or by a removal that failed.
 *
 * An orphan is a permanent/<schoolId>/ object at least ORPHAN_MIN_AGE_DAYS old that no row of the
 * school points at, per app.referenced_storage_keys (000204) -- the single list of every
 * storage-key column, shared with the API. The age floor covers the window between an upload
 * being promoted and the row that uses it being written (an expense is given its key in a later
 * request), with a wide margin.
 *
 * REPORT-ONLY by default: it counts orphans and their bytes per school and logs them. Removing
 * them deletes school data and is switched on only by STORAGE_ORPHAN_REMOVAL=enabled on the
 * workers, after someone has read the report. No bucket prefix with a long expiry exists to move
 * them to instead (temp/ expires after 24 hours, which is no undo window), so removal is a plain
 * delete.
 */

import type { StorageQuotaS3Client, StorageQuotaS3Object } from "./storage-quota-s3";
import type { TransactionSql } from "postgres";

export const ORPHAN_MIN_AGE_DAYS = 7;
const REFERENCE_BATCH = 500;

export interface OrphanReport {
  /** Unreferenced objects old enough to count as orphans. */
  orphans: number;
  orphanBytes: number;
  /** Of those, removed this run (always 0 unless removal is enabled). */
  removed: number;
  removedBytes: number;
}

/**
 * Find (and, when `remove` is set, delete) the school's orphaned objects among `objects` -- the
 * listing of `permanent/<schoolId>/` the reconciliation already made. Must run inside a
 * transaction whose app.school_id is `schoolId`.
 */
export async function sweepSchoolOrphans(
  tx: TransactionSql,
  storage: StorageQuotaS3Client,
  schoolId: string,
  objects: readonly StorageQuotaS3Object[],
  now: Date,
  remove: boolean,
): Promise<OrphanReport> {
  const report: OrphanReport = { orphans: 0, orphanBytes: 0, removed: 0, removedBytes: 0 };
  const prefix = `permanent/${schoolId}/`;
  const cutoff = now.getTime() - ORPHAN_MIN_AGE_DAYS * 24 * 60 * 60 * 1000;

  // An object with no timestamp is treated as new: never guess that a file is old enough to go.
  const candidates = objects.filter(
    (object) =>
      object.key.startsWith(prefix) &&
      object.lastModified !== undefined &&
      object.lastModified.getTime() < cutoff,
  );

  for (let start = 0; start < candidates.length; start += REFERENCE_BATCH) {
    const batch = candidates.slice(start, start + REFERENCE_BATCH);
    const keys = batch.map((object) => object.key);
    const live = await tx<{ key: string }[]>`
      SELECT app.referenced_storage_keys(${keys}::text[]) AS key
    `;
    const referenced = new Set(live.map((row) => row.key));

    for (const object of batch) {
      if (referenced.has(object.key)) continue;
      report.orphans += 1;
      report.orphanBytes += object.sizeBytes;
      if (!remove || !storage.remove) continue;
      try {
        await storage.remove(object.key);
        report.removed += 1;
        report.removedBytes += object.sizeBytes;
      } catch {
        // Stays counted; the next run tries again.
      }
    }
  }

  return report;
}

/** Whether the workers may delete orphans, rather than only report them. Off unless set exactly. */
export function orphanRemovalEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.STORAGE_ORPHAN_REMOVAL === "enabled";
}
