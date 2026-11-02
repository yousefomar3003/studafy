/**
 * Job dispatch for the `maintenance` queue (ST-268): the scheduled tenant-closure sweep, every data
 * subject request (export or erasure) it and the DSR API file, the scheduled Ask AI message
 * retention purge (ST-309) and the scheduled account-deletion sweep (000143). Mirrors the reports queue's report-registry.ts dispatch shape -- one
 * function the queue's Worker hands every job to.
 */

import { JOB_NAMES } from "@studafy/constants";
import postgres from "postgres";

import { workerLogger } from "../../log";
import { createReportS3 } from "../reports/report-s3";

import { runAccountDeletionSweep } from "./account-deletion-sweep";
import { purgeExpiredAiMessages } from "./ai-message-retention-sweep";
import { CLOSURE_ERASURE_RETENTION_HOLD_DAYS, runTenantClosureSweep } from "./closure-sweep";
import { processDsrJob } from "./dsr-processor";
import { resealRecordValues } from "./record-key-rotation";
import { purgeExpiredSensitiveRecords } from "./record-retention-sweep";
import { StripeAiBillingCanceller } from "./stripe-ai-billing-canceller";

import type { EnqueueDsrJob } from "./closure-sweep";
import type { MaintenanceRunnerConfig } from "./dsr-processor";
import type { Job } from "bullmq";
import type { Sql } from "postgres";

export { CLOSURE_ERASURE_RETENTION_HOLD_DAYS };

export interface MaintenanceJobResult {
  processed: boolean;
  reason?: string;
}

export async function processMaintenanceJob(
  job: Job,
  config: MaintenanceRunnerConfig,
  enqueue: EnqueueDsrJob,
): Promise<MaintenanceJobResult> {
  if (job.name === JOB_NAMES.RUN_TENANT_CLOSURE_SWEEP) {
    await withPrimarySql(config, (sql) =>
      runTenantClosureSweep(sql, new Date(), enqueue, workerLogger),
    );
    return { processed: true };
  }

  if (job.name === JOB_NAMES.RUN_ACCOUNT_DELETION_SWEEP) {
    const billing = config.stripeSecretKey
      ? new StripeAiBillingCanceller(config.stripeSecretKey)
      : null;
    const result = await withPrimarySql(config, (sql) =>
      runAccountDeletionSweep(sql, new Date(), billing, enqueue, workerLogger),
    );
    return { processed: true, ...result };
  }

  if (job.name === JOB_NAMES.PURGE_EXPIRED_AI_MESSAGES) {
    const result = await withPrimarySql(config, (sql) => purgeExpiredAiMessages(sql, workerLogger));
    return { processed: true, ...result };
  }

  if (job.name === JOB_NAMES.PURGE_EXPIRED_SENSITIVE_RECORDS) {
    const storage =
      config.s3Region && config.bucket
        ? createReportS3({
            region: config.s3Region,
            endpoint: config.s3Endpoint,
            bucket: config.bucket,
          })
        : null;
    // Purge first, so nothing about to be deleted is re-sealed; then move every remaining sealed
    // value onto the current key (ADR-019's rotation).
    const result = await withPrimarySql(config, async (sql) => ({
      ...(await purgeExpiredSensitiveRecords(sql, storage, new Date(), workerLogger)),
      ...(await resealRecordValues(sql, config.recordKeyring, workerLogger).then((reseal) => ({
        resealed: reseal.resealed,
        resealFailed: reseal.failed,
      }))),
    }));
    return { processed: true, ...result };
  }
  if (
    job.name === JOB_NAMES.RUN_DATA_SUBJECT_EXPORT ||
    job.name === JOB_NAMES.RUN_DATA_SUBJECT_ERASURE
  ) {
    return processDsrJob(job, config);
  }

  return { processed: false, reason: "unknown maintenance job" };
}

async function withPrimarySql<T>(
  config: MaintenanceRunnerConfig,
  fn: (sql: Sql) => Promise<T>,
): Promise<T> {
  const sql = postgres(config.primaryDatabaseUrl, {
    max: 2,
    idle_timeout: 20,
    prepare: false,
    ...(config.databaseCaCert
      ? { ssl: { ca: config.databaseCaCert, rejectUnauthorized: true } }
      : {}),
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
