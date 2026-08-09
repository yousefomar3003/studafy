import { z } from "zod";

/**
 * One `derive-material-previews` job. Carries only the material id: the worker reads
 * `storage_key`/`mime_type` from the row, so a retry never acts on stale payload data.
 */
export const deriveMaterialJobDataSchema = z.object({
  schoolId: z.string().uuid(),
  materialId: z.string().uuid(),
});

export type DeriveMaterialJobData = z.infer<typeof deriveMaterialJobDataSchema>;
