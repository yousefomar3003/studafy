/**
 * The upload-scan sweep (QA-055): every file waiting for a verdict gets a scan job.
 *
 * The API enqueues a file's `scan-upload` job after the upload commits, and only logs a failed
 * enqueue (lib/storage/upload-scan.ts): a Redis blip there left the file `scanning` -- unserved --
 * until someone repaired it by hand. Every 15 minutes this re-enqueues:
 *
 * - files still `scanning` 15 minutes after their row last changed (the job was lost, or its
 *   retries ran out while the scanner was down and the failure listener did not run);
 * - files still `unscanned`: uploaded before scanning covered their kind (000192), which that
 *   migration left for a backfill. The worker accepts `unscanned` and settles it like a new upload.
 *
 * Re-enqueueing is safe: the worker moves a row only out of `scanning`/`unscanned`, so a job that
 * finds a verdict already recorded is a no-op. The job id carries the hour, so one stuck file costs
 * at most one queued job an hour, however long the scanner is down.
 */

import { UPLOAD_SCAN_TARGETS } from "@studafy/constants";

import { withSystemTenantTx, withSystemTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import { UPLOAD_SCAN_TARGET_SPECS } from "./scan-upload.worker";

import type { UploadScanTarget } from "@studafy/constants";
import type { Sql, TransactionSql } from "postgres";

/** How long a file may sit in `scanning` before its job is presumed lost. */
export const STUCK_SCAN_AFTER_MS = 15 * 60_000;

/** Files re-enqueued per target per school per run; the rest wait for the next run. */
export const STUCK_SCAN_BATCH_SIZE = 200;

/** Every 15 minutes. */
export const STUCK_SCAN_SWEEP_CRON_PATTERN = "*/15 * * * *";

export interface UploadScanJobRequest {
  target: UploadScanTarget;
  schoolId: string | null;
  storageKey: string;
}

export type EnqueueUploadScanJobs = (requests: readonly UploadScanJobRequest[]) => Promise<void>;

export interface StuckScanSweepResult {
  enqueued: number;
  /** Schools (or the global pass) whose read or enqueue failed; retried on the next run. */
  failed: number;
}

interface SweepLogger {
  warn: (fields: Record<string, unknown>, message: string) => void;
}

/** The column that says when a row last changed. Message attachments are never updated. */
function changedAtColumn(target: UploadScanTarget): string {
  return target === "message_attachment" ? "created_at" : "updated_at";
}

async function waitingKeys(
  tx: TransactionSql,
  target: UploadScanTarget,
  cutoff: Date,
): Promise<string[]> {
  const spec = UPLOAD_SCAN_TARGET_SPECS[target];
  const rows = await tx<{ key: string }[]>`
    SELECT ${tx(spec.keyColumn)} AS key
    FROM ${tx(`app.${spec.table}`)}
    WHERE ${tx(spec.keyColumn)} IS NOT NULL
      AND (
        ${tx(spec.statusColumn)} = 'unscanned'
        OR (${tx(spec.statusColumn)} = 'scanning' AND ${tx(changedAtColumn(target))} < ${cutoff})
      )
    ORDER BY ${tx(changedAtColumn(target))}
    LIMIT ${STUCK_SCAN_BATCH_SIZE}
  `;
  return rows.map((row) => row.key);
}

export async function sweepStuckUploadScans(
  sql: Sql,
  enqueue: EnqueueUploadScanJobs,
  now: Date = new Date(),
  log: SweepLogger = { warn: () => undefined },
): Promise<StuckScanSweepResult> {
  const cutoff = new Date(now.getTime() - STUCK_SCAN_AFTER_MS);
  const result: StuckScanSweepResult = { enqueued: 0, failed: 0 };
  const schoolTargets = UPLOAD_SCAN_TARGETS.filter(
    (target) => UPLOAD_SCAN_TARGET_SPECS[target].scope === "school",
  );
  const globalTargets = UPLOAD_SCAN_TARGETS.filter(
    (target) => UPLOAD_SCAN_TARGET_SPECS[target].scope === "global",
  );

  const flush = async (requests: UploadScanJobRequest[]) => {
    if (requests.length === 0) return;
    await enqueue(requests);
    result.enqueued += requests.length;
  };

  for (const schoolId of await loadSchoolIds(sql)) {
    try {
      const requests = await withSystemTenantTx(sql, { schoolId }, async (tx) => {
        const found: UploadScanJobRequest[] = [];
        for (const target of schoolTargets) {
          for (const storageKey of await waitingKeys(tx, target, cutoff)) {
            found.push({ target, schoolId, storageKey });
          }
        }
        return found;
      });
      await flush(requests);
    } catch (error) {
      result.failed += 1;
      log.warn(
        { school_id: schoolId, error },
        "upload scan sweep failed for school; retried next run",
      );
    }
  }

  try {
    const requests = await withSystemTx(sql, async (tx) => {
      const found: UploadScanJobRequest[] = [];
      for (const target of globalTargets) {
        for (const storageKey of await waitingKeys(tx, target, cutoff)) {
          found.push({ target, schoolId: null, storageKey });
        }
      }
      return found;
    });
    await flush(requests);
  } catch (error) {
    result.failed += 1;
    log.warn({ error }, "upload scan sweep failed for global uploads; retried next run");
  }

  return result;
}
