/**
 * Storage-quota reconciliation sweep (ST-16x): the scheduled job that keeps every school's
 * app.storage_usage_meters row aligned with the bucket.
 *
 * The API's event-driven meter (apps/api/src/modules/storage/quota-service.ts) can only count what
 * it observes: promotions into permanent/, whose `recordStorageUpload` increments. It cannot see the
 * removals this process performs (malware quarantine moves objects out of permanent/) nor the
 * report objects the bucket lifecycle rule expires, and row deletes intentionally never decrement.
 * The meter therefore drifts low on its own and must be recomputed from the bucket itself — this
 * sweep is the guarantee behind the "meter matches bucket inventory within 1%" acceptance.
 *
 * Once a day, per school, it sums every counted prefix (`permanent/<schoolId>/`, `reports/` and the
 * legacy `tenant-<schoolId>/reports/` — the same three the API counts) and writes the exact figure
 * with app.set_storage_usage. The prefix list and the SQL must match apps/api's
 * `reconcileStorageUsage`; the two are deliberately kept as small, commented twins rather than a
 * shared import because the workers image does not depend on the API. `temp/` and `quarantine/` are
 * never counted, mirroring the API.
 *
 * The same pass reports orphaned files -- permanent/ objects no row points at any more
 * (./storage-orphan-sweep.ts) -- and, only when STORAGE_ORPHAN_REMOVAL=enabled, removes them and
 * leaves their bytes out of the meter.
 *
 * Each school runs in its own `withSystemTenantTx`, mirroring the dunning and seat-reconciliation
 * sweeps: an S3 or database error rolls that school's transaction back and is counted as a failure
 * for ops telemetry, while the schools after it proceed. `loadSchoolIds` runs on the plain
 * connection — app.schools is a global table with no RLS. Every school is reconciled, billed or
 * not, because usage is charged per school regardless of subscription status.
 */

import { withSystemTenantTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import { sweepSchoolOrphans } from "./storage-orphan-sweep";

import type { OrphanReport } from "./storage-orphan-sweep";
import type { StorageQuotaS3Client, StorageQuotaS3Object } from "./storage-quota-s3";
import type { BillingLogger } from "@studafy/billing";
import type { Sql, TransactionSql } from "postgres";

const KIB = 1024;

/** The bucket prefixes that count toward a school's usage — mirrored from apps/api's quota-service. */
function schoolStoragePrefixes(schoolId: string): readonly string[] {
  return [
    `permanent/${schoolId}/`,
    `reports/${schoolId}/`,
    // Finance reports predate the canonical <category>/<schoolId>/ scheme and live under
    // tenant-<schoolId>/reports/; they are still this school's bytes.
    `tenant-${schoolId}/reports/`,
  ];
}

function formatBytes(bytes: number): string {
  if (bytes < KIB) return `${bytes} bytes`;
  if (bytes < KIB * KIB) return `${(bytes / KIB).toFixed(1)} KiB`;
  if (bytes < KIB * KIB * KIB) return `${(bytes / KIB / KIB).toFixed(1)} MiB`;
  return `${(bytes / KIB / KIB / KIB).toFixed(1)} GiB`;
}

export interface StorageQuotaReconciliationResult {
  schools: number;
  /** Schools whose meter moved because the bucket disagreed with it. */
  corrected: number;
  /** Schools whose meter already matched the bucket — the idempotent no-op case. */
  unchanged: number;
  /** Schools whose transaction aborted (S3 or database error) — ops telemetry, job continues. */
  failed: number;
  /** Total bytes measured across all reconciled schools (the sum of the corrected meters). */
  bytesMeasured: number;
  /** Orphaned permanent/ objects found across all schools, and their bytes. */
  orphans: number;
  orphanBytes: number;
  /** Orphans removed (0 unless STORAGE_ORPHAN_REMOVAL=enabled). */
  orphansRemoved: number;
  orphanBytesRemoved: number;
  /**
   * One line per school reconciled this run. The job's return value is what BullMQ keeps for the
   * completed job, and the platform console's system health page reads the latest one, so this is
   * the per-school orphan report there -- no table of its own (it is only a report).
   */
  perSchool: StorageReconciliationSchoolLine[];
}

export interface StorageReconciliationSchoolLine {
  schoolId: string;
  bytesUsed: number;
  orphans: number;
  orphanBytes: number;
  /** The school's transaction aborted this run; its figures are not measured. */
  failed: boolean;
}

export interface StorageQuotaReconciliationOptions {
  /** Delete orphaned objects instead of only reporting them. Off by default. */
  removeOrphans?: boolean;
  now?: Date;
}

export async function runStorageQuotaReconciliation(
  sql: Sql,
  storage: StorageQuotaS3Client,
  log: BillingLogger,
  options: StorageQuotaReconciliationOptions = {},
): Promise<StorageQuotaReconciliationResult> {
  const schoolIds = await loadSchoolIds(sql);
  const result: StorageQuotaReconciliationResult = {
    schools: schoolIds.length,
    corrected: 0,
    unchanged: 0,
    failed: 0,
    bytesMeasured: 0,
    orphans: 0,
    orphanBytes: 0,
    orphansRemoved: 0,
    orphanBytesRemoved: 0,
    perSchool: [],
  };
  const now = options.now ?? new Date();
  const removeOrphans = options.removeOrphans === true;

  for (const schoolId of schoolIds) {
    try {
      const perSchool = await withSystemTenantTx(sql, { schoolId }, (tx) =>
        reconcileSchool(tx, schoolId, storage, log, now, removeOrphans),
      );
      result.bytesMeasured += perSchool.bytesUsed;
      result.orphans += perSchool.orphans.orphans;
      result.orphanBytes += perSchool.orphans.orphanBytes;
      result.orphansRemoved += perSchool.orphans.removed;
      result.orphanBytesRemoved += perSchool.orphans.removedBytes;
      result.perSchool.push({
        schoolId,
        bytesUsed: perSchool.bytesUsed,
        orphans: perSchool.orphans.orphans,
        orphanBytes: perSchool.orphans.orphanBytes,
        failed: false,
      });
      if (perSchool.correctedBy !== 0) {
        result.corrected += 1;
      } else {
        result.unchanged += 1;
      }
    } catch (error) {
      // Per-school failure (S3 unreachable, listing denied, DB error). The transaction rolled
      // back, so the meter keeps its stale value and the next run corrects it; count it for ops
      // and keep the schools after it moving.
      result.failed += 1;
      result.perSchool.push({ schoolId, bytesUsed: 0, orphans: 0, orphanBytes: 0, failed: true });
      log.warn(
        { school_id: schoolId, error },
        "storage quota reconciliation failed for school; rolled back and skipped",
      );
    }
  }

  const { perSchool: _perSchool, ...totals } = result;
  log.info({ ...totals }, "storage quota reconciliation complete");
  return result;
}

async function reconcileSchool(
  tx: TransactionSql,
  schoolId: string,
  storage: StorageQuotaS3Client,
  log: BillingLogger,
  now: Date,
  removeOrphans: boolean,
): Promise<{ bytesUsed: number; correctedBy: number; orphans: OrphanReport }> {
  const [beforeRow] = await tx<{ bytes_used: string | null }[]>`
    SELECT bytes_used::text AS bytes_used
    FROM app.storage_usage_meters
    WHERE school_id = current_setting('app.school_id')::uuid
  `;
  const before = Number(beforeRow?.bytes_used ?? 0);

  let bytesUsed = 0;
  const permanentPrefix = `permanent/${schoolId}/`;
  const permanentObjects: StorageQuotaS3Object[] = [];
  for (const prefix of schoolStoragePrefixes(schoolId)) {
    for await (const object of storage.list(prefix)) {
      bytesUsed += object.sizeBytes;
      if (prefix === permanentPrefix) permanentObjects.push(object);
    }
  }

  const orphans = await sweepSchoolOrphans(
    tx,
    storage,
    schoolId,
    permanentObjects,
    now,
    removeOrphans,
  );
  bytesUsed -= orphans.removedBytes;
  if (orphans.orphans > 0) {
    log.warn(
      { school_id: schoolId, ...orphans, removal_enabled: removeOrphans },
      `orphaned files for school: ${orphans.orphans} (${formatBytes(orphans.orphanBytes)}), ` +
        `${orphans.removed} removed`,
    );
  }

  const rows = await tx<{ set_storage_usage: string }[]>`
    SELECT app.set_storage_usage(${bytesUsed})::text AS set_storage_usage
  `;
  const after = Number(rows[0]?.set_storage_usage ?? 0);
  const correctedBy = after - before;

  if (correctedBy !== 0) {
    log.warn(
      { school_id: schoolId, correctedBy, bytesUsed: after },
      `storage usage reconciled for school: ${formatBytes(before)} -> ${formatBytes(after)}`,
    );
  }

  return { bytesUsed: after, correctedBy, orphans };
}
