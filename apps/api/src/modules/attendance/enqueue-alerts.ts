/**
 * Enqueueing attendance alert evaluation (ST-110).
 *
 * Shared by the two paths that can create an absence: recording a roster, and correcting a record
 * into `absent` after the fact. Both hand the alert engine the same payload, so both live here
 * rather than being written twice with subtly different job shapes.
 *
 * ## Why this never throws
 *
 * Alerting is downstream of attendance, not part of it. A teacher who has just submitted a register
 * must not receive a 500 because Redis is unreachable — the attendance itself committed, and
 * failing the response would invite them to submit again. So a failed enqueue is logged at `warn`
 * and swallowed.
 *
 * That is a real, deliberate gap rather than an oversight: those absences will not be evaluated
 * until the student's next one triggers a fresh job. See docs/architecture/alert-rules-engine.md
 * for why the transactional alternative (the outbox) was not used.
 */

import { JOB_NAMES } from "@studafy/constants";

import type { AppEnv } from "../../middleware/requestId";
import type { Queue } from "bullmq";
import type { Context } from "hono";

export interface AttendanceAlertJobPayload {
  schoolId: string;
  attendanceSessionId: string;
  /** The session's business date, YYYY-MM-DD. */
  sessionDate: string;
  /** Students whose current status is `absent`. Empty means there is nothing to evaluate. */
  studentIds: string[];
}

/**
 * Job options copied deliberately from the bulk-invite producer, which is the repo's reference
 * enqueue. Three attempts with exponential backoff covers a Redis blip or a database failover;
 * the retention windows keep completed jobs long enough to investigate a missing alert and failed
 * ones long enough to notice a pattern.
 *
 * Retries are safe to the point of being uninteresting here: the worker claims each alert through
 * a unique index, so a replayed job re-evaluates and writes nothing.
 */
const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 60 * 60 },
  removeOnFail: { age: 30 * 24 * 60 * 60 },
} as const;

export async function enqueueAttendanceAlerts(
  queue: Queue | null,
  c: Context<AppEnv>,
  payload: AttendanceAlertJobPayload,
): Promise<void> {
  // No Redis, or nobody absent — either way there is nothing to evaluate.
  if (!queue || payload.studentIds.length === 0) return;

  try {
    await queue.add(JOB_NAMES.EVALUATE_ATTENDANCE_ALERTS, payload, JOB_OPTIONS);
  } catch (error) {
    c.get("log").warn(
      {
        event: "attendance_alert_enqueue_failed",
        school_id: payload.schoolId,
        attendance_session_id: payload.attendanceSessionId,
        student_count: payload.studentIds.length,
        error: error instanceof Error ? error.message : String(error),
      },
      "failed to enqueue attendance alert evaluation; absences will not be evaluated for this submission",
    );
  }
}
