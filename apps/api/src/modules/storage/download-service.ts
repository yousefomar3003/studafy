/**
 * Download service: the read leg of the storage gateway.
 *
 * Unlike service.ts (which is database-free by design), this module is deliberately database-aware.
 * A pre-signed GET URL is a capability: whoever holds it can read the object for its lifetime, so
 * the gateway must not mint one for an object the caller could not read. That row-scope check
 * cannot be done from the key alone (the key only proves tenant, not role scope), so each class
 * resolves its object through a tenant-scoped query that runs under RLS -- a student can only ever
 * resolve a material in a class they can read, a parent only their child's submission. The query
 * is the authorization; the URL is minted only after it answers.
 *
 * The returned key is trusted because it came out of a tenant-scoped, RLS-filtered row, so it is
 * signed as-is -- no assertSchoolOwnedKey. That is load-bearing for the export class, whose
 * finance-report keys use the `tenant-<schoolId>/reports/...` shape that predates the canonical
 * four-segment scheme and would fail the strict parser; the finance reports route (ST-119) signs
 * those same keys directly for the same reason.
 *
 * URLs are short-lived by design: DOWNLOAD_PRESIGN_TTL_SECONDS. Attendance and finance report
 * routes sign their own URLs with their own TTLs; this gateway keeps its promise short.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { getDownloadClass } from "./content-classes";

import type { DownloadClassKey } from "./content-classes";
import type { StorageService } from "../../lib/storage";
import type { TransactionSql } from "postgres";

/** How long a gateway download URL stays valid, in seconds. */
export const DOWNLOAD_PRESIGN_TTL_SECONDS = 5 * 60;

export interface ResolvedDownloadObject {
  storageKey: string;
  /** The table the object was resolved from; the audit target_table for audited classes. */
  targetTable: string;
}

type Resolver = (
  tx: TransactionSql,
  schoolId: string,
  objectId: string,
) => Promise<ResolvedDownloadObject | null>;

/**
 * Per-class object resolution. Each query filters on the caller's school and runs under the
 * caller's RLS context (withTenantTx sets role/school/user GUCs), so "row invisible to the caller"
 * and "row missing" are indistinguishable and both answer 404.
 *
 * The extra predicates are the classes' own gates on serving: materials only once malware-scanned
 * ready (000088), export jobs only once completed with a stored object.
 */
const RESOLVERS: Readonly<Record<DownloadClassKey, Resolver>> = {
  material: async (tx, schoolId, objectId) => {
    const [row] = await tx<{ storage_key: string }[]>`
      SELECT storage_key
      FROM app.materials
      WHERE id = ${objectId} AND school_id = ${schoolId} AND ingest_status = 'ready'
    `;
    return row ? { storageKey: row.storage_key, targetTable: "materials" } : null;
  },
  submission: async (tx, schoolId, objectId) => {
    const [row] = await tx<{ storage_key: string }[]>`
      SELECT storage_key
      FROM app.submission_attachments
      WHERE id = ${objectId} AND school_id = ${schoolId}
    `;
    return row ? { storageKey: row.storage_key, targetTable: "submission_attachments" } : null;
  },
  receipt: async (tx, schoolId, objectId) => {
    const [row] = await tx<{ storage_key: string }[]>`
      SELECT attachment_storage_key AS storage_key
      FROM app.expense_cache
      WHERE id = ${objectId} AND school_id = ${schoolId} AND attachment_storage_key IS NOT NULL
    `;
    return row ? { storageKey: row.storage_key, targetTable: "expense_cache" } : null;
  },
  // The one class spanning two tables: an attendance export job or a finance report job. Attendance
  // first, finance second; both are school-scoped and completed-only, so the only thing the caller
  // can learn from which one answers is which of the two jobs holds the id -- a distinction their
  // own report list routes already expose.
  export: async (tx, schoolId, objectId) => {
    const [attendance] = await tx<{ storage_key: string }[]>`
      SELECT storage_key
      FROM app.report_export_jobs
      WHERE id = ${objectId} AND school_id = ${schoolId}
        AND status::text = 'completed' AND storage_key IS NOT NULL
    `;
    if (attendance) {
      return { storageKey: attendance.storage_key, targetTable: "report_export_jobs" };
    }
    const [finance] = await tx<{ storage_key: string }[]>`
      SELECT object_key AS storage_key
      FROM app.finance_report_jobs
      WHERE id = ${objectId} AND school_id = ${schoolId}
        AND status::text = 'completed' AND object_key IS NOT NULL
    `;
    return finance ? { storageKey: finance.storage_key, targetTable: "finance_report_jobs" } : null;
  },
};

/**
 * Resolve a download-class object, or null when it does not exist or is invisible to the caller.
 *
 * Exported separately from requestDownload so tests can exercise the row-scope boundary without
 * going through presigning.
 */
export async function resolveDownloadObject(
  tx: TransactionSql,
  schoolId: string,
  classKey: DownloadClassKey,
  objectId: string,
): Promise<ResolvedDownloadObject | null> {
  // `classKey` is a closed DownloadClassKey union, never external input: the route validates it
  // against a zod enum and getDownloadClass 400s anything else, and RESOLVERS is an exhaustive
  // Record over that union.
  // eslint-disable-next-line security/detect-object-injection
  return RESOLVERS[classKey](tx, schoolId, objectId);
}

export interface DownloadResult {
  downloadUrl: string;
  expiresAt: Date;
  originalFileName: string;
}

/**
 * Mint a pre-signed GET URL for a download-class object, auditing the issuance for classes that
 * declare it.
 *
 * Must be called inside an open tenant transaction: resolution depends on RLS, and the audit row
 * (when written) is committed atomically with the caller's other work. A row that does not exist,
 * or exists but is invisible to the caller, answers 404 -- never 403, so the response cannot be
 * used to probe which ids exist in a class the caller cannot read.
 */
export async function requestDownload(
  tx: TransactionSql,
  storage: StorageService,
  schoolId: string,
  classKey: DownloadClassKey,
  objectId: string,
): Promise<DownloadResult> {
  const downloadClass = getDownloadClass(classKey);
  const resolved = await resolveDownloadObject(tx, schoolId, classKey, objectId);

  if (!resolved) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.RESOURCE_NOT_FOUND,
      "No downloadable object found for that content class and id",
    );
  }

  if (downloadClass.audit) {
    await emitAuditLog(tx, {
      action: "export",
      targetTable: resolved.targetTable,
      targetId: objectId,
      newValues: { content_class: classKey, storage_key: resolved.storageKey },
    });
  }

  const presigned = await storage.presign(
    resolved.storageKey,
    "GET",
    undefined,
    DOWNLOAD_PRESIGN_TTL_SECONDS,
  );

  return {
    downloadUrl: presigned.url,
    expiresAt: presigned.expiresAt,
    originalFileName: resolved.storageKey.split("/").at(-1) ?? "download",
  };
}
