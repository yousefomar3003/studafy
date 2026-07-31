/**
 * Enqueueing notification dispatch for a published grade (ST-139).
 *
 * ## Why the API enqueues this rather than a worker consuming the event
 *
 * `grades.published` already exists and is already emitted, into `app.outbox_events`. The natural
 * design would be for the dispatcher to consume it. It cannot, today, for two independent reasons:
 *
 *   1. There is no outbox-to-BullMQ bridge. The relay publishes to the Redis pub/sub channel
 *      `events:{school_id}:{event_name}`, and the one subscriber that exists lives in apps/api.
 *      `QUEUE_NAMES.OUTBOX_RELAY` has a placeholder processor.
 *   2. The relay does not run in production. `apps/workers/src/index.ts` starts it only when
 *      `env.SCHOOL_IDS` is non-empty, and that variable is absent from the ECS task definition —
 *      documented at docs/architecture/alert-rules-engine.md.
 *
 * So a dispatcher built on the event would be correct and inert. Enqueueing directly is the pattern
 * that demonstrably works in this codebase today (see ../attendance/enqueue-alerts.ts), and the
 * outbox row is still written, so the event-driven path remains available to whoever fixes the
 * relay — at which point this producer becomes redundant rather than wrong.
 *
 * ## Why this never throws
 *
 * Notification is downstream of grading, not part of it. A teacher who has just published a grade
 * must not receive a 500 because Redis is unreachable — the grade committed, and failing the
 * response would invite them to publish again. A failed enqueue is logged at `warn` and swallowed.
 *
 * That is a real gap, not an oversight: those recipients will not be notified until someone
 * replays the job. The same trade ../attendance/enqueue-alerts.ts documents, for the same reason.
 */

import { DOMAIN_EVENTS, JOB_NAMES } from "@studafy/constants";

import type { AppEnv } from "../../middleware/requestId";
import type { Queue } from "bullmq";
import type { Context } from "hono";

export interface NotificationDispatchJobPayload {
  schoolId: string;
  submissionId: string;
}

/**
 * Five attempts with exponential backoff, per ST-139 — one more than the repo's usual three,
 * because this job's failure is visible to a parent rather than to an operator.
 *
 * Retries are safe by construction: the worker reserves a per-recipient idempotency key before each
 * delivery and confirms it after, so a replayed job re-resolves the same recipients and sends
 * nothing to anyone already confirmed.
 */
const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 60 * 60 },
  removeOnFail: { age: 30 * 24 * 60 * 60 },
} as const;

export async function enqueueNotificationDispatch(
  queue: Queue | null,
  c: Context<AppEnv>,
  payload: NotificationDispatchJobPayload,
): Promise<void> {
  // No Redis — dev, test and the OpenAPI generator all run without it. Same nullable producer
  // shape every other enqueue in this app uses.
  if (!queue) return;

  try {
    await queue.add(
      JOB_NAMES.DISPATCH_NOTIFICATION,
      {
        schoolId: payload.schoolId,
        // The submission id doubles as the event id. Publication is a one-shot
        // `approved -> published` transition, so it is stable across a duplicate enqueue and a job
        // replay — which is exactly what a per-recipient idempotency key needs. A generated uuid
        // would make every replay look like a brand new event and notify everyone twice.
        eventId: payload.submissionId,
        eventType: DOMAIN_EVENTS.GRADES_PUBLISHED,
        submissionId: payload.submissionId,
      },
      JOB_OPTIONS,
    );
  } catch (error) {
    c.get("log").warn(
      {
        event: "notification_dispatch_enqueue_failed",
        school_id: payload.schoolId,
        submission_id: payload.submissionId,
        error: error instanceof Error ? error.message : String(error),
      },
      "failed to enqueue notification dispatch; recipients will not be notified for this publication",
    );
  }
}
