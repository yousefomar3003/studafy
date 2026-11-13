/**
 * Storage quota service: the tenant ceiling on object-storage bytes and the meter that enforces
 * it (ST-16x).
 *
 * The metering model is deliberately simple and honest about what the API can and cannot observe:
 *
 *   - The meter is a per-school counter in app.storage_usage_meters, incremented when an object is
 *     promoted into permanent/ and decremented when one is removed. A row delete or replace does
 *     not decrement it by itself: once the transaction has committed, the caller removes the
 *     object and releases exactly the bytes it removed (./free-objects.ts), so a file whose
 *     removal failed stays counted -- the meter never drifts below the bucket, the exact thing the
 *     1% tolerance guards against. (Records and the import source release in the deleting
 *     transaction and remove afterwards; a failed removal there is caught by reconciliation.)
 *   - Removals this process cannot observe -- malware quarantine in the workers app, report
 *     objects the bucket lifecycle rule expires -- are corrected by the daily reconciliation job,
 *     which recomputes the meter from the bucket itself. That job is what keeps the meter within
 *     the acceptance tolerance; the event-driven changes only keep enforcement fresh between runs.
 *     Objects no row points at any more are found by the orphan sweep
 *     (apps/workers/src/queues/billing/storage-orphan-sweep.ts).
 *   - Enforcement is claim-based at request-upload (the body's size_bytes) and authoritative at
 *     confirm (the stored size, re-read from the bucket before promotion). A school at 99% cannot
 *     smuggle a 25 MiB file in under a 2 MiB claim: confirm's beforePromote hook re-checks the
 *     stored size and refuses the promotion.
 *
 * Everything here is tenant-scoped through the same mechanism as student-cap: each query reads and
 * writes under current_setting('app.school_id'), so a caller can only ever see or move its own
 * school's bytes.
 */

import { LIVE_STATUSES } from "@studafy/billing";
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
 * Read the school's current usage and its cap in one tenant-scoped round trip.
 * A school with no meter row yet counts as zero; one with no subscription falls back to the plan
 * default so enforcement never disappears for an unprovisioned tenant.
 *
 * The cap is the larger of what the subscription includes and the cap of a live storage add-on
 * (app.storage_subscriptions, 000205). Billing never writes the school's cap: an add-on that is
 * canceled, expires or is closed after its grace period simply stops counting here, and the school
 * keeps every file -- only uploads past the smaller cap are refused.
 *
 * A storage grant Studafy staff made by hand (app.manual_grants, 000211 -- a cash payment, a pilot)
 * counts the same way while it is in force: the cap is the largest of the three, and a grant that
 * ends or is revoked just stops counting.
 */
export async function getStorageUsage(tx: TransactionSql): Promise<StorageUsage> {
  const [row] = await tx<
    {
      bytes_used: string | null;
      cap_bytes: string | null;
      addon_cap_bytes: string | null;
      grant_cap_bytes: string | null;
    }[]
  >`
    SELECT
      (SELECT bytes_used::text FROM app.storage_usage_meters
       WHERE school_id = current_setting('app.school_id')::uuid) AS bytes_used,
      (SELECT storage_cap_bytes::text FROM app.subscriptions
       WHERE school_id = current_setting('app.school_id')::uuid) AS cap_bytes,
      (SELECT cap_bytes::text FROM app.storage_subscriptions
       WHERE school_id = current_setting('app.school_id')::uuid
         AND status::text = ANY(${[...LIVE_STATUSES]})) AS addon_cap_bytes,
      (SELECT max(cap_bytes)::text FROM app.manual_grants
       WHERE school_id = current_setting('app.school_id')::uuid
         AND kind = 'storage' AND revoked_at IS NULL
         AND starts_at <= now() AND ends_at > now()) AS grant_cap_bytes
  `;

  const bytesUsed = Number(row?.bytes_used ?? 0);
  const capBytes = Math.max(
    Number(row?.cap_bytes ?? DEFAULT_STORAGE_CAP_BYTES),
    Number(row?.addon_cap_bytes ?? 0),
    Number(row?.grant_cap_bytes ?? 0),
  );

  return { bytesUsed, capBytes, fractionUsed: capBytes > 0 ? bytesUsed / capBytes : NaN };
}

/** The storage grant in force now with the largest cap, or null. */
export interface StorageGrantInForce {
  capBytes: number;
  endsAt: Date;
}

/**
 * The in-force manual storage grant (app.manual_grants, 000211) that sets the largest cap -- what the
 * school's Storage tab shows as "Granted by Studafy until <date>". Tenant-scoped like the rest.
 */
export async function findStorageGrantInForce(
  tx: TransactionSql,
): Promise<StorageGrantInForce | null> {
  const [row] = await tx<{ cap_bytes: string; ends_at: Date }[]>`
    SELECT cap_bytes::text AS cap_bytes, ends_at
    FROM app.manual_grants
    WHERE school_id = current_setting('app.school_id')::uuid
      AND kind = 'storage' AND revoked_at IS NULL
      AND starts_at <= now() AND ends_at > now()
    ORDER BY cap_bytes DESC, ends_at DESC
    LIMIT 1
  `;
  return row ? { capBytes: Number(row.cap_bytes), endsAt: row.ends_at } : null;
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
 * and ./free-objects.ts.
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
