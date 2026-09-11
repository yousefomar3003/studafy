/**
 * The export bundle manifest (ST-268): the schema tenant-export.worker.ts's output is validated
 * against before it is ever uploaded, and the "complete export bundle (schema-verified)" acceptance
 * criterion's proof. `parseExportManifest` throwing is exactly what a malformed bundle looks like --
 * the worker calls it and lets the throw fail the job rather than uploading and marking a request
 * completed with a manifest nobody has checked.
 */

import { z } from "zod";

/**
 * Tables known to store an uploaded file's bytes, keyed by a `storage_key`/`original_file_name`/
 * `checksum_sha256` triple (db/migrations/000011, 000049, 000050). A short, verified list rather
 * than a heuristic over column names, the same "small and explicit beats a guess" choice
 * retention-registry.ts's SUBJECT_LINK_COLUMNS makes.
 */
export const FILE_TABLES: readonly string[] = [
  "materials",
  "assignment_attachments",
  "submission_attachments",
];

export const exportManifestTableEntrySchema = z.object({
  table: z.string().min(1),
  rowCount: z.number().int().nonnegative(),
  storageKey: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const exportManifestFileEntrySchema = z.object({
  table: z.string().min(1),
  storageKey: z.string().min(1),
  originalFileName: z.string().min(1),
  checksumSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});

export const exportManifestRetainedEntrySchema = z.object({
  table: z.string().min(1),
  reason: z.string().min(1),
});

/**
 * Schema version 1. A future incompatible manifest shape bumps this rather than silently changing
 * meaning under the same version -- the same reasoning app.audit_export_jobs' `file_format` CHECK
 * pins to a fixed literal rather than leaving it open.
 */
export const EXPORT_MANIFEST_SCHEMA_VERSION = 1;

export const exportManifestSchema = z.object({
  schemaVersion: z.literal(EXPORT_MANIFEST_SCHEMA_VERSION),
  requestId: z.string().uuid(),
  schoolId: z.string().uuid(),
  subjectScope: z.enum(["tenant", "user"]),
  subjectUserId: z.string().uuid().nullable(),
  generatedAt: z.string().datetime(),
  tables: z.array(exportManifestTableEntrySchema),
  files: z.array(exportManifestFileEntrySchema),
  retainedTables: z.array(exportManifestRetainedEntrySchema),
  /**
   * Honest, structured limitations of this specific bundle -- e.g. app.teacher_evaluations rows
   * this pipeline could not read for the same RLS reason infra/tools/tenant-restore's README
   * documents at length ("no admin escape hatch" on that table's visibility policy). Never empty by
   * assumption: a bundle with nothing to disclose still asserts that explicitly, as `[]`, rather
   * than omitting the field.
   */
  knownGaps: z.array(z.string()),
});

export type ExportManifest = z.infer<typeof exportManifestSchema>;

export function parseExportManifest(value: unknown): ExportManifest {
  return exportManifestSchema.parse(value);
}
