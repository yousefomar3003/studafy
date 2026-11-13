/**
 * The export bundle manifest (ST-268): `manifest.json` inside the export's ZIP archive, validated
 * against this schema before it is written, and the "complete export bundle (schema-verified)"
 * acceptance criterion's proof. `parseExportManifest` throwing is exactly what a malformed bundle
 * looks like -- the worker calls it and lets the throw fail the job (and the upload) rather than
 * marking a request completed with a manifest nobody has checked.
 */

import { z } from "zod";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** One data file in the archive: a table's rows as a JSON array. */
export const exportManifestTableEntrySchema = z.object({
  table: z.string().min(1),
  rowCount: z.number().int().nonnegative(),
  /** The entry's path inside the archive, e.g. `data/students.json`. */
  path: z.string().min(1),
  /** SHA-256 of the entry's bytes. */
  sha256: sha256Schema,
});

/** One stored file the export covers (export-files.ts, records-dsr.ts). */
export const exportManifestFileEntrySchema = z.object({
  /** The table that references the file, and that row's id (an answer id for a record document). */
  table: z.string().min(1),
  sourceId: z.string().min(1),
  originalFileName: z.string().min(1),
  /** Where the copy is in the archive; `null` when nothing was stored under the file's key. */
  path: z.string().min(1).nullable(),
  /** Size and SHA-256 of the copy in the archive (`null` with `path`). */
  sizeBytes: z.number().int().nonnegative().nullable(),
  sha256: sha256Schema.nullable(),
  /** The checksum recorded at upload, when the table keeps one. */
  uploadSha256: sha256Schema.nullable(),
});

export const exportManifestRetainedEntrySchema = z.object({
  table: z.string().min(1),
  reason: z.string().min(1),
});

/**
 * Schema version 2: the manifest is an entry of the export's ZIP archive, and every table and file
 * entry names its path in that archive (version 1 named separate storage objects, and listed files
 * without copying them). A future incompatible shape bumps this rather than silently changing
 * meaning under the same version -- the same reasoning app.audit_export_jobs' `file_format` CHECK
 * pins to a fixed literal rather than leaving it open.
 */
export const EXPORT_MANIFEST_SCHEMA_VERSION = 2;

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
