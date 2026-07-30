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

export type BillingJobData = GenerateInvoiceJobData | GenerateBatchInvoicesJobData;
