/**
 * Retrying a Stripe webhook that failed transiently, and dead-lettering it when it will not (ST-132).
 *
 * ## Why the job carries only an id
 *
 * The verified payload is already durable in `app.billing_events` -- it was written by the claim in
 * the same transaction that later failed to finish. A job carrying its own copy could disagree with
 * the row, and there would be no way to tell which was right. So the job carries the provider event
 * id and this module reads the rest.
 *
 * The signature is **not** re-verified on retry, and cannot be: verification happens once, at
 * intake, over the exact raw bytes of the HTTP request, and those bytes are gone. What is stored is
 * the parsed object. The trust boundary was crossed at intake; a row in `app.billing_events` exists
 * only because a valid signature put it there.
 *
 * ## Why the processing itself is imported, not reimplemented
 *
 * `processBillingEvent`'s sibling `reprocessClaimedEvent` is the same code the API runs, from
 * `@studafy/billing`. A retry that applied slightly different rules than the original attempt would
 * be a subscription in the wrong state -- and the difference would never show up as a test failure,
 * only as a support ticket.
 */

import { reprocessClaimedEvent, truncateError } from "@studafy/billing";
import { JOB_NAMES } from "@studafy/constants";
import postgres from "postgres";

import { emitAuditLog } from "../../db/audit";
import { withSystemTx } from "../../db/tenant-tx";
import { describeError, isTerminalFailure } from "../notifications/dead-letter";

import type { DeadLetterLogger, FailedHandler } from "../notifications/dead-letter";
import type { BillingLogger, ProcessOutcome } from "@studafy/billing";

/** The subset of the row a retry needs to reconstruct the event. */
interface StoredEvent {
  id: string;
  provider_event_id: string;
  event_type: string;
  effective_at: Date;
  payload: Record<string, unknown>;
  status: string;
}

export interface ProcessBillingEventResult {
  processed: boolean;
  reason?: string;
  outcome?: ProcessOutcome["outcome"];
}

/**
 * Re-apply one previously claimed billing event.
 *
 * Throws on a transient failure, which is what lets BullMQ retry it and, once retries are exhausted,
 * hand it to the dead-letter listener. Returns without throwing for every terminal outcome --
 * including "already processed", which is the ordinary result of a retry racing a redelivery that
 * succeeded first.
 */
export async function processStripeBillingEvent(
  data: { providerEventId: string },
  databaseUrl: string,
  log: BillingLogger,
): Promise<ProcessBillingEventResult> {
  const sql = postgres(databaseUrl, { max: 1, idle_timeout: 20, prepare: false });

  try {
    return await withSystemTx(sql, async (tx) => {
      // FOR UPDATE, so a concurrent retry of the same event waits rather than folding the same
      // history twice. The unique key makes that lock a per-event one.
      const rows = await tx<StoredEvent[]>`
        SELECT id, provider_event_id, event_type, effective_at, payload, status::text AS status
        FROM app.billing_events
        WHERE provider = 'stripe' AND provider_event_id = ${data.providerEventId}
        FOR UPDATE
      `;

      const row = rows[0];
      if (!row) {
        // The claim rolled back with the failed transaction, so there is nothing to retry and the
        // event was never applied. Stripe's own redelivery is the recovery path here, not this job.
        return { processed: false, reason: "no billing_events row for this provider event id" };
      }

      if (row.status === "processed") {
        return { processed: true, outcome: "duplicate" as const };
      }

      if (row.status === "dlq") {
        // Parked deliberately -- unmapped, unattributable or an illegal transition. Re-running would
        // reach the same verdict; only a human changes this outcome.
        return { processed: false, reason: "event is parked in the dead-letter state" };
      }

      const result = await reprocessClaimedEvent(
        tx,
        row.id,
        {
          id: row.provider_event_id,
          type: row.event_type,
          effectiveAt: row.effective_at,
          data: row.payload,
        },
        { emitAudit: emitAuditLog, logger: log },
      );

      return { processed: true, outcome: result.outcome };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Mark an event dead-lettered after BullMQ has given up on it.
 *
 * The durable dead-letter record is the `app.billing_events` row itself -- `status = 'dlq'`, the
 * reason in `last_error`, the attempt count, and the verbatim provider payload. A separate
 * dead-letter table would be a second copy of data this one already holds in full, and a replay tool
 * would then have to reconcile them. `app.notification_dead_letters` exists because a notification
 * job's data is *not* otherwise persisted; a billing event's is.
 *
 * Runs on its own connection because the job's transaction is long gone by the time BullMQ decides
 * a failure was terminal.
 */
export async function deadLetterStripeBillingEvent(
  providerEventId: string,
  reason: string,
  databaseUrl: string,
): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, idle_timeout: 20, prepare: false });

  try {
    await withSystemTx(sql, async (tx) => {
      await tx`
        UPDATE app.billing_events
        SET status = 'dlq',
            last_error = ${truncateError(reason)},
            updated_at = CURRENT_TIMESTAMP
        WHERE provider = 'stripe'
          AND provider_event_id = ${providerEventId}
          AND status IN ('pending', 'failed')
      `;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * The BullMQ `failed` listener for the billing queue.
 *
 * Keys terminality on `job.finishedOn`, not on an attempt count, for the three reasons
 * notifications/dead-letter.ts sets out at length -- `attemptsMade` means opposite things inside a
 * processor and inside this listener, a stalled job fails without the processor ever running, and
 * `finishedOn` is assigned only in the no-retry branch. `isTerminalFailure` is imported from there
 * rather than re-derived, so the two queues cannot drift on what "given up" means.
 *
 * Synchronous by signature because BullMQ does not await its listeners: an unhandled rejection here
 * would take down the worker over a failure it was only trying to record.
 *
 * Only `process-billing-event` jobs are dead-lettered this way. A failed ERPNext invoice job shares
 * the queue but not the ledger, and marking a `billing_events` row for it would be a lie.
 */
export function billingDeadLetterListener(
  databaseUrl: string,
  log: DeadLetterLogger,
): FailedHandler {
  return (job, error) => {
    if (!isTerminalFailure(job) || job.name !== JOB_NAMES.PROCESS_BILLING_EVENT) return;

    const providerEventId = (job.data as { providerEventId?: unknown } | null)?.providerEventId;
    const { errorClass, message } = describeError(error);

    // Unconditional and first: it is the only alert path that does not depend on the database being
    // reachable, which is the failure most likely to have caused this in the first place.
    log.error(
      {
        event: "billing_event_dead_lettered",
        provider_event_id: providerEventId ?? null,
        job_id: job.id ?? null,
        attempts_made: job.attemptsMade,
        err: { type: errorClass, message: error.message, stack: error.stack },
      },
      "stripe billing event exhausted its retries",
    );

    if (typeof providerEventId !== "string" || providerEventId === "") {
      log.warn(
        { event: "billing_dead_letter_unattributable", job_id: job.id ?? null },
        "dead-lettered billing job carries no provider event id; recorded in logs only",
      );
      return;
    }

    void deadLetterStripeBillingEvent(
      providerEventId,
      `Retries exhausted after ${job.attemptsMade} attempts: ${errorClass}: ${message}`,
      databaseUrl,
    ).catch((writeError: unknown) => {
      log.error(
        {
          event: "billing_dead_letter_write_failed",
          provider_event_id: providerEventId,
          err: writeError,
        },
        "could not park a dead-lettered stripe billing event",
      );
    });
  };
}
