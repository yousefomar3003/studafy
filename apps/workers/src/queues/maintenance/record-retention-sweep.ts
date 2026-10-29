/**
 * Sensitive record retention sweep (docs/modules/student-records.md "Retention").
 *
 * A sensitive answer (a national ID, a medical note, a passport scan) is kept only while the school
 * has a use for it: the field's retention period in months -- the school's own, or
 * DEFAULT_SENSITIVE_RETENTION_MONTHS -- counted from when the student left (app.students.left_at,
 * maintained by 000169's trigger) or, for a parent, from when the last of their linked children
 * left. A parent with no linked child at all is never swept: staff may still be about to link them.
 * The period is read from the field's latest published version, so a school that shortens it
 * shortens it for existing answers too.
 *
 * Once a day, per school, in batches: the answers are deleted (their documents cascade), each
 * deletion is audited by field id and never by value, and the stored files are deleted after the
 * batch commits.
 */
import { DEFAULT_SENSITIVE_RETENTION_MONTHS } from "@studafy/records";

import { emitAuditLogs } from "../../db/audit";
import { withSystemTenantTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import type { PurgeLogger } from "../imports";
import type { Sql } from "postgres";

export const RECORD_RETENTION_BATCH_SIZE = 500;

export interface PurgeExpiredSensitiveRecordsResult {
  schools: number;
  /** Sensitive answers deleted across every school. */
  removed: number;
  /** Schools whose sweep aborted (database error). The sweep continues with the next school. */
  failed: number;
}

export interface RecordObjectRemover {
  remove(key: string): Promise<void>;
}

const silentLogger: PurgeLogger = { warn: () => undefined };

async function sweepBatch(
  sql: Sql,
  schoolId: string,
  now: Date,
): Promise<{ deleted: number; storageKeys: string[] }> {
  return withSystemTenantTx(sql, { schoolId }, async (tx) => {
    const due = await tx<
      { id: string; field_id: string; subject_kind: string; storage_key: string | null }[]
    >`
      WITH latest AS (
        SELECT DISTINCT ON (fv.field_id) fv.field_id, fv.sensitivity, fv.retention_months
        FROM app.record_field_versions AS fv
        JOIN app.record_template_versions AS tv
          ON tv.id = fv.template_version_id AND tv.school_id = fv.school_id
        WHERE fv.school_id = ${schoolId}::uuid
        ORDER BY fv.field_id, tv.version DESC
      ),
      parent_left AS (
        SELECT link.parent_user_id,
               bool_and(child.left_at IS NOT NULL) AS all_left,
               max(child.left_at) AS last_left_at
        FROM app.parent_child_links AS link
        JOIN app.students AS child ON child.id = link.student_id AND child.school_id = link.school_id
        WHERE link.school_id = ${schoolId}::uuid
        GROUP BY link.parent_user_id
      )
      SELECT a.id, a.field_id, a.subject_kind::text, d.storage_key
      FROM app.record_answers AS a
      JOIN latest AS f ON f.field_id = a.field_id
      LEFT JOIN app.record_documents AS d ON d.answer_id = a.id AND d.school_id = a.school_id
      LEFT JOIN app.students AS s ON s.id = a.student_id AND s.school_id = a.school_id
      LEFT JOIN parent_left AS p ON p.parent_user_id = a.parent_user_id
      WHERE a.school_id = ${schoolId}::uuid
        AND (f.sensitivity = 'sensitive' OR a.value_ciphertext IS NOT NULL OR d.sensitive)
        AND coalesce(s.left_at, CASE WHEN p.all_left THEN p.last_left_at END)
            + make_interval(months => coalesce(f.retention_months, ${DEFAULT_SENSITIVE_RETENTION_MONTHS}::int))
            <= ${now}
      ORDER BY a.id
      LIMIT ${RECORD_RETENTION_BATCH_SIZE}
    `;
    if (due.length === 0) return { deleted: 0, storageKeys: [] };

    await tx`
      DELETE FROM app.record_answers
      WHERE school_id = ${schoolId}::uuid AND id = ANY(${due.map((row) => row.id)}::uuid[])
    `;
    await emitAuditLogs(
      tx,
      due.map((row) => ({
        action: "delete" as const,
        targetTable: "record_answers",
        targetId: row.id,
        oldValues: {
          field_id: row.field_id,
          subject_kind: row.subject_kind,
          sensitive: true,
          reason: "retention",
        },
        newValues: null,
      })),
    );
    return {
      deleted: due.length,
      storageKeys: due.flatMap((row) => (row.storage_key ? [row.storage_key] : [])),
    };
  });
}

export async function purgeExpiredSensitiveRecords(
  sql: Sql,
  storage: RecordObjectRemover | null,
  now: Date = new Date(),
  log: PurgeLogger = silentLogger,
): Promise<PurgeExpiredSensitiveRecordsResult> {
  const schoolIds = await loadSchoolIds(sql);
  const result: PurgeExpiredSensitiveRecordsResult = {
    schools: schoolIds.length,
    removed: 0,
    failed: 0,
  };
  for (const schoolId of schoolIds) {
    try {
      let batch: { deleted: number; storageKeys: string[] };
      do {
        batch = await sweepBatch(sql, schoolId, now);
        result.removed += batch.deleted;
        for (const key of batch.storageKeys) {
          try {
            await storage?.remove(key);
          } catch {
            // Unreferenced now; storage-quota reconciliation reports the stray object.
          }
        }
      } while (batch.deleted === RECORD_RETENTION_BATCH_SIZE);
    } catch (error) {
      result.failed += 1;
      log.warn(
        { school_id: schoolId, error },
        "sensitive record retention sweep failed for school; batch rolled back and school skipped",
      );
    }
  }
  return result;
}
