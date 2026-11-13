/**
 * The original file behind a student import (docs/modules/student-import-mapping-guide.md "Import
 * history and unmapped columns"): kept, downloadable and deletable, and held only for the school's
 * retention period.
 *
 * The browser stages the file through the storage gateway under the import.source content class,
 * then posts the same bytes to the upload route. The upload checks the staged object's SHA-256
 * against the bytes it parsed before promoting it, so the archived file is exactly the one that was
 * imported. A school's export can hold ID numbers and medical notes no column of ours reads, so
 * it downloads only through a one-minute audited URL.
 *
 * An archived file holds many people's data and a per-person erasure cannot redact inside it, so it
 * lives a fixed time (docs/security/data_retention_and_dsr_policy.md "Student import files"): 180
 * days by default, shorter if the school chooses, then the daily import sweep deletes it together
 * with the import's leftover cells.
 */

import { ERROR_CODES, isServableUploadScanStatus } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { buildPermanentKey } from "../../lib/storage";
import { emitAuditLog } from "../../middleware/auditEmitter";
import { getContentClass } from "../storage/content-classes";
import { releaseStorageUsage } from "../storage/quota-service";
import { inspectStagedUpload } from "../storage/service";

import type { StorageService } from "../../lib/storage";
import type { StagedCopy } from "../storage/staged-promotion";
import type { TransactionSql } from "postgres";

export const IMPORT_SOURCE_CONTENT_CLASS = "import.source";

/** Days an original file and an import's leftover cells are kept; also the most a school may set. */
export const DEFAULT_SOURCE_RETENTION_DAYS = 180;
export const MAX_SOURCE_RETENTION_DAYS = 180;
export const MIN_SOURCE_RETENTION_DAYS = 1;

/** A signed download URL for an original file lives a minute, like a sensitive document's. */
export const IMPORT_SOURCE_DOWNLOAD_TTL_SECONDS = 60;

export interface StagedSourceFile {
  storageKey: string;
  fileName: string;
  sizeBytes: number;
}

/** A staged original that passed every check and is ready to be copied out of temp/. */
export interface InspectedSourceFile extends StagedCopy {
  fileName: string;
}

/**
 * Check a staged upload is this school's, a CSV within the class's cap, and byte-for-byte the body
 * the import parsed. Storage round trips only (a HEAD and a full read for the checksum): the
 * upload route runs it with no transaction open, then charges the quota, copies the object and
 * writes the import in short transactions around it (../storage/staged-promotion.ts).
 */
export async function inspectSourceFile(
  storage: StorageService,
  schoolId: string,
  stagedKey: string,
  bodySha256: string,
): Promise<InspectedSourceFile> {
  const upload = await inspectStagedUpload(
    storage,
    schoolId,
    getContentClass(IMPORT_SOURCE_CONTENT_CLASS),
    { storageKey: stagedKey, checksumSha256: bodySha256 },
  );
  return {
    tempKey: stagedKey,
    permanentKey: buildPermanentKey(schoolId, upload.parsed.objectId, upload.parsed.filename),
    sizeBytes: upload.sizeBytes,
    fileName: upload.parsed.filename,
  };
}

interface HeldSource {
  storage_key: string;
  size_bytes: number;
  scan_status: string;
}

async function heldSource(
  tx: TransactionSql,
  schoolId: string,
  importId: string,
  lock: boolean,
): Promise<HeldSource> {
  const [row] = await tx<
    { storage_key: string | null; size_bytes: number | null; scan_status: string }[]
  >`
    SELECT source_storage_key AS storage_key, source_size_bytes::int AS size_bytes,
           source_scan_status::text AS scan_status
    FROM app.student_imports
    WHERE id = ${importId}::uuid AND school_id = ${schoolId}
    ${lock ? tx`FOR UPDATE` : tx``}
  `;
  if (!row) {
    throw new CodedHttpException(404, ERROR_CODES.IMPORT_NOT_FOUND, "Import not found.");
  }
  if (!row.storage_key || row.size_bytes === null) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.IMPORT_SOURCE_NOT_FOUND,
      "The original file of this import is no longer stored.",
    );
  }
  return { storage_key: row.storage_key, size_bytes: row.size_bytes, scan_status: row.scan_status };
}

/** A one-minute download URL for the original file. Every issue is audited as a read. */
export async function sourceDownload(
  tx: TransactionSql,
  storage: StorageService,
  schoolId: string,
  importId: string,
): Promise<{ url: string; expires_at: string }> {
  const source = await heldSource(tx, schoolId, importId, false);
  // Not handed out until the malware scan has cleared it (F-14): answered as not held.
  if (!isServableUploadScanStatus(source.scan_status)) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.IMPORT_SOURCE_NOT_FOUND,
      "The original file of this import is not available.",
    );
  }
  await emitAuditLog(tx, {
    action: "read",
    targetTable: "student_imports",
    targetId: importId,
    newValues: { source_file: true, download: true },
  });
  const presigned = await storage.presign(
    source.storage_key,
    "GET",
    undefined,
    IMPORT_SOURCE_DOWNLOAD_TTL_SECONDS,
  );
  return { url: presigned.url, expires_at: presigned.expiresAt.toISOString() };
}

/**
 * Forget the original file. Returns its key for the caller to delete once the transaction commits.
 * The import's leftover cells are untouched: they still expire with the retention period.
 */
export async function deleteSource(
  tx: TransactionSql,
  schoolId: string,
  importId: string,
): Promise<{ removedKey: string }> {
  const source = await heldSource(tx, schoolId, importId, true);
  await tx`
    UPDATE app.student_imports
    SET source_storage_key = NULL,
        source_size_bytes = NULL,
        source_removed_at = CURRENT_TIMESTAMP,
        source_removed_reason = 'deleted',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${importId}::uuid AND school_id = ${schoolId}
  `;
  await releaseStorageUsage(tx, source.size_bytes);
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "student_imports",
    targetId: importId,
    oldValues: { source_file: true, size_bytes: source.size_bytes, removed_by: "staff" },
  });
  return { removedKey: source.storage_key };
}

export interface ImportSettings {
  source_retention_days: number;
  default_retention_days: number;
  max_retention_days: number;
  updated_at: string | null;
}

export async function getImportSettings(
  tx: TransactionSql,
  schoolId: string,
): Promise<ImportSettings> {
  const [row] = await tx<{ source_retention_days: number; updated_at: Date }[]>`
    SELECT source_retention_days, updated_at FROM app.student_import_settings
    WHERE school_id = ${schoolId}
  `;
  return {
    source_retention_days: row?.source_retention_days ?? DEFAULT_SOURCE_RETENTION_DAYS,
    default_retention_days: DEFAULT_SOURCE_RETENTION_DAYS,
    max_retention_days: MAX_SOURCE_RETENTION_DAYS,
    updated_at: row?.updated_at.toISOString() ?? null,
  };
}

/** Shorten (or restore, up to the default) how long original files and leftover cells are kept.
 * Applies to every import already held: the next daily sweep deletes what the new period expires. */
export async function updateImportSettings(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  sourceRetentionDays: number,
): Promise<ImportSettings> {
  const previous = await getImportSettings(tx, schoolId);
  await tx`
    INSERT INTO app.student_import_settings (school_id, source_retention_days, updated_by)
    VALUES (${schoolId}, ${sourceRetentionDays}, ${userId}::uuid)
    ON CONFLICT (school_id) DO UPDATE SET
      source_retention_days = EXCLUDED.source_retention_days,
      updated_by = EXCLUDED.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "student_import_settings",
    targetId: schoolId,
    oldValues: { source_retention_days: previous.source_retention_days },
    newValues: { source_retention_days: sourceRetentionDays },
  });
  return getImportSettings(tx, schoolId);
}
