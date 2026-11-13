/**
 * Platform system health: a read-only snapshot of the things that fail quietly, built only from what
 * is already recorded -- nothing here adds a table, a metric pipeline or a background job.
 *
 *   - Background jobs: BullMQ's own counts per queue and dead-letter queue, the latest failures, and
 *     each job scheduler with its last recorded run. Read from the workers' Redis, which in this
 *     deployment is the API's REDIS_URL too; without Redis the section says it is unavailable.
 *     Completed and failed jobs are what BullMQ retains (registry.ts keeps them 7-30 days, scheduler
 *     jobs indefinitely), so "last run" is only as far back as that history reaches.
 *   - Notification dead letters (app.notification_dead_letters, per school) from the last 7 days.
 *   - Payment webhook processing failures (app.billing_events in failed/dlq, global to
 *     studafy_admin) and rejected webhook signatures (app.security_events) from the last 7 days.
 *   - Email bounces and complaints (app.email_events) from the last 7 days.
 *   - The latest daily storage reconciliation: the per-school orphan report is that job's return
 *     value (apps/workers storage-quota-reconciliation.ts), so it is read from the job, not a table.
 *
 * Anything the platform does not record is listed in `notAvailable` rather than guessed.
 */

import { DEAD_LETTER_QUEUE_NAMES, JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import { pipelinePerSchool, withSystemTx } from "../../../db/tenant-tx";

import type { Database } from "../../../db/client";
import type { RedisClient } from "../../../redis";

const WINDOW_DAYS = 7;
const RECENT_FAILURES = 5;
/** Completed/failed jobs scanned per scheduled queue to find each scheduler's last run. */
const SCHEDULER_HISTORY_SCAN = 200;
const ERROR_PREVIEW = 300;

function preview(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  return trimmed.length > ERROR_PREVIEW ? `${trimmed.slice(0, ERROR_PREVIEW)}…` : trimmed;
}

function isoFromMillis(value: number | undefined | null): string | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : null;
}

export interface QueueHealth {
  queue: string;
  deadLetter: boolean;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  recentFailures: {
    jobName: string;
    failedAt: string | null;
    attempts: number;
    reason: string | null;
  }[];
}

export interface ScheduledJobHealth {
  queue: string;
  schedulerId: string;
  jobName: string;
  schedule: string | null;
  nextRunAt: string | null;
  lastRun: { at: string; outcome: "completed" | "failed"; error: string | null } | null;
}

export interface StorageSchoolLine {
  schoolId: string;
  schoolName: string;
  bytesUsed: number;
  orphans: number;
  orphanBytes: number;
  failed: boolean;
}

export interface SystemHealth {
  generatedAt: string;
  windowDays: number;
  jobs: { available: boolean; queues: QueueHealth[]; scheduled: ScheduledJobHealth[] };
  notificationDeadLetters: {
    total: number;
    bySchool: {
      schoolId: string;
      schoolName: string;
      count: number;
      lastFailedAt: string | null;
    }[];
  };
  webhooks: {
    failedEvents: { provider: string; count: number }[];
    recentFailures: {
      provider: string;
      eventType: string;
      status: string;
      receivedAt: string;
      attempts: number;
      error: string | null;
    }[];
    rejectedSignatures: { type: string; count: number }[];
  };
  email: { bounces: number; complaints: number; deliveries: number };
  storage: {
    available: boolean;
    lastRunAt: string | null;
    totals: { schools: number; failed: number; orphans: number; orphanBytes: number } | null;
    /** Schools with orphaned files or a failed run, most orphaned bytes first. */
    schools: StorageSchoolLine[];
  };
  notAvailable: string[];
}

/** The signature-rejection kinds recorded in app.security_events. */
const SIGNATURE_EVENT_TYPES = ["stripe_webhook_signature_invalid", "tap_webhook_signature_invalid"];

export async function getSystemHealth(
  database: Database,
  redis: RedisClient | null,
  now: Date = new Date(),
): Promise<SystemHealth> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const db = await withSystemTx(database, async (tx) => {
    const schools = await tx<{ id: string; name: string }[]>`
      SELECT id, name FROM app.schools ORDER BY name
    `;
    const deadLetters = await pipelinePerSchool(tx, schools, () => [
      tx<{ count: number; last_failed_at: Date | null }[]>`
        SELECT count(*)::int AS count, max(failed_at) AS last_failed_at
        FROM app.notification_dead_letters
        WHERE failed_at >= ${since} AND replayed_at IS NULL
      `,
    ]);
    const failedEvents = await tx<{ provider: string; count: number }[]>`
      SELECT provider, count(*)::int AS count FROM app.billing_events
      WHERE status::text IN ('failed', 'dlq') AND received_at >= ${since}
      GROUP BY provider ORDER BY provider
    `;
    const recentFailures = await tx<
      {
        provider: string;
        event_type: string;
        status: string;
        received_at: Date;
        attempt_count: number;
        last_error: string | null;
      }[]
    >`
      SELECT provider, event_type, status::text AS status, received_at, attempt_count, last_error
      FROM app.billing_events
      WHERE status::text IN ('failed', 'dlq') AND received_at >= ${since}
      ORDER BY received_at DESC
      LIMIT 10
    `;
    const signatures = await tx<{ type: string; count: number }[]>`
      SELECT event_type::text AS type, count(*)::int AS count FROM app.security_events
      WHERE created_at >= ${since} AND event_type::text = ANY(${SIGNATURE_EVENT_TYPES}::text[])
      GROUP BY event_type ORDER BY event_type
    `;
    const email = await tx<{ event_type: string; count: number }[]>`
      SELECT event_type::text AS event_type, count(*)::int AS count FROM app.email_events
      WHERE received_at >= ${since}
      GROUP BY event_type
    `;
    return { schools, deadLetters, failedEvents, recentFailures, signatures, email };
  });

  const schoolNames = new Map(db.schools.map((school) => [school.id, school.name]));
  const bySchool = db.schools
    .map((school, index) => {
      const [row] = db.deadLetters[index]![0];
      return {
        schoolId: school.id,
        schoolName: school.name,
        count: row?.count ?? 0,
        lastFailedAt: row?.last_failed_at ? row.last_failed_at.toISOString() : null,
      };
    })
    .filter((line) => line.count > 0)
    .sort((a, b) => b.count - a.count);
  const emailCount = (type: string) => db.email.find((row) => row.event_type === type)?.count ?? 0;

  const jobs = redis ? await readJobs(redis) : null;
  const storage = redis ? await readStorageReport(redis, schoolNames) : null;

  const notAvailable = [
    "google_play_webhook_failures",
    "resend_webhook_signature_failures",
    "erpnext_webhook_failures",
  ];
  if (!jobs) notAvailable.push("background_jobs");
  if (!storage) notAvailable.push("storage_report");

  return {
    generatedAt: now.toISOString(),
    windowDays: WINDOW_DAYS,
    jobs: jobs ?? { available: false, queues: [], scheduled: [] },
    notificationDeadLetters: {
      total: bySchool.reduce((total, line) => total + line.count, 0),
      bySchool,
    },
    webhooks: {
      failedEvents: db.failedEvents,
      recentFailures: db.recentFailures.map((row) => ({
        provider: row.provider,
        eventType: row.event_type,
        status: row.status,
        receivedAt: row.received_at.toISOString(),
        attempts: row.attempt_count,
        error: preview(row.last_error),
      })),
      rejectedSignatures: db.signatures,
    },
    email: {
      bounces: emailCount("bounce"),
      complaints: emailCount("complaint"),
      deliveries: emailCount("delivery"),
    },
    storage: storage ?? { available: false, lastRunAt: null, totals: null, schools: [] },
    notAvailable,
  };
}

interface JobLike {
  id?: string | null;
  name: string;
  finishedOn?: number;
  processedOn?: number;
  timestamp?: number;
  attemptsMade?: number;
  failedReason?: string;
  returnvalue?: unknown;
}

function openQueue(name: string, redis: RedisClient): Queue {
  return new Queue(name, { connection: redis as never });
}

async function readJobs(redis: RedisClient): Promise<SystemHealth["jobs"] | null> {
  const names = [
    ...Object.values(QUEUE_NAMES).map((queue) => ({ queue, deadLetter: false })),
    ...Object.values(DEAD_LETTER_QUEUE_NAMES).map((queue) => ({ queue, deadLetter: true })),
  ];
  try {
    const queues: QueueHealth[] = [];
    const scheduled: ScheduledJobHealth[] = [];
    for (const { queue: name, deadLetter } of names) {
      const queue = openQueue(name, redis);
      try {
        const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
        const failures = (await queue.getJobs(["failed"], 0, RECENT_FAILURES - 1)) as JobLike[];
        queues.push({
          queue: name,
          deadLetter,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
          recentFailures: failures.filter(Boolean).map((job) => ({
            jobName: job.name,
            failedAt: isoFromMillis(job.finishedOn ?? job.processedOn),
            attempts: job.attemptsMade ?? 0,
            reason: preview(job.failedReason),
          })),
        });

        if (deadLetter) continue;
        const schedulers = await queue.getJobSchedulers(0, -1, true);
        if (schedulers.length === 0) continue;
        const [completed, failed] = await Promise.all([
          queue.getJobs(["completed"], 0, SCHEDULER_HISTORY_SCAN - 1) as Promise<JobLike[]>,
          queue.getJobs(["failed"], 0, SCHEDULER_HISTORY_SCAN - 1) as Promise<JobLike[]>,
        ]);
        for (const scheduler of schedulers) {
          const schedulerId = scheduler.key ?? scheduler.id ?? scheduler.name;
          const prefix = `repeat:${schedulerId}:`;
          const runs = [
            ...completed.filter(Boolean).map((job) => ({ job, outcome: "completed" as const })),
            ...failed.filter(Boolean).map((job) => ({ job, outcome: "failed" as const })),
          ]
            .filter(({ job }) => typeof job.id === "string" && job.id.startsWith(prefix))
            .sort((a, b) => (b.job.finishedOn ?? 0) - (a.job.finishedOn ?? 0));
          const last = runs[0];
          scheduled.push({
            queue: name,
            schedulerId,
            jobName: scheduler.name,
            schedule: scheduler.pattern ?? (scheduler.every ? `every ${scheduler.every} ms` : null),
            nextRunAt: isoFromMillis(scheduler.next),
            lastRun: last
              ? {
                  at: isoFromMillis(last.job.finishedOn) ?? new Date(0).toISOString(),
                  outcome: last.outcome,
                  error: last.outcome === "failed" ? preview(last.job.failedReason) : null,
                }
              : null,
          });
        }
      } finally {
        await queue.close();
      }
    }
    scheduled.sort((a, b) => a.queue.localeCompare(b.queue) || a.jobName.localeCompare(b.jobName));
    return { available: true, queues, scheduled };
  } catch {
    // Redis unreachable or not the workers' instance: say so rather than fail the whole page.
    return null;
  }
}

interface ReconciliationReturn {
  schools?: number;
  failed?: number;
  orphans?: number;
  orphanBytes?: number;
  perSchool?: {
    schoolId: string;
    bytesUsed: number;
    orphans: number;
    orphanBytes: number;
    failed: boolean;
  }[];
}

async function readStorageReport(
  redis: RedisClient,
  schoolNames: ReadonlyMap<string, string>,
): Promise<SystemHealth["storage"] | null> {
  const queue = openQueue(QUEUE_NAMES.BILLING, redis);
  try {
    const completed = (await queue.getJobs(
      ["completed"],
      0,
      SCHEDULER_HISTORY_SCAN - 1,
    )) as JobLike[];
    const latest = completed
      .filter((job) => job?.name === JOB_NAMES.RUN_STORAGE_QUOTA_RECONCILIATION)
      .sort((a, b) => (b.finishedOn ?? 0) - (a.finishedOn ?? 0))[0];
    if (!latest) return { available: true, lastRunAt: null, totals: null, schools: [] };

    const value = (latest.returnvalue ?? {}) as ReconciliationReturn;
    const schools = (value.perSchool ?? [])
      .filter((line) => line.failed || line.orphans > 0)
      .map((line) => ({
        schoolId: line.schoolId,
        schoolName: schoolNames.get(line.schoolId) ?? line.schoolId,
        bytesUsed: line.bytesUsed,
        orphans: line.orphans,
        orphanBytes: line.orphanBytes,
        failed: line.failed,
      }))
      .sort((a, b) => Number(b.failed) - Number(a.failed) || b.orphanBytes - a.orphanBytes);
    return {
      available: true,
      lastRunAt: isoFromMillis(latest.finishedOn),
      totals: {
        schools: value.schools ?? 0,
        failed: value.failed ?? 0,
        orphans: value.orphans ?? 0,
        orphanBytes: value.orphanBytes ?? 0,
      },
      schools,
    };
  } catch {
    return null;
  } finally {
    await queue.close();
  }
}
