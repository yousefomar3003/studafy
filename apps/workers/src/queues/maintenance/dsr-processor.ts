/**
 * BullMQ dispatch for one data subject request (ST-268): claim the row, run the export or erasure
 * it names, record the outcome. Mirrors the report framework's runReport (report-runner.ts) in
 * shape -- claim, do the work, complete, or fail on the final attempt -- but is its own function
 * because the two halves produce genuinely different completions (one storage key vs. two
 * structured lists), which report-runner.ts's single `storageKey`-shaped result cannot express
 * without new plumbing that would exist for this one caller.
 */

import { JOB_NAMES } from "@studafy/constants";

import { leaseDatabase } from "../../db/pool";
import { withSystemTenantTx } from "../../db/tenant-tx";
import { isFinalAttempt } from "../reports/report-runner";
import { createReportS3 } from "../reports/report-s3";

import {
  claimDsrRequest,
  completeDsrErasure,
  completeDsrExport,
  failDsrRequest,
} from "./dsr-store";
import { createMaintenanceS3 } from "./export-storage";
import { resolveSubjectIdentifiers } from "./subject-resolver";
import { runTenantErasure } from "./tenant-erasure.worker";
import { runTenantExport } from "./tenant-export.worker";

import type { MaintenanceS3Client } from "./export-storage";
import type { DatabaseLease } from "../../db/pool";
import type { RecordKeyring } from "@studafy/records";
import type { Job } from "bullmq";
import type { Sql } from "postgres";

export interface MaintenanceRunnerConfig {
  /** Used only when `sql` is absent: a dedicated pool is opened per job (tests). */
  primaryDatabaseUrl: string;
  databaseCaCert?: string;
  /** The process-wide pool (db/pool.ts). Borrowed, never ended here. */
  sql?: Sql;
  s3Region?: string;
  s3Endpoint?: string;
  bucket?: string;
  /** For the account-deletion sweep's Stripe AI add-on cancellations; absent outside production. */
  stripeSecretKey?: string;
  /** For the same sweep's Google Play renewal cancellations; both set, or the call is skipped. */
  googlePlayPackageName?: string;
  googlePlayServiceAccount?: string;
  /** Opens sensitive record answers for a DSR export (ADR-019). */
  recordKeyring: RecordKeyring;
}

export interface DsrJobResult {
  processed: boolean;
  reason?: string;
}

/** The pool a maintenance job runs on: the shared one when configured, else a dedicated one. */
export function leaseMaintenancePool(config: MaintenanceRunnerConfig): DatabaseLease {
  return leaseDatabase(config.sql ?? config.primaryDatabaseUrl, {
    databaseCaCert: config.databaseCaCert,
  });
}

/** Reads the stored files an export copies and streams its archive (export-storage.ts). */
function createMaintenanceStorage(config: MaintenanceRunnerConfig): MaintenanceS3Client {
  const region = config.s3Region;
  const bucket = config.bucket;
  if (!region || !bucket) throw new Error("DSR export storage is not configured");
  return createMaintenanceS3({ region, endpoint: config.s3Endpoint, bucket });
}

/**
 * Delete the files an erasure released: record documents, import sources and message images. A
 * failure leaves an unreferenced object, never a dangling row.
 */
async function removeObjects(config: MaintenanceRunnerConfig, keys: readonly string[]) {
  if (keys.length === 0 || !config.s3Region || !config.bucket) return;
  const s3 = createReportS3({
    region: config.s3Region,
    endpoint: config.s3Endpoint,
    bucket: config.bucket,
  });
  for (const key of keys) {
    try {
      await s3.remove(key);
    } catch {
      // Unreferenced now; storage-quota reconciliation reports it.
    }
  }
}

export async function processDsrJob(
  job: Job,
  config: MaintenanceRunnerConfig,
): Promise<DsrJobResult> {
  const data = job.data as { requestId?: string; schoolId?: string };
  if (!data.requestId || !data.schoolId) return { processed: false, reason: "missing job data" };

  const lease = leaseMaintenancePool(config);
  try {
    return await runDsrJob(lease.sql, config, job, data.requestId, data.schoolId);
  } finally {
    await lease.release();
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
    let orphanedStorageKeys: string[] = [];
    const result = await withSystemTenantTx(
      sql,
      { schoolId },
      async (tx): Promise<DsrJobResult> => {
        const claim = await claimDsrRequest(tx, schoolId, requestId);
        if (claim.state === "terminal") return { processed: true };
        const record = claim.record;

        if (job.name === JOB_NAMES.RUN_DATA_SUBJECT_EXPORT) {
          const { archiveKey } = await runTenantExport(tx, {
            s3: createMaintenanceStorage(config),
            requestId,
            schoolId,
            subjectScope: record.subjectScope,
            subjectUserId: record.subjectUserId,
            now: new Date(),
            recordKeyring: config.recordKeyring,
          });
          await completeDsrExport(tx, schoolId, requestId, archiveKey);
          return { processed: true };
        }

        const subject =
          record.subjectScope === "user" && record.subjectUserId
            ? await resolveSubjectIdentifiers(tx, schoolId, record.subjectUserId)
            : undefined;
        const erasure = await runTenantErasure(tx, schoolId, subject);
        orphanedStorageKeys = erasure.orphanedStorageKeys;
        await completeDsrErasure(
          tx,
          schoolId,
          requestId,
          erasure.redactedTables,
          erasure.retainedTables,
        );
        return { processed: true };
      },
    );
    // Only after the erasure committed: a rolled-back erasure must leave its files in place.
    await removeObjects(config, orphanedStorageKeys);
    return result;
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
