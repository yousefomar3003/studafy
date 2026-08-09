import { JOB_NAMES } from "@studafy/constants";
import postgres from "postgres";

import { workerLogger } from "../../log";

import { processStripeBillingEvent } from "./billing-event.service";
import { runDunningSweep } from "./dunning-sweep";
import { generateInvoice, generateBatchInvoices } from "./invoice.service";
import {
  generateInvoiceSchema,
  generateBatchInvoicesSchema,
  processBillingEventSchema,
} from "./schemas";
import { runSeatReconciliation } from "./seat-reconciliation";
import { runStorageQuotaReconciliation } from "./storage-quota-reconciliation";
import { createStorageQuotaS3 } from "./storage-quota-s3";
import { StripeSeatSubscriptionProvider } from "./stripe-seat-provider";

import type {
  BillingJobData,
  GenerateInvoiceJobData,
  GenerateBatchInvoicesJobData,
} from "./schemas";
import type { Job } from "bullmq";

export const BILLING_QUEUE = JOB_NAMES.GENERATE_INVOICE;

/** S3 connectivity the storage-quota reconciliation sweep needs, supplied by the registry. */
export interface StorageReconciliationOptions {
  s3Region?: string;
  s3Endpoint?: string;
  bucket?: string;
}

export async function processBillingJob(
  job: Job<BillingJobData>,
  databaseUrl: string,
  storageOptions?: StorageReconciliationOptions,
): Promise<unknown> {
  if (job.name === JOB_NAMES.GENERATE_INVOICE) {
    const parsed = generateInvoiceSchema.safeParse(job.data);
    if (!parsed.success) {
      return { processed: false, reason: "invalid job data", errors: parsed.error.issues };
    }
    return processSingleInvoice(parsed.data, databaseUrl);
  }

  if (job.name === JOB_NAMES.GENERATE_BATCH_INVOICES) {
    const parsed = generateBatchInvoicesSchema.safeParse(job.data);
    if (!parsed.success) {
      return { processed: false, reason: "invalid job data", errors: parsed.error.issues };
    }
    return processBatchInvoices(parsed.data, databaseUrl);
  }

  // Stripe webhook retry (ST-132). Shares this queue because it is billing work and the queue is
  // named for what it carries, not for which provider it talks to; it shares nothing else with the
  // ERPNext invoice jobs above, which are untouched by it.
  if (job.name === JOB_NAMES.PROCESS_BILLING_EVENT) {
    const parsed = processBillingEventSchema.safeParse(job.data);
    if (!parsed.success) {
      return { processed: false, reason: "invalid job data", errors: parsed.error.issues };
    }
    return processStripeBillingEvent(parsed.data, databaseUrl, workerLogger);
  }

  // Daily grace-period sweep (ST-134). Carries no payload -- the scheduler registers it with no
  // data, and the sweep reads every school's grace state straight from the database. The sweep
  // owns its own postgres connection rather than running inside the job's, because it spans many
  // tenant transactions and each school commits on its own.
  if (job.name === JOB_NAMES.RUN_DUNNING) {
    return processDunningSweep(databaseUrl);
  }

  // Nightly seat reconciliation (ST-136). Same shape as the dunning sweep: no payload, its own
  // postgres connection, one tenant transaction per school. Unlike the dunning sweep it talks to
  // Stripe, so it also needs the Stripe secret -- billing must not silently skip reconciliation,
  // so a missing key is a thrown error (the registry re-queues it) rather than a dry run.
  if (job.name === JOB_NAMES.RUN_SEAT_RECONCILIATION) {
    return processSeatReconciliation(databaseUrl);
  }

  // Daily storage-quota reconciliation (ST-16x). Same shape as the dunning and seat sweeps: no
  // payload, its own postgres connection, one system tenant transaction per school. Unlike them it
  // talks to S3 (the bucket that holds the school's objects), so it needs the storage options — and
  // a missing S3 region/bucket is a thrown error (the registry re-queues it) rather than a silent
  // skip, because a meter that never reconciles drifts without limit.
  if (job.name === JOB_NAMES.RUN_STORAGE_QUOTA_RECONCILIATION) {
    return processStorageQuotaReconciliation(databaseUrl, storageOptions);
  }

  return { processed: false, reason: "unknown billing job" };
}

async function processSeatReconciliation(databaseUrl: string): Promise<unknown> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is required to run seat reconciliation");
  }

  const sql = postgres(databaseUrl, { max: 2 });

  try {
    return runSeatReconciliation(
      sql,
      new StripeSeatSubscriptionProvider(secretKey),
      new Date(),
      workerLogger,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function processStorageQuotaReconciliation(
  databaseUrl: string,
  options?: StorageReconciliationOptions,
): Promise<unknown> {
  if (!options?.s3Region || !options.bucket) {
    throw new Error(
      "S3_REGION and S3_APP_FILES_BUCKET are required to run storage quota reconciliation",
    );
  }

  const sql = postgres(databaseUrl, { max: 2 });

  try {
    return runStorageQuotaReconciliation(
      sql,
      createStorageQuotaS3({
        region: options.s3Region,
        endpoint: options.s3Endpoint,
        bucket: options.bucket,
      }),
      workerLogger,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function processDunningSweep(databaseUrl: string): Promise<unknown> {
  const sql = postgres(databaseUrl, { max: 2 });

  try {
    return runDunningSweep(sql, new Date(), workerLogger);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function processSingleInvoice(
  data: GenerateInvoiceJobData,
  databaseUrl: string,
): Promise<unknown> {
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    return sql.begin(async (tx) => {
      await tx`SELECT set_config('app.school_id', ${data.schoolId}, true)`.execute();
      await tx.unsafe("SET LOCAL ROLE studafy_admin");

      return generateInvoice(
        tx,
        data.schoolId,
        data,
        process.env.ERPNEXT_API_URL,
        process.env.ERPNEXT_API_KEY,
      );
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function processBatchInvoices(
  data: GenerateBatchInvoicesJobData,
  databaseUrl: string,
): Promise<unknown> {
  const sql = postgres(databaseUrl, { max: 2 });

  try {
    return sql.begin(async (tx) => {
      await tx`SELECT set_config('app.school_id', ${data.schoolId}, true)`.execute();
      await tx.unsafe("SET LOCAL ROLE studafy_admin");

      return generateBatchInvoices(
        tx,
        sql,
        data.schoolId,
        data,
        process.env.ERPNEXT_API_URL,
        process.env.ERPNEXT_API_KEY,
      );
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
