/**
 * BullMQ dispatch for one data subject request (ST-268): claim the row, run the export or erasure
 * it names, record the outcome. Mirrors the report framework's runReport (report-runner.ts) in
 * shape -- claim, do the work, complete, or fail on the final attempt -- but is its own function
 * because the two halves produce genuinely different completions (one storage key vs. two
 * structured lists), which report-runner.ts's single `storageKey`-shaped result cannot express
 * without new plumbing that would exist for this one caller.
 */

import { JOB_NAMES } from "@studafy/constants";
import postgres from "postgres";

import { withSystemTenantTx } from "../../db/tenant-tx";
import { isFinalAttempt } from "../reports/report-runner";
import { createReportS3 } from "../reports/report-s3";

import {
  claimDsrRequest,
  completeDsrErasure,
  completeDsrExport,
  failDsrRequest,
} from "./dsr-store";
import { resolveSubjectIdentifiers } from "./subject-resolver";
import { runTenantErasure } from "./tenant-erasure.worker";
import { runTenantExport } from "./tenant-export.worker";

import type { MaintenanceS3Client } from "./tenant-export.worker";
import type { Job } from "bullmq";
import type { Sql } from "postgres";

export interface MaintenanceRunnerConfig {
  primaryDatabaseUrl: string;
  databaseCaCert?: string;
  s3Region?: string;
  s3Endpoint?: string;
  bucket?: string;
}

export interface DsrJobResult {
  processed: boolean;
  reason?: string;
}

export function createMaintenancePool(config: MaintenanceRunnerConfig): Sql {
  return postgres(config.primaryDatabaseUrl, {
    max: 2,
    idle_timeout: 20,
    prepare: false,
    ...(config.databaseCaCert
      ? { ssl: { ca: config.databaseCaCert, rejectUnauthorized: true } }
      : {}),
  });
}

/** Reuses the reports queue's S3 adapter -- the interface it satisfies (put/remove/presignGet) is a
 * strict superset of MaintenanceS3Client, so no maintenance-specific client is needed. */
function createMaintenanceStorage(config: MaintenanceRunnerConfig): MaintenanceS3Client {
  const region = config.s3Region;
  const bucket = config.bucket;
  if (!region || !bucket) throw new Error("DSR export storage is not configured");
  return createReportS3({ region, endpoint: config.s3Endpoint, bucket });
}

export async function processDsrJob(
  job: Job,
  config: MaintenanceRunnerConfig,
): Promise<DsrJobResult> {
  const data = job.data as { requestId?: string; schoolId?: string };
  if (!data.requestId || !data.schoolId) return { processed: false, reason: "missing job data" };

  const sql = createMaintenancePool(config);
  try {
    return await runDsrJob(sql, config, job, data.requestId, data.schoolId);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function runDsrJob(
  sql: Sql,
  config: MaintenanceRunnerConfig,
  job: Job,
  requestId: string,
  schoolId: string,
): Promise<DsrJobResult> {
  try {
    return await withSystemTenantTx(sql, { schoolId }, async (tx) => {
      const claim = await claimDsrRequest(tx, schoolId, requestId);
      if (claim.state === "terminal") return { processed: true };
      const record = claim.record;

      if (job.name === JOB_NAMES.RUN_DATA_SUBJECT_EXPORT) {
        const { manifestKey } = await runTenantExport(tx, {
          s3: createMaintenanceStorage(config),
          requestId,
          schoolId,
          subjectScope: record.subjectScope,
          subjectUserId: record.subjectUserId,
          now: new Date(),
        });
        await completeDsrExport(tx, schoolId, requestId, manifestKey);
        return { processed: true };
      }

      const subject =
        record.subjectScope === "user" && record.subjectUserId
          ? await resolveSubjectIdentifiers(tx, schoolId, record.subjectUserId)
          : undefined;
      const { redactedTables, retainedTables } = await runTenantErasure(tx, schoolId, subject);
      await completeDsrErasure(tx, schoolId, requestId, redactedTables, retainedTables);
      return { processed: true };
    });
  } catch (error) {
    if (isFinalAttempt(job.attemptsMade, job.opts.attempts)) {
      const message = error instanceof Error ? error.message : String(error);
      await withSystemTenantTx(sql, { schoolId }, (tx) =>
        failDsrRequest(tx, schoolId, requestId, message),
      );
    }
    throw error;
  }
}
