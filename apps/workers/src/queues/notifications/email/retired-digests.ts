/**
 * The retired daily digest emails.
 *
 * Studafy sends no notification email: notifications go to the in-app inbox and to phone push
 * only (product decision, 2026-11). Two daily jobs used to email them anyway:
 *
 *   - `send-digests` (06:00 UTC): a per-parent email of attendance alerts and overdue fees, built
 *     from attendance.alertRaised / fee.installmentOverdue outbox rows.
 *   - `send-notification-digests` (06:30 UTC): a per-recipient email of the in-app notifications
 *     whose email preference had `digest` set.
 *
 * Both producers are gone. Three things keep a digest from going out regardless:
 *
 *   1. Every worker boot removes the two BullMQ Job Schedulers from Redis. A scheduler outlives the
 *      code that registered it, so deleting the `upsertJobScheduler` calls alone would leave the
 *      cron firing in production. `removeJobScheduler` is idempotent: once gone, it is a no-op.
 *   2. A job of either name that is already queued (or arrives from an older worker during a deploy)
 *      is acknowledged by the registry without doing anything.
 *   3. The email dispatcher drops any digest.sent / notification.digestSent outbox row it claims
 *      without sending it (RETIRED_EMAIL_EVENT_NAMES in resolve.ts), so a digest produced before
 *      this change is never mailed.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/** The scheduler ids the retired producers registered on the notifications queue. */
export const RETIRED_DIGEST_SCHEDULER_IDS: readonly string[] = [
  "parent-digest-daily",
  "notification-digest-daily",
];

/** Job names the registry acknowledges and drops (see point 2 above). */
export const RETIRED_DIGEST_JOB_NAMES: ReadonlySet<string> = new Set([
  JOB_NAMES.SEND_DIGESTS,
  JOB_NAMES.SEND_NOTIFICATION_DIGESTS,
]);

/** What the registry returns for a dropped digest job, so the job record says why it did nothing. */
export interface RetiredDigestResult {
  processed: true;
  skipped: "notification-email-retired";
}

export function skipRetiredDigestJob(): RetiredDigestResult {
  return { processed: true, skipped: "notification-email-retired" };
}

/** Remove the retired digest schedulers from Redis. Safe to call on every boot. */
export async function removeRetiredDigestSchedulers(connection: ConnectionOptions): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.NOTIFICATIONS, { connection });
  try {
    for (const id of RETIRED_DIGEST_SCHEDULER_IDS) {
      await queue.removeJobScheduler(id);
    }
  } finally {
    await queue.close();
  }
}
