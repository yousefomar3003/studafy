/**
 * Storage quota service: the tenant ceiling on object-storage bytes and the meter that enforces
 * it (ST-16x).
 *
 * The metering model is deliberately simple and honest about what the API can and cannot observe:
 *
 *   - The meter is a per-school counter in app.storage_usage_meters, incremented when an object is
 *     promoted into permanent/ and never decremented by a row delete (this codebase orphans the S3
 *     object on delete by documented policy, so the bytes still exist — a decrement there would
 *     drift the meter below the bucket, the exact thing the 1% tolerance guards against).
 *   - The only in-app S3 removal of a permanent object happens in the workers app (malware
 *     quarantine), and report objects self-expire via the bucket lifecycle rule — neither is
 *     observable from here. Both are corrected by the daily reconciliation job, which recomputes
 *     the meter from the bucket itself. That job is what keeps the meter within the acceptance
 *     tolerance; the event-driven increments only keep enforcement fresh between runs.
 *   - Enforcement is claim-based at request-upload (the body's size_bytes) and authoritative at
 *     confirm (the stored size, re-read from the bucket before promotion). A school at 99% cannot
 *     smuggle a 25 MiB file in under a 2 MiB claim: confirm's beforePromote hook re-checks the
 *     stored size and refuses the promotion.
 *
 * Everything here is tenant-scoped through the same mechanism as student-cap: each query reads and
 * writes under current_setting('app.school_id'), so a caller can only ever see or move its own
 * school's bytes.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";

import type { StorageService } from "../../lib/storage";
import type { TransactionSql } from "postgres";

/**
 * Mirrored from db/migrations/000092. Plans carry no quota column (they are pure metadata); the
 * cap lives on app.subscriptions.storage_cap_bytes, seeded from this default at provisioning.
 */
export const DEFAULT_STORAGE_CAP_BYTES = 10 * 1024 * 1024 * 1024;

/** Above this fraction of the cap the API surfaces a soft warning on upload responses. */
export const STORAGE_QUOTA_WARNING_THRESHOLD = 0.8;

const KIB = 1024;

/** The bucket prefixes that count toward a school's usage. */
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

export interface StorageUsage {
  bytesUsed: number;
  capBytes: number;
  /** Fraction of the cap in use, 0..1; NaN when no cap is configured. */
  fractionUsed: number;
}

/**
 * Read the school's current usage and its subscription cap in one tenant-scoped round trip.
 * A school with no meter row yet counts as zero; one with no subscription falls back to the plan
 * default so enforcement never disappears for an unprovisioned tenant.
 */
export async function getStorageUsage(tx: TransactionSql): Promise<StorageUsage> {
  const [row] = await tx<{ bytes_used: string | null; cap_bytes: string | null }[]>`
    SELECT
      (SELECT bytes_used::text FROM app.storage_usage_meters
       WHERE school_id = current_setting('app.school_id')::uuid) AS bytes_used,
      (SELECT storage_cap_bytes::text FROM app.subscriptions
       WHERE school_id = current_setting('app.school_id')::uuid) AS cap_bytes
  `;

  const bytesUsed = Number(row?.bytes_used ?? 0);
  const capBytes = Number(row?.cap_bytes ?? DEFAULT_STORAGE_CAP_BYTES);

  return { bytesUsed, capBytes, fractionUsed: capBytes > 0 ? bytesUsed / capBytes : NaN };
}

/**
 * Refuse an upload whose claimed size would take the school past its cap.
 *
 * 402 rather than 403: the caller is authenticated and entitled, it is the *plan* that says no —
 * the same code the student-cap enforcement and the openapi 402 mapping use for plan ceilings.
 * The message is actionable: it names the used/cap figures and the two ways out (delete or upgrade).
 */
export async function assertStorageUploadQuota(
  tx: TransactionSql,
  sizeBytes: number,
): Promise<StorageUsage> {
  const usage = await getStorageUsage(tx);

  if (usage.bytesUsed + sizeBytes > usage.capBytes) {
    throw new CodedHttpException(
      402,
      ERROR_CODES.STORAGE_QUOTA_EXCEEDED,
      `Storage quota exceeded: ${formatBytes(usage.bytesUsed)} of ${formatBytes(usage.capBytes)} ` +
        `in use. Free space by deleting files, or upgrade your plan.`,
    );
  }

  return usage;
}

/**
 * Count a promoted permanent object toward the school's usage. Atomic under row-level locking, so
 * concurrent confirms cannot lose bytes.
 */
export async function recordStorageUpload(tx: TransactionSql, sizeBytes: number): Promise<number> {
  if (sizeBytes <= 0) return 0;
  const rows = await tx<{ add_storage_usage: string }[]>`
    SELECT app.add_storage_usage(${sizeBytes})::text AS add_storage_usage
  `;
  return Number(rows[0]?.add_storage_usage ?? 0);
}

/**
 * Release bytes from the meter, floored at zero. Only for actual S3 removals; see the module header
 * for why row deletes do not reach here.
 */
export async function releaseStorageUsage(tx: TransactionSql, sizeBytes: number): Promise<number> {
  if (sizeBytes <= 0) return 0;
  const rows = await tx<{ add_storage_usage: string }[]>`
    SELECT app.add_storage_usage(${-sizeBytes})::text AS add_storage_usage
  `;
  return Number(rows[0]?.add_storage_usage ?? 0);
}

export interface StorageReconcileResult {
  bytesUsed: number;
  objectCount: number;
  /** Meter delta: positive when the meter had drifted low, negative when high. */
  correctedBy: number;
}

/**
 * Recompute a school's meter from the bucket and store the exact figure.
 *
 * This is the guarantee behind the "meter matches bucket inventory" criterion: it sums every
 * counted prefix for the school, so orphaned objects, quarantined deletions, and lifecycle
 * expirations that the event-driven counter could never see all converge here. The job processor
 * in apps/workers calls an equivalent loop daily; this exported form serves on-demand runs.
 *
 * Must be called inside a transaction whose app.school_id GUC is set for `schoolId` (the workers'
 * withSystemTenantTx, or the API's withTenantTx + setTenantScope).
 */
export async function reconcileStorageUsage(
  tx: TransactionSql,
  schoolId: string,
  storage: StorageService,
  log?: { warn: (msg: string) => void },
): Promise<StorageReconcileResult> {
  const [beforeRow] = await tx<{ bytes_used: string | null }[]>`
    SELECT bytes_used::text AS bytes_used
    FROM app.storage_usage_meters
    WHERE school_id = current_setting('app.school_id')::uuid
  `;
  const before = Number(beforeRow?.bytes_used ?? 0);

  let bytesUsed = 0;
  let objectCount = 0;
  for (const prefix of schoolStoragePrefixes(schoolId)) {
    for await (const object of storage.list(prefix)) {
      bytesUsed += object.sizeBytes;
      objectCount += 1;
    }
  }

  const rows = await tx<{ set_storage_usage: string }[]>`
    SELECT app.set_storage_usage(${bytesUsed})::text AS set_storage_usage
  `;
  const after = Number(rows[0]?.set_storage_usage ?? 0);
  const correctedBy = after - before;

  if (log && Math.abs(correctedBy) > 0) {
    log.warn(
      `storage usage reconciled for school ${schoolId}: ${formatBytes(before)} -> ` +
        `${formatBytes(after)} (${correctedBy >= 0 ? "+" : ""}${formatBytes(correctedBy)}, ` +
        `${objectCount} objects)`,
    );
  }

  return { bytesUsed: after, objectCount, correctedBy };
}
