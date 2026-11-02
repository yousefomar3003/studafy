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
 * Each school runs in its own `withSystemTenantTx`, mirroring the dunning and seat-reconciliation
 * sweeps: an S3 or database error rolls that school's transaction back and is counted as a failure
 * for ops telemetry, while the schools after it proceed. `loadSchoolIds` runs on the plain
 * connection — app.schools is a global table with no RLS. Every school is reconciled, billed or
 * not, because usage is charged per school regardless of subscription status.
 */

import { withSystemTenantTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import type { StorageQuotaS3Client } from "./storage-quota-s3";
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
}

export async function runStorageQuotaReconciliation(
  sql: Sql,
  storage: StorageQuotaS3Client,
  log: BillingLogger,
): Promise<StorageQuotaReconciliationResult> {
  const schoolIds = await loadSchoolIds(sql);
  const result: StorageQuotaReconciliationResult = {
    schools: schoolIds.length,
    corrected: 0,
    unchanged: 0,
    failed: 0,
    bytesMeasured: 0,
  };

  for (const schoolId of schoolIds) {
    try {
      const perSchool = await withSystemTenantTx(sql, { schoolId }, (tx) =>
        reconcileSchool(tx, schoolId, storage, log),
      );
      result.bytesMeasured += perSchool.bytesUsed;
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
      log.warn(
        { school_id: schoolId, error },
        "storage quota reconciliation failed for school; rolled back and skipped",
      );
    }
  }

  log.info({ ...result }, "storage quota reconciliation complete");
  return result;
}

async function reconcileSchool(
  tx: TransactionSql,
  schoolId: string,
  storage: StorageQuotaS3Client,
  log: BillingLogger,
): Promise<{ bytesUsed: number; correctedBy: number }> {
  const [beforeRow] = await tx<{ bytes_used: string | null }[]>`
    SELECT bytes_used::text AS bytes_used
    FROM app.storage_usage_meters
    WHERE school_id = current_setting('app.school_id')::uuid
  `;
  const before = Number(beforeRow?.bytes_used ?? 0);

  let bytesUsed = 0;
  for (const prefix of schoolStoragePrefixes(schoolId)) {
    for await (const object of storage.list(prefix)) {
      bytesUsed += object.sizeBytes;
    }
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

  return { bytesUsed: after, correctedBy };
}
