/**
 * Malware scanning of user uploads other than study materials (security finding F-14).
 *
 * Every write that stores a file someone else will download leaves its row's scan status at
 * `scanning` (000192) and, once that write has committed, hands the file to the workers' file-scan
 * queue as a `scan-upload` job (apps/workers/src/queues/scan/scan-upload.worker.ts). Until the
 * worker answers `clean`, every read path refuses to mint a download URL for it: a list returns the
 * file with a null URL, a download route answers as if the file were absent. `unscanned` (uploaded
 * before 000192) is served.
 *
 * The enqueue runs after commit because the worker claims the row by its status and key: a job that
 * ran before the row was visible would skip it and leave it `scanning` for good. The same reason the
 * material confirm route enqueues after its transaction (material-routes.ts).
 *
 * An enqueue that fails, or a deployment without Redis, leaves the file `scanning`: unserved, never
 * served unscanned. The failure is logged rather than thrown, because the write it follows has
 * already committed: failing the response would invite a retry that sends a message twice or
 * attaches a second copy of the file, while the file itself stays safe either way.
 */

import { JOB_NAMES, QUEUE_NAMES, isServableUploadScanStatus } from "@studafy/constants";
import { Queue } from "bullmq";

import type { AppEnv } from "../../middleware/requestId";
import type { RedisClient } from "../../redis";
import type { UploadScanTarget } from "@studafy/constants";
import type { Context } from "hono";

export { isServableUploadScanStatus };

/** One file to scan: which kind of upload it is, whose, and its permanent key. */
export interface UploadScanRequest {
  target: UploadScanTarget;
  /** The owning school; null only for a school application's proof, which has none yet. */
  schoolId: string | null;
  storageKey: string;
}

export type UploadScanEnqueuer = (requests: readonly UploadScanRequest[]) => Promise<void>;

/** Mirrors the material scan job's options (material-routes.ts). */
export const UPLOAD_SCAN_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 60 * 60 },
  removeOnFail: { age: 30 * 24 * 60 * 60 },
} as const;

/** The production enqueuer: `scan-upload` jobs on the file-scan queue. Null without Redis. */
export function createUploadScanEnqueuer(redis: RedisClient | null): UploadScanEnqueuer | null {
  if (!redis) return null;
  const queue = new Queue(QUEUE_NAMES.SCAN, { connection: redis as never });
  return async (requests) => {
    if (requests.length === 0) return;
    await queue.addBulk(
      requests.map((request) => ({
        name: JOB_NAMES.SCAN_UPLOAD,
        data: {
          target: request.target,
          schoolId: request.schoolId,
          storageKey: request.storageKey,
        },
        opts: UPLOAD_SCAN_JOB_OPTIONS,
      })),
    );
  };
}

/**
 * Hand committed uploads to the scanner. Call only after the transaction that stored them has
 * committed. Never throws (see the header): without an enqueuer, or when the enqueue fails, the
 * files stay `scanning` and are not served.
 */
export async function enqueueUploadScans(
  c: Context<AppEnv>,
  requests: readonly UploadScanRequest[],
): Promise<void> {
  if (requests.length === 0) return;
  const enqueue = c.get("uploadScan");
  const log = c.get("log");
  if (!enqueue) {
    log?.warn(
      { event: "upload_scan_not_enqueued", targets: requests.map((request) => request.target) },
      "no scan queue configured; the uploaded files stay unserved until they are scanned",
    );
    return;
  }
  try {
    await enqueue(requests);
  } catch (error) {
    log?.error(
      {
        event: "upload_scan_enqueue_failed",
        targets: requests.map((request) => request.target),
        err: error,
      },
      "could not enqueue upload scans; the uploaded files stay unserved until they are scanned",
    );
  }
}
