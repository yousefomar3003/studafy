/**
 * Job dispatch for the `maintenance` queue (ST-268): the scheduled tenant-closure sweep, every data
 * subject request (export or erasure) it and the DSR API file, the scheduled Ask AI message
 * retention purge (ST-309), the scheduled data retention sweep (data-retention-sweep.ts), the
 * scheduled IP-address retention sweep, the scheduled account-deletion sweep (000143) and the
 * scheduled abandoned-material sweep (abandoned-material-sweep.ts). Mirrors
 * the reports queue's report-registry.ts dispatch shape -- one
 * function the queue's Worker hands every job to.
 */

import { JOB_NAMES } from "@studafy/constants";

import { workerLogger } from "../../log";
import { createStorageQuotaS3 } from "../billing/storage-quota-s3";
import { createReportS3 } from "../reports/report-s3";
import { sweepStuckUploadScans } from "../scan/stuck-scan-sweep";

import { purgeAbandonedMaterials } from "./abandoned-material-sweep";
import { runAccountDeletionSweep } from "./account-deletion-sweep";
import { purgeExpiredAiMessages } from "./ai-message-retention-sweep";
import { reembedStaleChunks } from "./chunk-reembed-sweep";
import { CLOSURE_ERASURE_RETENTION_HOLD_DAYS, runTenantClosureSweep } from "./closure-sweep";
import { purgeExpiredRetainedData } from "./data-retention-sweep";
import { leaseMaintenancePool, processDsrJob } from "./dsr-processor";
import { GooglePlayAiBillingCanceller } from "./google-play-ai-billing-canceller";
import { purgeExpiredIpAddresses } from "./ip-address-retention-sweep";
import { createMaterialObjectStore } from "./material-object-store";
import { ensureFuturePartitions } from "./partition-maintenance";
import { resealRecordValues } from "./record-key-rotation";
import { purgeExpiredSensitiveRecords } from "./record-retention-sweep";
import { StripeAiBillingCanceller } from "./stripe-ai-billing-canceller";

import type { EnqueueDsrJob } from "./closure-sweep";
import type { RetentionObjectStore } from "./data-retention-sweep";
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
    const billing = {
      stripe: config.stripeSecretKey ? new StripeAiBillingCanceller(config.stripeSecretKey) : null,
      googlePlay:
        config.googlePlayPackageName && config.googlePlayServiceAccount
          ? new GooglePlayAiBillingCanceller({
              packageName: config.googlePlayPackageName,
              serviceAccountJson: config.googlePlayServiceAccount,
            })
          : null,
    };
    const result = await withPrimarySql(config, (sql) =>
      runAccountDeletionSweep(sql, new Date(), billing, enqueue, workerLogger),
    );
    return { processed: true, ...result };
  }

  if (job.name === JOB_NAMES.ENSURE_TABLE_PARTITIONS) {
    const result = await withPrimarySql(config, (sql) => ensureFuturePartitions(sql, workerLogger));
    return result.ran ? { processed: true } : { processed: false, reason: "partition lock held" };
  }

  if (job.name === JOB_NAMES.PURGE_EXPIRED_AI_MESSAGES) {
    const result = await withPrimarySql(config, (sql) => purgeExpiredAiMessages(sql, workerLogger));
    return { processed: true, ...result };
  }

  if (job.name === JOB_NAMES.REEMBED_STALE_CHUNKS) {
    const provider = config.embeddingProvider;
    if (!provider) return { processed: false, reason: "no embedding model configured" };
    const result = await withPrimarySql(config, (sql) =>
      reembedStaleChunks(sql, provider, workerLogger),
    );
    if (result.reembedded > 0 || result.failed > 0) {
      workerLogger.info({ event: "chunk_reembed_sweep", ...result }, "chunk re-embed sweep done");
    }
    return { processed: true, ...result };
  }

  if (job.name === JOB_NAMES.PURGE_EXPIRED_IP_ADDRESSES) {
    const result = await withPrimarySql(config, (sql) =>
      purgeExpiredIpAddresses(sql, new Date(), workerLogger),
    );
    return { processed: true, ...result };
  }

  if (job.name === JOB_NAMES.SWEEP_STUCK_UPLOAD_SCANS) {
    const enqueueUploadScans = config.enqueueUploadScans;
    if (!enqueueUploadScans) return { processed: false, reason: "no scan queue configured" };
    const result = await withPrimarySql(config, (sql) =>
      sweepStuckUploadScans(sql, enqueueUploadScans, new Date(), workerLogger),
    );
    return { processed: true, ...result };
  }

  if (job.name === JOB_NAMES.PURGE_ABANDONED_MATERIALS) {
    const storage =
      config.s3Region && config.bucket
        ? createMaterialObjectStore({
            region: config.s3Region,
            endpoint: config.s3Endpoint,
            bucket: config.bucket,
          })
        : null;
    const result = await withPrimarySql(config, (sql) =>
      purgeAbandonedMaterials(sql, storage, new Date(), workerLogger),
    );
    workerLogger.info(
      { event: "abandoned_material_sweep", ...result },
      "abandoned material sweep done",
    );
    return { processed: true, ...result };
  }

  if (job.name === JOB_NAMES.PURGE_EXPIRED_RETAINED_DATA) {
    const storage = createRetentionObjectStore(config);
    const result = await withPrimarySql(config, (sql) =>
      purgeExpiredRetainedData(sql, storage, new Date(), workerLogger),
    );
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

/** The data retention sweep lists export bundles and deletes objects; null without a bucket. */
function createRetentionObjectStore(config: MaintenanceRunnerConfig): RetentionObjectStore | null {
  if (!config.s3Region || !config.bucket) return null;
  const options = { region: config.s3Region, endpoint: config.s3Endpoint, bucket: config.bucket };
  const objects = createReportS3(options);
  const listing = createStorageQuotaS3(options);
  return { list: (prefix) => listing.list(prefix), remove: (key) => objects.remove(key) };
}

async function withPrimarySql<T>(
  config: MaintenanceRunnerConfig,
  fn: (sql: Sql) => Promise<T>,
): Promise<T> {
  const lease = leaseMaintenancePool(config);
  try {
    return await fn(lease.sql);
  } finally {
    await lease.release();
  }
}
