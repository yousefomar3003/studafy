/**
 * Abandoned material sweep.
 *
 * Two kinds of material row never become available on their own and used to stay in a teacher's
 * class list forever:
 *
 *  - an upload that was never confirmed: still `uploaded` a day after it was started, because the
 *    file PUT or the confirm call failed and the app showed the teacher an error. Only an AI-visible
 *    row counts (every new upload is): a confirmed material whose AI use was turned off is also
 *    `uploaded`, with ai_visible off (toggleAiVisible in apps/api), and is a real material.
 *  - a `failed` material the teacher neither retried nor deleted within 14 days of the failure
 *    (updated_at is when it failed).
 *
 * Once a day, per school, those rows are deleted and their stored files freed the way the API's
 * delete does (apps/api/src/modules/storage/free-objects.ts): after the delete commits, a key no
 * other row still points at (app.referenced_storage_keys) is read for its size, removed, and only
 * the bytes actually removed are released from the school's meter. A failed material was counted at
 * confirm; an unconfirmed upload's object was not, but by the time it is a day old the daily
 * reconciliation has counted it, so releasing it is right too (and the next recount corrects any
 * gap either way). A bucket failure leaves the object for the orphan sweep; it never fails the run.
 *
 * Each deletion is logged with the material, its school, class, uploader, state and file, which is
 * the sweep's audit trail (app.audit_logs rows are written by request handlers, with an actor).
 */

import { withSystemTenantTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import type { Sql } from "postgres";

/** An unconfirmed upload older than this is abandoned. */
export const ABANDONED_UPLOAD_AGE_HOURS = 24;
/** A failed material left this long after it failed is removed. */
export const FAILED_MATERIAL_RETENTION_DAYS = 14;
/** Rows deleted per statement. */
export const ABANDONED_MATERIAL_BATCH_SIZE = 200;

const HOUR_MS = 60 * 60 * 1000;

export interface MaterialObjectStore {
  /** The stored size, or null when the object does not exist. */
  head(key: string): Promise<{ sizeBytes: number } | null>;
  remove(key: string): Promise<void>;
}

export interface MaterialSweepLogger {
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
}

export interface PurgeAbandonedMaterialsResult {
  schools: number;
  /** Unconfirmed uploads deleted. */
  abandonedUploads: number;
  /** Failed materials deleted. */
  failedMaterials: number;
  /** Stored objects removed, and their bytes. */
  objectsRemoved: number;
  bytesFreed: number;
  /** Schools whose sweep aborted on a database error; the sweep moves on to the next. */
  failed: number;
}

interface DeletedMaterial {
  id: string;
  class_id: string;
  uploaded_by_user_id: string;
  ingest_status: "uploaded" | "failed";
  ingest_error: string | null;
  original_file_name: string;
  storage_key: string;
  thumbnail_key: string | null;
  preview_key: string | null;
  created_at: Date;
  updated_at: Date;
}

const silentLogger: MaterialSweepLogger = { info: () => undefined, warn: () => undefined };

export async function purgeAbandonedMaterials(
  sql: Sql,
  storage: MaterialObjectStore | null,
  now: Date = new Date(),
  log: MaterialSweepLogger = silentLogger,
): Promise<PurgeAbandonedMaterialsResult> {
  const uploadCutoff = new Date(now.getTime() - ABANDONED_UPLOAD_AGE_HOURS * HOUR_MS);
  const failedCutoff = new Date(now.getTime() - FAILED_MATERIAL_RETENTION_DAYS * 24 * HOUR_MS);
  const schoolIds = await loadSchoolIds(sql);
  const result: PurgeAbandonedMaterialsResult = {
    schools: schoolIds.length,
    abandonedUploads: 0,
    failedMaterials: 0,
    objectsRemoved: 0,
    bytesFreed: 0,
    failed: 0,
  };

  for (const schoolId of schoolIds) {
    try {
      let deleted: DeletedMaterial[];
      do {
        deleted = await withSystemTenantTx(
          sql,
          { schoolId },
          (tx) => tx<DeletedMaterial[]>`
            WITH batch AS (
              SELECT id
              FROM app.materials
              WHERE school_id = ${schoolId}::uuid
                AND (
                  (ingest_status = 'uploaded'::app.material_ingest_status
                    AND ai_visible
                    AND created_at < ${uploadCutoff})
                  OR (ingest_status = 'failed'::app.material_ingest_status
                    AND updated_at < ${failedCutoff})
                )
              ORDER BY created_at, id
              LIMIT ${ABANDONED_MATERIAL_BATCH_SIZE}
              FOR UPDATE SKIP LOCKED
            )
            DELETE FROM app.materials AS m
            USING batch
            WHERE m.id = batch.id AND m.school_id = ${schoolId}::uuid
            RETURNING m.id, m.class_id, m.uploaded_by_user_id,
                      m.ingest_status::text AS ingest_status, m.ingest_error,
                      m.original_file_name, m.storage_key, m.thumbnail_key, m.preview_key,
                      m.created_at, m.updated_at
          `,
        );

        for (const row of deleted) {
          if (row.ingest_status === "uploaded") result.abandonedUploads += 1;
          else result.failedMaterials += 1;
          log.info(
            {
              event: "material_swept",
              school_id: schoolId,
              material_id: row.id,
              class_id: row.class_id,
              uploaded_by_user_id: row.uploaded_by_user_id,
              ingest_status: row.ingest_status,
              ingest_error: row.ingest_error,
              original_file_name: row.original_file_name,
              storage_key: row.storage_key,
              created_at: row.created_at.toISOString(),
              updated_at: row.updated_at.toISOString(),
            },
            row.ingest_status === "uploaded"
              ? "deleted a material upload that was never confirmed"
              : "deleted a failed material nobody retried",
          );
        }

        const freed = await freeObjects(sql, storage, schoolId, deleted);
        result.objectsRemoved += freed.objects;
        result.bytesFreed += freed.bytes;
      } while (deleted.length === ABANDONED_MATERIAL_BATCH_SIZE);
    } catch (error) {
      result.failed += 1;
      log.warn(
        { school_id: schoolId, error },
        "abandoned material sweep failed for school; batch rolled back and school skipped",
      );
    }
  }

  return result;
}

/**
 * Remove the deleted rows' objects and release what was removed. Runs after the delete committed,
 * so a failure here can only leave an unreferenced object, never a row pointing at a missing file.
 */
async function freeObjects(
  sql: Sql,
  storage: MaterialObjectStore | null,
  schoolId: string,
  deleted: readonly DeletedMaterial[],
): Promise<{ objects: number; bytes: number }> {
  if (!storage || deleted.length === 0) return { objects: 0, bytes: 0 };
  const prefix = `permanent/${schoolId}/`;
  const candidates = [
    ...new Set(deleted.flatMap((row) => [row.storage_key, row.thumbnail_key, row.preview_key])),
  ].filter((key): key is string => typeof key === "string" && key.startsWith(prefix));
  if (candidates.length === 0) return { objects: 0, bytes: 0 };

  let unreferenced: string[];
  try {
    const live = await withSystemTenantTx(
      sql,
      { schoolId },
      (tx) => tx<{ key: string }[]>`
        SELECT app.referenced_storage_keys(${candidates}::text[]) AS key
      `,
    );
    const kept = new Set(live.map((row) => row.key));
    unreferenced = candidates.filter((key) => !kept.has(key));
  } catch {
    // Without the check nothing is removed; the orphan sweep reports what is left.
    return { objects: 0, bytes: 0 };
  }

  let objects = 0;
  let bytes = 0;
  for (const key of unreferenced) {
    try {
      const stored = await storage.head(key);
      if (!stored) continue;
      await storage.remove(key);
      objects += 1;
      bytes += stored.sizeBytes;
    } catch {
      // Left in the bucket: still counted by reconciliation, reported by the orphan sweep.
    }
  }

  if (bytes > 0) {
    try {
      await withSystemTenantTx(
        sql,
        { schoolId },
        (tx) => tx`SELECT app.add_storage_usage(${-bytes})`,
      );
    } catch {
      // The objects are gone; the next reconciliation brings the meter down to match.
    }
  }
  return { objects, bytes };
}
