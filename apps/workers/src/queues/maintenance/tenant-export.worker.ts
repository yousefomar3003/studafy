/**
 * The export half of the GDPR pipeline (ST-268): "a complete export bundle (schema-verified)" for a
 * whole school (tenant closure) or one person within it (a filed DSR export).
 *
 * The bundle is one ZIP archive (`dsrExportArchiveKey`, under the request's dsr-exports/ prefix),
 * streamed to storage as it is written (export-archive.ts):
 *
 *   README.txt                 what the archive holds, for the person reading it
 *   manifest.json              every entry, with row counts and SHA-256 checksums
 *   data/<table>.json          one JSON array per table, one `row_to_json` row per line -- letting
 *                              Postgres serialize its own rows sidesteps any JS round-trip
 *                              precision/formatting mismatch for numeric/date columns
 *   files/<folder>/<name>      copies of the stored files (export-files.ts, records-dsr.ts)
 *
 * Rows are read through a cursor and files are streamed from storage, so neither a large table nor
 * a school's every upload is held in memory. `parseExportManifest` (export-manifest.ts) validates
 * the manifest before it is written -- a bundle that fails validation is a thrown error, the upload
 * is abandoned, and the request is never completed with an unverified manifest.
 *
 * Unlike erasure, export does not consult retention-registry.ts's legal-hold classification: legal
 * hold says "erasure must not touch this", not "this must not be exported" -- a school's financial
 * ledger is exactly the kind of thing a closure export needs to include, and it's still the
 * responding party's own data under GDPR Art. 15. Every discovered tenant table is dumped the same
 * way, subject to the same per-user narrowing (findSubjectPredicate) a per-user DSR export needs.
 */

import { dsrExportArchiveKey, dsrExportPrefix } from "@studafy/constants";

import { armAdminActor, resolveAdminActor } from "./admin-actor";
import { ArchivePaths, ExportArchiveWriter } from "./export-archive";
import { EXPORT_FILE_FOLDERS, MESSAGE_FILES_EXPORT_GAP, listExportFiles } from "./export-files";
import { parseExportManifest } from "./export-manifest";
import { renderExportReadme } from "./export-readme";
import { exportPartSize } from "./export-storage";
import { IMPORT_FILES_EXPORT_GAP } from "./imports-dsr";
import { RECORD_DATA_TABLES, exportCustomListData, exportRecordData } from "./records-dsr";
import { assertSafeIdentifier } from "./redact";
import { findSubjectPredicate, resolveSubjectIdentifiers } from "./subject-resolver";
import { discoverTenantTables } from "./tenant-tables";

import type { ExportFileSource } from "./export-files";
import type { ExportManifest } from "./export-manifest";
import type { MaintenanceS3Client } from "./export-storage";
import type { SubjectIdentifiers } from "./subject-resolver";
import type { RecordKeyring } from "@studafy/records";
import type { TransactionSql } from "postgres";

export type { MaintenanceS3Client } from "./export-storage";

/**
 * A table this schema is known to have no admin-visible read path for at all
 * (docs/database/role-model.md; infra/tools/tenant-restore's README documents the same gap for the
 * sibling ST-267 tool). Listed once here rather than discovered, because there is nothing to
 * discover -- it is a fact about a specific RLS policy's design, not a pattern.
 */
const NO_ADMIN_VISIBILITY_TABLES: ReadonlySet<string> = new Set(["teacher_evaluations"]);

/** Rows fetched per cursor round trip while a table is written to the archive. */
const CURSOR_BATCH_ROWS = 500;

interface RowFilter {
  clause: string;
  params: string[];
}

function rowFilter(table: string, schoolId: string, subject?: { column: string; value: string }) {
  assertSafeIdentifier(table);
  const filter: RowFilter = { clause: `"school_id" = $1`, params: [schoolId] };
  if (subject) {
    assertSafeIdentifier(subject.column);
    filter.clause += ` AND "${subject.column}" = $2`;
    filter.params.push(subject.value);
  }
  return filter;
}

async function hasRows(tx: TransactionSql, table: string, filter: RowFilter): Promise<boolean> {
  const [row] = await tx.unsafe<{ found: boolean }[]>(
    `SELECT EXISTS (SELECT 1 FROM app."${table}" WHERE ${filter.clause}) AS found`,
    filter.params,
  );
  return row?.found ?? false;
}

/** A JSON array of the table's rows, one per line, read through a cursor. */
async function* tableJson(
  tx: TransactionSql,
  table: string,
  filter: RowFilter,
  counter: { rows: number },
): AsyncGenerator<string> {
  yield "[";
  const cursor = tx
    .unsafe<{ json: string }[]>(
      `SELECT row_to_json(t)::text AS json FROM app."${table}" AS t WHERE ${filter.clause}`,
      filter.params,
    )
    .cursor(CURSOR_BATCH_ROWS);
  for await (const rows of cursor) {
    let batch = "";
    for (const row of rows) {
      batch += (counter.rows === 0 ? "\n" : ",\n") + row.json;
      counter.rows += 1;
    }
    yield batch;
  }
  yield "\n]\n";
}

/** Lines that are already JSON objects, as a JSON array in the same shape as tableJson's. */
function linesJson(lines: readonly string[]): string {
  return `[\n${lines.join(",\n")}\n]\n`;
}

export interface TenantExportOptions {
  s3: MaintenanceS3Client;
  requestId: string;
  schoolId: string;
  subjectScope: "tenant" | "user";
  subjectUserId: string | null;
  now: Date;
  /** Opens sensitive record answers for the archive, so it holds the subject's data, not ciphertext. */
  recordKeyring: RecordKeyring;
}

export interface TenantExportResult {
  manifest: ExportManifest;
  /** The archive's storage key: what the request's `storage_key` is set to. */
  archiveKey: string;
  archiveBytes: number;
}

/** The request's storage prefix, without the trailing slash. */
export function tenantExportPrefix(schoolId: string, requestId: string): string {
  return dsrExportPrefix(schoolId, requestId).replace(/\/$/, "");
}

async function displayNames(
  tx: TransactionSql,
  schoolId: string,
  subjectUserId: string | null,
): Promise<{ schoolName: string; subjectName: string | null }> {
  const [school] = await tx<{ name: string }[]>`
    SELECT name FROM app.schools WHERE id = ${schoolId}::uuid
  `;
  const [subject] = subjectUserId
    ? await tx<{ display_name: string | null }[]>`
        SELECT display_name FROM app.users
        WHERE school_id = ${schoolId}::uuid AND id = ${subjectUserId}::uuid
      `
    : [];
  return { schoolName: school?.name ?? "The school", subjectName: subject?.display_name ?? null };
}

/** Runs inside a transaction that already has `app.school_id` armed (`withSystemTenantTx`). */
export async function runTenantExport(
  tx: TransactionSql,
  options: TenantExportOptions,
): Promise<TenantExportResult> {
  const { s3, requestId, schoolId, subjectScope, subjectUserId, now, recordKeyring } = options;
  const adminUserId = await resolveAdminActor(tx, schoolId);
  await armAdminActor(tx, adminUserId);

  // Resolving role identities up front (not just carrying the raw user id) is what lets
  // student_id/teacher_id-keyed tables (most academic records) be reached by findSubjectPredicate
  // below -- see subject-resolver.ts's header.
  const resolvedSubject: SubjectIdentifiers | undefined =
    subjectScope === "user" && subjectUserId
      ? await resolveSubjectIdentifiers(tx, schoolId, subjectUserId)
      : undefined;

  // Everything that is read into memory anyway is read before the archive starts.
  const tables = await discoverTenantTables(tx);
  const records = await exportRecordData(tx, schoolId, resolvedSubject, recordKeyring);
  const customListLines = await exportCustomListData(tx, schoolId, resolvedSubject, recordKeyring);
  const fileSources: ExportFileSource[] = [
    ...(await listExportFiles(tx, schoolId, resolvedSubject)),
    ...records.files.map((file) => ({
      table: "record_documents",
      ...file,
      checksumSha256: null,
    })),
  ];
  const names = await displayNames(tx, schoolId, subjectUserId);

  const knownGaps: string[] = [MESSAGE_FILES_EXPORT_GAP];
  // Original student import files: a closure's bundle copies every one still held (the school's
  // own uploads); a person's bundle cannot search inside them, and says so.
  if (resolvedSubject) knownGaps.push(IMPORT_FILES_EXPORT_GAP);

  const archiveKey = dsrExportArchiveKey(schoolId, requestId);
  const expectedFileBytes = fileSources.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
  const downloadName = `studafy-export-${now.toISOString().slice(0, 10)}.zip`;
  const writer = new ExportArchiveWriter(
    (body) =>
      s3.putStream(archiveKey, body, {
        contentType: "application/zip",
        contentDisposition: `attachment; filename="${downloadName}"`,
        partSizeBytes: exportPartSize(expectedFileBytes),
      }),
    now,
  );

  try {
    const tableEntries: ExportManifest["tables"] = [];

    for (const { tableName } of tables) {
      // This pipeline's own request ledger is metadata about the DSR process, not the subject's data.
      if (tableName === "data_subject_requests") continue;
      // Record answers and custom list cells are exported opened, below (records-dsr.ts): a raw dump
      // would hand the subject ciphertext, and a cell has no link column to scope it by.
      if (RECORD_DATA_TABLES.has(tableName)) continue;

      const predicate = resolvedSubject
        ? await findSubjectPredicate(tx, tableName, resolvedSubject)
        : undefined;
      if (resolvedSubject && !predicate) continue;

      const filter = rowFilter(tableName, schoolId, predicate ?? undefined);
      if (!(await hasRows(tx, tableName, filter))) continue;

      if (NO_ADMIN_VISIBILITY_TABLES.has(tableName)) {
        knownGaps.push(
          `app.${tableName}: no admin read policy exists for this table (docs/database/role-model.md); ` +
            `rows neither authored nor received by the resolved admin actor may be missing from this bundle.`,
        );
      }

      const path = `data/${tableName}.json`;
      const counter = { rows: 0 };
      const entry = await writer.add(path, tableJson(tx, tableName, filter, counter), {
        compress: true,
      });
      tableEntries.push({ table: tableName, rowCount: counter.rows, path, sha256: entry.sha256 });
    }

    for (const [table, lines] of [
      ["record_answers", records.lines],
      ["custom_list_rows", customListLines],
    ] as const) {
      if (lines.length === 0) continue;
      const path = `data/${table}.json`;
      const entry = await writer.add(path, linesJson(lines), { compress: true });
      tableEntries.push({ table, rowCount: lines.length, path, sha256: entry.sha256 });
    }

    const paths = new ArchivePaths();
    const fileEntries: ExportManifest["files"] = [];
    let mismatched = 0;
    for (const file of fileSources) {
      const body = await s3.open(file.storageKey);
      const base = {
        table: file.table,
        sourceId: file.sourceId,
        originalFileName: file.originalFileName,
        uploadSha256: file.checksumSha256,
      };
      if (!body) {
        fileEntries.push({ ...base, path: null, sizeBytes: null, sha256: null });
        continue;
      }
      const folder = EXPORT_FILE_FOLDERS[file.table] ?? "other";
      const path = paths.allocate(`files/${folder}`, file.originalFileName);
      const entry = await writer.add(path, body, { compress: false });
      if (file.checksumSha256 && file.checksumSha256 !== entry.sha256) mismatched += 1;
      fileEntries.push({ ...base, path, sizeBytes: entry.bytes, sha256: entry.sha256 });
    }
    if (mismatched > 0) {
      knownGaps.push(
        `${mismatched} of the copied files differ from the checksum recorded when they were ` +
          "uploaded (manifest.json: sha256 and uploadSha256).",
      );
    }

    const manifest = parseExportManifest({
      schemaVersion: 2,
      requestId,
      schoolId,
      subjectScope,
      subjectUserId,
      generatedAt: now.toISOString(),
      tables: tableEntries,
      files: fileEntries,
      retainedTables: [],
      knownGaps,
    });

    await writer.add("manifest.json", JSON.stringify(manifest, null, 2), { compress: true });
    await writer.add("README.txt", renderExportReadme({ manifest, ...names }), { compress: true });
    const archiveBytes = await writer.finish();
    return { manifest, archiveKey, archiveBytes };
  } catch (error) {
    await writer.abort(error);
    throw error;
  }
}
