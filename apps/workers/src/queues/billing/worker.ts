import { JOB_NAMES } from "@studafy/constants";
import postgres from "postgres";

import { workerLogger } from "../../log";

import { processStripeBillingEvent } from "./billing-event.service";
import { generateInvoice, generateBatchInvoices } from "./invoice.service";
import {
  generateInvoiceSchema,
  generateBatchInvoicesSchema,
  processBillingEventSchema,
} from "./schemas";

import type {
  BillingJobData,
  GenerateInvoiceJobData,
  GenerateBatchInvoicesJobData,
} from "./schemas";
import type { Job } from "bullmq";

export const BILLING_QUEUE = JOB_NAMES.GENERATE_INVOICE;

export async function processBillingJob(
  job: Job<BillingJobData>,
  databaseUrl: string,
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

  return { processed: false, reason: "unknown billing job" };
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
