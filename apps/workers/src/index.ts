import { startMetricsServer, startQueueGauges, startTracing } from "@studafy/observability";
import postgres from "postgres";

import { createRedisConnection } from "./connection";
import { databaseUrlFrom, loadEnv } from "./env";
import { workerLogger } from "./log";
import { startBillingPipelineGauges } from "./metrics/billing-pipeline";
import { scheduleAnnouncementPublishJob } from "./queues/announcements";
import {
  scheduleDunningJob,
  scheduleSeatReconciliationJob,
  scheduleStorageQuotaReconciliationJob,
} from "./queues/billing";
import { startEntitlementInvalidator } from "./queues/entitlements";
import { scheduleAbandonedImportSweepJob } from "./queues/imports";
import { scheduleClosureSweepJob } from "./queues/maintenance";
import {
  createSesSender,
  scheduleDigestJob,
  scheduleNotificationDigestJob,
  startEmailDispatcher,
  TokenBucket,
} from "./queues/notifications/email";
import { startRelay } from "./queues/outbox-relay";
import { scheduleReportExpiryJob } from "./queues/reports";
import { QUEUE_REGISTRY } from "./registry";
import { shutdownWorkers, startWorkers } from "./worker";

import type { RelayHandle } from "./queues/outbox-relay/relay";

// Fail fast: an invalid environment throws EnvValidationError here, before any Redis connection opens.
const env = loadEnv();

// Prometheus-format metrics (ST-259), on its own port — must run before startWorkers()/worker.ts's
// createBullmqWorker records anything, since an OTel instrument stays bound to whichever meter
// created it and this call is what registers the real global MeterProvider (see
// packages/observability/src/redMetrics.ts).
const metricsServer = startMetricsServer({ serviceName: env.SERVICE_NAME, port: env.METRICS_PORT });

// Distributed tracing (ST-260), same ordering requirement — before startWorkers()/worker.ts's
// createBullmqWorker calls trace.getTracer(). Null when OTEL_EXPORTER_OTLP_ENDPOINT is unset.
const tracing = startTracing({
  serviceName: env.SERVICE_NAME,
  // See apps/api/src/index.ts's own comment on this same `|| undefined`.
  otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
});

const connection = createRedisConnection(env);
const workers = startWorkers(QUEUE_REGISTRY, connection);
// Queue depth (ST-259) and backlog age (ST-262), observed lazily on every scrape from one shared
// set of read-only Queue handles. A dedicated Redis connection: BullMQ's own connection option for
// a Queue handle must not be the same object a Worker mutates the mode of (see
// createRedisConnection's own callers elsewhere in this file for the same "one connection per
// BullMQ client" convention).
const queueMetricsConnection = createRedisConnection(env);
const queueGauges = startQueueGauges(
  QUEUE_REGISTRY.map((definition) => definition.name),
  queueMetricsConnection as never,
);

// Payment pipeline liveness (ST-262): `app.billing_events`' unresolved tail, read on every scrape.
// Its own small pool, like every other polling loop in this file — the scrape path must never wait
// behind a job processor for a connection, and vice versa. `max: 1` because there is exactly one
// in-flight query at a time (one scrape, one callback) and a second connection would only sit idle.
const billingPipelineDb = postgres(databaseUrlFrom(env), {
  max: 1,
  idle_timeout: 20,
  prepare: false,
});
const billingPipelineGauges = startBillingPipelineGauges({
  db: billingPipelineDb,
  logger: workerLogger,
});

// Outbox relay: separate polling loop alongside BullMQ workers. Uses its own postgres and Redis
// connections because the BullMQ connection is tied to the queue DB and the relay needs pub/sub.
// SCHOOL_IDS is an override, not a requirement. It was previously the only source, which meant the
// relay did not start at all unless it was set — and it is absent from the ECS task definition, so
// the relay has never run in production and every pub/sub consumer downstream of it has been inert.
// Falling back to app.schools (a global, RLS-free table) makes the relay self-configuring, and
// re-reading it each cycle means a newly registered school no longer waits for a worker restart.
const configuredSchoolIds = env.SCHOOL_IDS.split(",").filter(Boolean);
const relayDb = postgres(databaseUrlFrom(env), { max: 2, idle_timeout: 20, prepare: false });
const relayRedis = createRedisConnection(env);

let relayHandle: RelayHandle | null = null;

void relayRedis.connect().then(() => {
  relayHandle = startRelay({
    db: relayDb,
    redis: relayRedis,
    config: {
      batchSize: 100,
      // 500ms rather than 1s: this is the fast path for ST-133's <5s propagation SLA.
      pollIntervalMs: 500,
      schoolIds: configuredSchoolIds.length > 0 ? configuredSchoolIds : null,
    },
    logger: workerLogger,
  });
});

// Entitlement invalidation (ST-133): the durable consumer the propagation SLA rests on. Started
// unconditionally, like the email dispatcher and unlike the relay above, because losing an
// invalidation means serving a canceled school until the cache TTL expires.
const entitlementDb = postgres(databaseUrlFrom(env), { max: 2, idle_timeout: 20, prepare: false });
const entitlementRedis = createRedisConnection(env);
const entitlementInvalidator = startEntitlementInvalidator({
  db: entitlementDb,
  redis: entitlementRedis,
  config: {
    batchSize: env.ENTITLEMENT_BATCH_SIZE,
    pollIntervalMs: env.ENTITLEMENT_POLL_INTERVAL_MS,
    concurrency: 16,
  },
  logger: workerLogger,
});

// Email channel: a second polling loop that consumes email-relevant outbox events directly, on its
// own postgres pool, pacing sends through an in-process token bucket. databaseUrlFrom() — not the
// raw DATABASE_URL default — so a deployed worker honours the discrete production DB settings.
const emailDb = postgres(databaseUrlFrom(env), { max: 4, idle_timeout: 20, prepare: false });
const emailLogger = {
  info: (fields: Record<string, unknown>, msg: string) =>
    console.log(JSON.stringify({ ...fields, msg })),
  warn: (fields: Record<string, unknown>, msg: string) =>
    console.warn(JSON.stringify({ ...fields, msg })),
  error: (fields: Record<string, unknown>, msg: string) =>
    console.error(JSON.stringify({ ...fields, msg })),
};
const emailDispatcher = startEmailDispatcher({
  db: emailDb,
  sender: createSesSender(env, emailLogger),
  limiter: new TokenBucket(env.EMAIL_MAX_RATE_PER_SECOND),
  config: {
    batchSize: env.EMAIL_BATCH_SIZE,
    pollIntervalMs: env.EMAIL_POLL_INTERVAL_MS,
    ratePerSecond: env.EMAIL_MAX_RATE_PER_SECOND,
    frontendUrl: env.FRONTEND_URL,
  },
  logger: emailLogger,
});

// Digest scheduler: idempotently register the daily 06:00 parent-digest on the notifications
// queue. Its own Redis connection so the upsert never contends with worker polling.
const digestRedis = createRedisConnection(env);
void scheduleDigestJob(digestRedis).then(() => digestRedis.disconnect());

// Notification digest scheduler: idempotently register the daily 06:30 per-recipient digest
// (ST-143's preferences.digest flag) on the notifications queue, its own hour after the parent
// digest above so the two never contend for the same outbox-insert window.
const notificationDigestRedis = createRedisConnection(env);
void scheduleNotificationDigestJob(notificationDigestRedis).then(() =>
  notificationDigestRedis.disconnect(),
);

// Dunning scheduler: idempotently register the daily 04:00 grace-period sweep on the billing queue.
const dunningRedis = createRedisConnection(env);
void scheduleDunningJob(dunningRedis).then(() => dunningRedis.disconnect());

// Seat-reconciliation scheduler (ST-136): idempotently register the daily 05:00 seat sweep on the
// billing queue, an hour after the dunning sweep so a school suspended overnight is no longer
// `active` and is skipped.
const seatReconciliationRedis = createRedisConnection(env);
void scheduleSeatReconciliationJob(seatReconciliationRedis).then(() =>
  seatReconciliationRedis.disconnect(),
);

// Storage-quota reconciliation scheduler (ST-16x): idempotently register the daily 06:00 storage
// sweep on the billing queue, after the dunning and seat sweeps so it sees the post-suspension
// bucket state.
const storageQuotaReconciliationRedis = createRedisConnection(env);
void scheduleStorageQuotaReconciliationJob(storageQuotaReconciliationRedis).then(() =>
  storageQuotaReconciliationRedis.disconnect(),
);

// Report-expiry scheduler (ST-175): idempotently register the daily 07:00 purge of expired report
// artifacts on the reports queue. Attendance objects are already covered by the `reports/` bucket
// lifecycle rule; this closes the gap for the legacy `tenant-<schoolId>/reports/` finance keys.
const reportExpiryRedis = createRedisConnection(env);
void scheduleReportExpiryJob(reportExpiryRedis).then(() => reportExpiryRedis.disconnect());

// Abandoned-import sweep scheduler (ST-190 follow-up): idempotently register the daily 08:00 purge
// of student-CSV imports that were uploaded but never confirmed, on the imports queue.
const abandonedImportSweepRedis = createRedisConnection(env);
void scheduleAbandonedImportSweepJob(abandonedImportSweepRedis).then(() =>
  abandonedImportSweepRedis.disconnect(),
);

// Announcement publish-sweep scheduler (ST-194): idempotently register the every-5-minutes claim of
// due `scheduled` announcements on the notifications queue, so a scheduled announcement publishes
// close to its chosen instant without a school having to depend on someone opening the admin UI.
const announcementPublishRedis = createRedisConnection(env);
void scheduleAnnouncementPublishJob(announcementPublishRedis).then(() =>
  announcementPublishRedis.disconnect(),
);

// Tenant-closure sweep scheduler (ST-268): idempotently register the daily 08:30 sweep on the
// maintenance queue, after dunning and seat reconciliation so a school suspended overnight is
// already `closed` before this sweep looks for it.
const closureSweepRedis = createRedisConnection(env);
void scheduleClosureSweepJob(closureSweepRedis).then(() => closureSweepRedis.disconnect());

console.log(
  `Workers started for queues: ${QUEUE_REGISTRY.map((definition) => definition.name).join(", ")} (${env.NODE_ENV})`,
);

let shuttingDown = false;

const shutdown = (signal: string) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`Received ${signal}, waiting for active jobs to finish…`);

  relayHandle?.stop();
  emailDispatcher.stop();
  entitlementInvalidator.stop();

  void shutdownWorkers(workers, env.SHUTDOWN_TIMEOUT_MS).then(async () => {
    connection.disconnect();
    relayRedis.disconnect();
    entitlementRedis.disconnect();
    await relayDb.end({ timeout: 5 });
    await emailDb.end({ timeout: 5 });
    await entitlementDb.end({ timeout: 5 });
    // startQueueGauges() was given queueMetricsConnection as a live IORedis instance rather
    // than plain connection options, so BullMQ treats it as externally owned and never closes it
    // itself — queue.close() only stops the per-queue Queue wrapper. Closing it here is what
    // actually releases the socket.
    await queueGauges.close();
    queueMetricsConnection.disconnect();
    billingPipelineGauges.close();
    await billingPipelineDb.end({ timeout: 5 });
    await metricsServer.shutdown();
    await tracing?.shutdown();
    console.log("Shutdown complete.");
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
