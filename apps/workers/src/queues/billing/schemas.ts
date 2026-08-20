import { z } from "zod";

export const generateInvoiceSchema = z.object({
  version: z.literal(1),
  schoolId: z.string().uuid(),
  studentId: z.string().uuid(),
  feeStructureErpnextName: z.string().min(1),
  idempotencyKey: z.string().uuid(),
  periodTitle: z.string().min(1),
  dueDate: z.string().optional(),
});

export type GenerateInvoiceJobData = z.infer<typeof generateInvoiceSchema>;

/**
 * `batchId` names an `app.invoice_batches` row (ST-202) whose `invoice_batch_items` were already
 * seeded — one `pending` row per target student — by `createInvoiceBatch` (apps/api/.../finance/
 * invoices/service.ts) before this job was enqueued. Target resolution (which students) happens
 * once, there; this job only re-reads whichever items are still `pending`, which is what makes a
 * BullMQ retry resumable instead of restarting the whole batch. There is deliberately no `classIds`/
 * `gradeIds` here anymore — the old inline query built from them filtered `app.students` by
 * `class_id`/`grade_id` columns that table has never had (class membership lives in
 * `app.enrollments`), so it could never have run successfully; `createInvoiceBatch` resolves
 * membership correctly instead.
 */
export const generateBatchInvoicesSchema = z.object({
  version: z.literal(1),
  schoolId: z.string().uuid(),
  batchId: z.string().uuid(),
  feeStructureErpnextName: z.string().min(1),
  periodTitle: z.string().min(1),
  dueDate: z.string().optional(),
});

export type GenerateBatchInvoicesJobData = z.infer<typeof generateBatchInvoicesSchema>;

/**
 * Stripe webhook retry (ST-132).
 *
 * The provider event id and nothing else. The verified payload is already in `app.billing_events`,
 * written by the claim in the transaction that later failed; a job carrying its own copy could
 * disagree with the row and there would be no way to say which was right.
 *
 * No `schoolId`, unlike every other job here: the event is looked up before its school is known, and
 * an event that could not be attributed is exactly the kind most likely to need retrying.
 */
export const processBillingEventSchema = z.object({
  version: z.literal(1),
  providerEventId: z.string().min(1),
});

export type ProcessBillingEventJobData = z.infer<typeof processBillingEventSchema>;

export type BillingJobData =
  GenerateInvoiceJobData | GenerateBatchInvoicesJobData | ProcessBillingEventJobData;
