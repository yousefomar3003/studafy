/**
 * The export half of the GDPR pipeline (ST-268): "a complete export bundle (schema-verified)" for a
 * whole school (tenant closure) or one person within it (a filed DSR export).
 *
 * One S3 object per discovered tenant table (NDJSON, one `row_to_json` line per row -- letting
 * Postgres serialize its own rows sidesteps any JS round-trip precision/formatting mismatch for
 * numeric/date columns) plus one manifest.json tying them together with per-object SHA-256 and row
 * counts. `parseExportManifest` (export-manifest.ts) validates that manifest against
 * exportManifestSchema before it is uploaded -- a bundle that fails validation is a thrown error,
 * never a completed request with an unverified manifest.
 *
 * Unlike erasure, export does not consult retention-registry.ts's legal-hold classification: legal
 * hold says "erasure must not touch this", not "this must not be exported" -- a school's financial
 * ledger is exactly the kind of thing a closure export needs to include, and it's still the
 * responding party's own data under GDPR Art. 15. Every discovered tenant table is dumped the same
 * way, subject to the same per-user narrowing (findSubjectPredicate) a per-user DSR export needs.
 */

import { createHash } from "node:crypto";

import { armAdminActor, resolveAdminActor } from "./admin-actor";
import { FILE_TABLES, parseExportManifest } from "./export-manifest";
import { assertSafeIdentifier } from "./redact";
import { findSubjectPredicate, resolveSubjectIdentifiers } from "./subject-resolver";
import { discoverTenantTables } from "./tenant-tables";

import type { ExportManifest } from "./export-manifest";
import type { SubjectIdentifiers } from "./subject-resolver";
import type { TransactionSql } from "postgres";

/** The narrow object-storage port this worker needs -- shared shape with the reports framework's. */
export interface MaintenanceS3Client {
  put(
    key: string,
    body: Uint8Array,
    options: { contentType: string; contentDisposition: string },
  ): Promise<void>;
}

/**
 * A table this schema is known to have no admin-visible read path for at all
 * (docs/database/role-model.md; infra/tools/tenant-restore's README documents the same gap for the
 * sibling ST-267 tool). Listed once here rather than discovered, because there is nothing to
 * discover -- it is a fact about a specific RLS policy's design, not a pattern.
 */
const NO_ADMIN_VISIBILITY_TABLES: ReadonlySet<string> = new Set(["teacher_evaluations"]);

function sha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

async function dumpTableRows(
  tx: TransactionSql,
  table: string,
  schoolId: string,
  subject?: { column: string; value: string },
): Promise<string[]> {
  assertSafeIdentifier(table);
  const params: string[] = [schoolId];
  let whereClause = `"school_id" = $1`;
  if (subject) {
    assertSafeIdentifier(subject.column);
    params.push(subject.value);
    whereClause += ` AND "${subject.column}" = $2`;
  }
  const rows = await tx.unsafe<{ json: string }[]>(
    `SELECT row_to_json(t)::text AS json FROM app."${table}" AS t WHERE ${whereClause}`,
    params,
  );
  return rows.map((row) => row.json);
}

export interface TenantExportOptions {
  s3: MaintenanceS3Client;
  requestId: string;
  schoolId: string;
  subjectScope: "tenant" | "user";
  subjectUserId: string | null;
  now: Date;
}

export interface TenantExportResult {
  manifest: ExportManifest;
  manifestKey: string;
}

export function tenantExportPrefix(schoolId: string, requestId: string): string {
  return `dsr-exports/${schoolId}/${requestId}`;
}

/** Runs inside a transaction that already has `app.school_id` armed (`withSystemTenantTx`). */
export async function runTenantExport(
  tx: TransactionSql,
  options: TenantExportOptions,
): Promise<TenantExportResult> {
  const { s3, requestId, schoolId, subjectScope, subjectUserId, now } = options;
  const adminUserId = await resolveAdminActor(tx, schoolId);
  await armAdminActor(tx, adminUserId);

  // Resolving role identities up front (not just carrying the raw user id) is what lets
  // student_id/teacher_id-keyed tables (most academic records) be reached by findSubjectPredicate
  // below -- see subject-resolver.ts's header.
  const resolvedSubject: SubjectIdentifiers | undefined =
    subjectScope === "user" && subjectUserId
      ? await resolveSubjectIdentifiers(tx, schoolId, subjectUserId)
      : undefined;

  const prefix = tenantExportPrefix(schoolId, requestId);
  const tables = await discoverTenantTables(tx);

  const tableEntries: ExportManifest["tables"] = [];
  const fileEntries: ExportManifest["files"] = [];
  const knownGaps: string[] = [];

  for (const { tableName } of tables) {
    // This pipeline's own request ledger is metadata about the DSR process, not the subject's data.
    if (tableName === "data_subject_requests") continue;

    const predicate = resolvedSubject
      ? await findSubjectPredicate(tx, tableName, resolvedSubject)
      : undefined;
    if (resolvedSubject && !predicate) continue;

    const rows = await dumpTableRows(tx, tableName, schoolId, predicate ?? undefined);
    if (rows.length === 0) continue;

    if (NO_ADMIN_VISIBILITY_TABLES.has(tableName)) {
      knownGaps.push(
        `app.${tableName}: no admin read policy exists for this table (docs/database/role-model.md); ` +
          `rows neither authored nor received by the resolved admin actor may be missing from this bundle.`,
      );
    }

    const body = new TextEncoder().encode(rows.join("\n"));
    const key = `${prefix}/data/${tableName}.ndjson`;
    await s3.put(key, body, {
      contentType: "application/x-ndjson",
      contentDisposition: `attachment; filename="${tableName}.ndjson"`,
    });
    tableEntries.push({
      table: tableName,
      rowCount: rows.length,
      storageKey: key,
      sha256: sha256Hex(body),
    });

    if (FILE_TABLES.includes(tableName)) {
      for (const line of rows) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const storageKey = parsed.storage_key;
        const originalFileName = parsed.original_file_name;
        if (typeof storageKey === "string" && typeof originalFileName === "string") {
          fileEntries.push({
            table: tableName,
            storageKey,
            originalFileName,
            checksumSha256:
              typeof parsed.checksum_sha256 === "string" ? parsed.checksum_sha256 : null,
          });
        }
      }
    }
  }

  const manifest = parseExportManifest({
    schemaVersion: 1,
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

  const manifestKey = `${prefix}/manifest.json`;
  const manifestBody = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  await s3.put(manifestKey, manifestBody, {
    contentType: "application/json",
    contentDisposition: `attachment; filename="manifest.json"`,
  });

  return { manifest, manifestKey };
}
