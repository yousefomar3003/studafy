/**
 * Job dispatch for the `maintenance` queue (ST-268): the scheduled tenant-closure sweep and every
 * data subject request (export or erasure) it and the DSR API file. Mirrors the reports queue's
 * report-registry.ts dispatch shape -- one function the queue's Worker hands every job to.
 */

import { JOB_NAMES } from "@studafy/constants";
import postgres from "postgres";

import { workerLogger } from "../../log";

import { CLOSURE_ERASURE_RETENTION_HOLD_DAYS, runTenantClosureSweep } from "./closure-sweep";
import { processDsrJob } from "./dsr-processor";

import type { EnqueueDsrJob } from "./closure-sweep";
import type { MaintenanceRunnerConfig } from "./dsr-processor";
import type { Job } from "bullmq";

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
    await runClosureSweep(config, enqueue);
    return { processed: true };
  }

  if (
    job.name === JOB_NAMES.RUN_DATA_SUBJECT_EXPORT ||
    job.name === JOB_NAMES.RUN_DATA_SUBJECT_ERASURE
  ) {
    return processDsrJob(job, config);
  }

  return { processed: false, reason: "unknown maintenance job" };
}

async function runClosureSweep(
  config: MaintenanceRunnerConfig,
  enqueue: EnqueueDsrJob,
): Promise<void> {
  const sql = postgres(config.primaryDatabaseUrl, {
    max: 2,
    idle_timeout: 20,
    prepare: false,
    ...(config.databaseCaCert
      ? { ssl: { ca: config.databaseCaCert, rejectUnauthorized: true } }
      : {}),
  });
  try {
    await runTenantClosureSweep(sql, new Date(), enqueue, workerLogger);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
