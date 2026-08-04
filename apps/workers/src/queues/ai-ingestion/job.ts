import { z } from "zod";

/**
 * The contract for an `ai-ingestion` job.
 *
 * Matches the house claim pattern: a job carries an id plus the school it belongs to, and the
 * worker locks the `app.materials` row FOR UPDATE inside a tenant transaction before claiming it
 * (the same shape as the imports worker's `{ importId, schoolId }`). The producer — the material
 * upload / ai-visible flow in apps/api — is a follow-up; this schema is the consumer's side of the
 * contract, so it lives with the worker that consumes it.
 */
export const aiIngestionJobDataSchema = z.object({
  version: z.literal(1),
  materialId: z.string().uuid(),
  schoolId: z.string().uuid(),
});

export type AiIngestionJobData = z.infer<typeof aiIngestionJobDataSchema>;
