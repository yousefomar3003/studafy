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

export const generateBatchInvoicesSchema = z.object({
  version: z.literal(1),
  schoolId: z.string().uuid(),
  feeStructureErpnextName: z.string().min(1),
  periodTitle: z.string().min(1),
  dueDate: z.string().optional(),
  classIds: z.array(z.string().uuid()).optional(),
  gradeIds: z.array(z.string().uuid()).optional(),
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
