/**
 * Dead-lettering and failure alerting for the notification dispatcher (ST-139).
 *
 * ## Why a `failed` listener, and why it keys on `finishedOn`
 *
 * BullMQ emits `failed` on *every* attempt, so something has to decide which one is terminal. Three
 * things make `job.finishedOn` the right predicate and an attempt count the wrong one:
 *
 *   1. `attemptsMade` means opposite things in the two places it is read. Inside a processor it is
 *      the count of *prior* attempts — which is why `isFinalExportAttempt` in
 *      reports/attendance-export.worker.ts is written `attemptsMade + 1 >= attempts`. BullMQ
 *      increments it at the end of `moveToFailed`, *before* emitting `failed`, so in this listener
 *      the same-looking field is already incremented. Two opposite off-by-ones for one field name.
 *   2. A job whose worker was killed mid-dispatch stalls. Once it exceeds `maxStalledCount` BullMQ
 *      does not fail it inline; it marks a deferred failure and returns the job to `wait`, and the
 *      next worker fails it as an `UnrecoverableError` **without ever calling the processor**. An
 *      in-processor check cannot see that path at all, and `attemptsMade` there is well under the
 *      limit.
 *   3. `finishedOn` is assigned only in `moveToFailed`'s no-retry branch. It is exactly the question
 *      being asked, with no arithmetic and no coupling to `opts.attempts` — which the *producer*
 *      owns, not the worker.
 *
 * The cost is that BullMQ does not await listeners, so this write is at-most-once and outside any
 * transaction the job had. Three things make that acceptable: the row is uniquely keyed on
 * `(school_id, queue_name, job_id)` so a replay cannot double-count, BullMQ's own failed set is
 * retained for 30 days as the backstop of record, and the structured log line below is emitted
 * whether or not the database write succeeds.
 *
 * ## Why the outbox payload carries no stack trace
 *
 * outbox-relay/relay.ts publishes payloads verbatim to the Redis pub/sub channel
 * `events:{school_id}:{event_name}` with no redaction, and outbox rows are never reaped — they get
 * `relayed_at` stamped and stay. A dispatch stack routinely carries recipient addresses and
 * provider request ids. So the event carries correlation handles only, and the detail lives in
 * app.notification_dead_letters, which is tenant-isolated. A consumer that needs more follows
 * `deadLetterId`.
 */

import { DOMAIN_EVENTS, QUEUE_NAMES } from "@studafy/constants";
import postgres from "postgres";

import { withSystemTenantTx } from "../../db/tenant-tx";

import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The subset of a BullMQ `Job` this module reads. Structural, so tests need no BullMQ at all. */
export interface FailedJobLike {
  id?: string | null;
  name: string;
  data: unknown;
  attemptsMade: number;
  /** Assigned by BullMQ only when the job will not be retried again. */
  finishedOn?: number;
  /** `string[] | null` in BullMQ — one entry per attempt. Nullable, not merely optional. */
  stacktrace?: string[] | null;
}

export interface DeadLetterLogger {
  warn: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
}

export type FailedHandler = (job: FailedJobLike | undefined, error: Error) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Mirrors ck_notification_dead_letters_error_message in 000074. */
export const MAX_ERROR_MESSAGE_LENGTH = 1000;
/** Mirrors ck_notification_dead_letters_error_stack in 000074. */
export const MAX_ERROR_STACK_LENGTH = 8000;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Whether BullMQ has finished with this job for good.
 *
 * See the header for why this is not an `attemptsMade` comparison.
 */
export function isTerminalFailure(job: FailedJobLike | undefined): job is FailedJobLike {
  return job !== undefined && typeof job.finishedOn === "number";
}

/**
 * Truncate to the column's limit, in TypeScript rather than by letting the CHECK reject.
 *
 * A constraint violation here would abort the transaction that is recording the failure, losing the
 * alert entirely in order to enforce a length limit — trading the whole signal for the tail of a
 * stack trace.
 */
export function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** `error_message` is NOT NULL and must be non-blank, so an error with no message still needs one. */
export function describeError(error: Error): { errorClass: string; message: string } {
  const message = error.message.trim();
  return {
    errorClass: truncate(error.constructor.name || "Error", 200),
    message: truncate(message === "" ? "(no message)" : message, MAX_ERROR_MESSAGE_LENGTH),
  };
}

/**
 * The school this job belonged to, or `null` if it cannot be established.
 *
 * `null` is not recoverable: app.notification_dead_letters.school_id is NOT NULL with a foreign key,
 * so there is no tenant transaction to open and no row to write. The caller logs and returns.
 */
export function schoolIdFromJobData(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const schoolId = (data as { schoolId?: unknown }).schoolId;
  return typeof schoolId === "string" && schoolId !== "" ? schoolId : null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Record the failure and raise the alert, in one transaction.
 *
 * Returns the dead-letter row id, or `null` when this failure was already recorded — the unique
 * index on `(school_id, queue_name, job_id)` makes a re-run of this handler a no-op rather than a
 * second alert.
 */
async function recordDeadLetter(
  tx: TransactionSql,
  params: {
    schoolId: string;
    queueName: string;
    jobId: string;
    jobName: string;
    attemptsMade: number;
    errorClass: string;
    errorMessage: string;
    errorStack: string | null;
  },
): Promise<string | null> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.notification_dead_letters (
      school_id, queue_name, job_id, job_name, attempts_made,
      error_class, error_message, error_stack
    ) VALUES (
      ${params.schoolId}::uuid,
      ${params.queueName},
      ${params.jobId},
      ${params.jobName},
      ${params.attemptsMade}::smallint,
      ${params.errorClass},
      ${params.errorMessage},
      ${params.errorStack}
    )
    ON CONFLICT (school_id, queue_name, job_id) DO NOTHING
    RETURNING id
  `;
  return row?.id ?? null;
}

/**
 * Emit `notification.dispatchFailed` into the outbox.
 *
 * Constructed by hand rather than through apps/api's `emit()` — apps/workers has no dependency edge
 * to apps/api. The shape must match `eventPayloadSchemas[NOTIFICATION_DISPATCH_FAILED]` in
 * apps/api/src/lib/events/schemas.ts, which is the contract of record and is exhaustive over
 * DOMAIN_EVENTS, so the event cannot exist without a schema there.
 */
async function emitDispatchFailed(
  tx: TransactionSql,
  schoolId: string,
  payload: {
    deadLetterId: string;
    jobId: string;
    jobName: string;
    queueName: string;
    attemptsMade: number;
    errorClass: string;
    failedAt: string;
  },
): Promise<void> {
  // tx.json(), not JSON.stringify() + ::jsonb — app.outbox_events has no CHECK to catch that
  // mistake, so it would store a jsonb *string* silently and corrupt every consumer downstream.
  const body = tx.json(payload);

  await tx`
    INSERT INTO app.outbox_events (school_id, event_name, payload)
    VALUES (${schoolId}::uuid, ${DOMAIN_EVENTS.NOTIFICATION_DISPATCH_FAILED}, ${body})
  `;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Write the dead-letter row and its alert event for one terminally failed job.
 *
 * Exported so tests drive it directly with a hand-built job — the BullMQ wiring in
 * `deadLetterListener` is a two-line adapter that needs a real Redis and is therefore not the part
 * worth testing.
 */
export async function handleDeadLetter(params: {
  job: FailedJobLike;
  error: Error;
  databaseUrl: string;
  queueName: string;
  log: DeadLetterLogger;
}): Promise<string | null> {
  const { job, error, queueName, log } = params;
  const jobId = job.id ?? null;
  const schoolId = schoolIdFromJobData(job.data);
  const { errorClass, message } = describeError(error);

  // The log line comes first and unconditionally. It is the only alert path that does not depend on
  // the database being reachable — and, given that the outbox relay only polls schools listed in
  // SCHOOL_IDS and that variable is absent from the ECS task definition, it is currently the only
  // one that reaches an operator at all. See docs/architecture/SAD_21_notification_dispatch_flow.md.
  log.error(
    {
      event: "notification_dispatch_dead_lettered",
      school_id: schoolId,
      job_id: jobId,
      job_name: job.name,
      queue: queueName,
      attempts_made: job.attemptsMade,
      err: { type: errorClass, message: error.message, stack: error.stack },
    },
    "notification dispatch job exhausted its retries",
  );

  if (schoolId === null || jobId === null) {
    log.warn(
      {
        event: "notification_dead_letter_unattributable",
        job_id: jobId,
        job_name: job.name,
        queue: queueName,
      },
      "dead-lettered job has no school_id or job id; recorded in logs only",
    );
    return null;
  }

  const stack = job.stacktrace?.at(-1) ?? error.stack ?? null;

  const sql = postgres(params.databaseUrl, { max: 1, idle_timeout: 20, prepare: false });
  try {
    return await withSystemTenantTx(sql, { schoolId }, async (tx) => {
      const deadLetterId = await recordDeadLetter(tx, {
        schoolId,
        queueName,
        jobId,
        jobName: job.name,
        attemptsMade: Math.max(job.attemptsMade, 1),
        errorClass,
        errorMessage: message,
        errorStack: stack === null ? null : truncate(stack, MAX_ERROR_STACK_LENGTH),
      });

      // Already recorded by an earlier run of this handler. Re-alerting would page someone twice
      // for one failure.
      if (deadLetterId === null) return null;

      await emitDispatchFailed(tx, schoolId, {
        deadLetterId,
        jobId,
        jobName: job.name,
        queueName,
        attemptsMade: Math.max(job.attemptsMade, 1),
        errorClass,
        failedAt: new Date().toISOString(),
      });

      return deadLetterId;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * The BullMQ `failed` listener.
 *
 * Synchronous by signature because BullMQ does not await listeners: it must own its error handling
 * rather than returning a promise nobody holds. An unhandled rejection here would take down the
 * worker process over a failure it was only trying to record.
 */
export function deadLetterListener(
  databaseUrl: string,
  log: DeadLetterLogger,
  // The queue the job *failed on*, not the parking lot it is replayable through. A replay has to
  // re-enqueue onto the origin queue, so that is the name worth recording;
  // DEAD_LETTER_QUEUE_NAMES.NOTIFICATIONS is a handle for the tool that does it.
  queueName: string = QUEUE_NAMES.NOTIFICATIONS,
): FailedHandler {
  return (job, error) => {
    if (!isTerminalFailure(job)) return;

    void handleDeadLetter({ job, error, databaseUrl, queueName, log }).catch(
      (writeError: unknown) => {
        log.error(
          {
            event: "notification_dead_letter_write_failed",
            job_id: job.id ?? null,
            err: writeError,
          },
          "could not record a dead-lettered notification dispatch",
        );
      },
    );
  };
}
