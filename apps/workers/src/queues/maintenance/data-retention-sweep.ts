/**
 * Data retention sweep (docs/modules/data-retention.md).
 *
 * Deletes data whose fixed retention period has passed, once a day:
 *
 *   - app.security_events: boundary rejections, 12 months after they were recorded. Global, no
 *     tenant; no append-only trigger -- DELETE by studafy_admin is the intended retention mechanism
 *     (000028).
 *   - app.sales_inquiries: "Talk to us" requests, 12 months after they arrived. Global (000125).
 *   - app.school_applications: rejected sign-up applications, 12 months after the rejection, with
 *     their proof-of-ownership file. Global (000139). Pending applications are undecided and an
 *     approved one is the record of the school's acceptance, so neither is ever deleted.
 *   - app.notifications: in-app inbox rows, read or unread, 12 months after they were created. Per
 *     school. 000188 turned the dispatch/announcement/alert logs' links into ON DELETE SET NULL, so
 *     the logs stay and only their pointer to the inbox row is cleared.
 *   - Data subject request export bundles (dsr-exports/<school>/<request>/...), 30 days after the
 *     request finished. Per school. The app.data_subject_requests row is the compliance record and
 *     stays; its storage_key cannot be cleared (ck_data_subject_requests_terminal_state), so
 *     export_deleted_at (000188) records that the objects are gone.
 *
 * Rows are deleted in batches of DATA_RETENTION_BATCH_SIZE, one transaction per batch, until a
 * batch comes back short, so a backlog never holds locks for long. A failure in one category or one
 * school is logged and counted and the sweep moves on. Stored files are deleted only after the
 * transaction that deleted their row committed; an export bundle is marked deleted only after every
 * one of its objects was.
 */

import { withSystemTenantTx, withSystemTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import type { Sql } from "postgres";

export const SECURITY_EVENT_RETENTION_MONTHS = 12;
export const SALES_INQUIRY_RETENTION_MONTHS = 12;
export const REJECTED_SCHOOL_APPLICATION_RETENTION_MONTHS = 12;
export const NOTIFICATION_RETENTION_MONTHS = 12;
export const DSR_EXPORT_RETENTION_DAYS = 30;

/** Rows per DELETE statement. */
export const DATA_RETENTION_BATCH_SIZE = 1000;
/** Export requests per batch; each one is a storage listing plus its deletes. */
const DSR_EXPORT_BATCH_SIZE = 100;

export type RetainedDataCategory =
  | "securityEvents"
  | "salesInquiries"
  | "rejectedSchoolApplications"
  | "notifications"
  | "dsrExports";

export interface DataRetentionRule {
  category: RetainedDataCategory;
  /** What is deleted. */
  data: string;
  /** The timestamp the period is counted from. */
  from: string;
  months?: number;
  days?: number;
  scope: "global" | "per-school";
}

/** Every period this sweep enforces, in one place. The SQL below reads its periods from here. */
export const DATA_RETENTION_RULES = [
  {
    category: "securityEvents",
    data: "app.security_events rows",
    from: "created_at",
    months: SECURITY_EVENT_RETENTION_MONTHS,
    scope: "global",
  },
  {
    category: "salesInquiries",
    data: "app.sales_inquiries rows",
    from: "created_at",
    months: SALES_INQUIRY_RETENTION_MONTHS,
    scope: "global",
  },
  {
    category: "rejectedSchoolApplications",
    data: "rejected app.school_applications rows and their proof file",
    from: "reviewed_at",
    months: REJECTED_SCHOOL_APPLICATION_RETENTION_MONTHS,
    scope: "global",
  },
  {
    category: "notifications",
    data: "app.notifications rows, read or unread",
    from: "created_at",
    months: NOTIFICATION_RETENTION_MONTHS,
    scope: "per-school",
  },
  {
    category: "dsrExports",
    data: "stored export bundles of app.data_subject_requests (the row is kept)",
    from: "completed_at",
    days: DSR_EXPORT_RETENTION_DAYS,
    scope: "per-school",
  },
] as const satisfies readonly DataRetentionRule[];

/** The storage operations the sweep needs: list an export's objects, delete an object. */
export interface RetentionObjectStore {
  list(prefix: string): AsyncIterable<{ key: string }>;
  remove(key: string): Promise<void>;
}

export interface DataRetentionLogger {
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
}

export interface DataRetentionSweepResult {
  schools: number;
  securityEvents: number;
  salesInquiries: number;
  rejectedSchoolApplications: number;
  notifications: number;
  /** Export requests whose stored bundle was deleted. */
  dsrExports: number;
  /** Objects deleted from storage: application proofs and export bundle files. */
  objectsRemoved: number;
  /** Objects whose deletion failed. An export is retried the next day; a proof is left orphaned. */
  objectsFailed: number;
  /** Categories (global) or schools (per-school) whose step failed; each is logged. */
  failed: number;
}

const silentLogger: DataRetentionLogger = { info: () => undefined, warn: () => undefined };

function rule(category: RetainedDataCategory): DataRetentionRule {
  return DATA_RETENTION_RULES.find((entry) => entry.category === category)!;
}

/** The instant before which data in [category] has expired. */
export function retentionCutoff(category: RetainedDataCategory, now: Date): Date {
  const { months = 0, days = 0 } = rule(category);
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return cutoff;
}

/** Counts committed deletions as they happen, so a later failing batch does not hide them. */
type Counter = (deleted: number) => void;

/** Runs [deleteBatch] until it deletes fewer than a full batch, counting each committed batch. */
async function drain(deleteBatch: () => Promise<number>, counted: Counter): Promise<void> {
  let deleted: number;
  do {
    deleted = await deleteBatch();
    counted(deleted);
  } while (deleted === DATA_RETENTION_BATCH_SIZE);
}

function purgeSecurityEvents(sql: Sql, now: Date, counted: Counter): Promise<void> {
  const cutoff = retentionCutoff("securityEvents", now);
  return drain(
    () =>
      withSystemTx(sql, async (tx) => {
        const result = await tx`
        DELETE FROM app.security_events
        WHERE id IN (
          SELECT id FROM app.security_events
          WHERE created_at < ${cutoff}
          LIMIT ${DATA_RETENTION_BATCH_SIZE}
        )
      `;
        return result.count;
      }),
    counted,
  );
}

function purgeSalesInquiries(sql: Sql, now: Date, counted: Counter): Promise<void> {
  const cutoff = retentionCutoff("salesInquiries", now);
  return drain(
    () =>
      withSystemTx(sql, async (tx) => {
        const result = await tx`
        DELETE FROM app.sales_inquiries
        WHERE id IN (
          SELECT id FROM app.sales_inquiries
          WHERE created_at < ${cutoff}
          LIMIT ${DATA_RETENTION_BATCH_SIZE}
        )
      `;
        return result.count;
      }),
    counted,
  );
}

async function purgeRejectedSchoolApplications(
  sql: Sql,
  storage: RetentionObjectStore,
  now: Date,
  result: DataRetentionSweepResult,
): Promise<void> {
  const cutoff = retentionCutoff("rejectedSchoolApplications", now);
  return drain(
    async () => {
      const { deleted, proofKeys } = await withSystemTx(sql, async (tx) => {
        const rows = await tx<{ proof_storage_key: string }[]>`
        DELETE FROM app.school_applications
        WHERE id IN (
          SELECT id FROM app.school_applications
          WHERE status = 'rejected' AND reviewed_at < ${cutoff}
          LIMIT ${DATA_RETENTION_BATCH_SIZE}
        )
        RETURNING proof_storage_key
      `;
        const keys = [...new Set(rows.map((row) => row.proof_storage_key))];
        // A proof is copied to a fresh key per submission, but a staged upload resubmitted within its
        // 24 hours would share one: never delete a file another application still points at.
        const shared =
          keys.length === 0
            ? []
            : await tx<{ proof_storage_key: string }[]>`
              SELECT DISTINCT proof_storage_key FROM app.school_applications
              WHERE proof_storage_key = ANY(${keys}::text[])
            `;
        const stillReferenced = new Set(shared.map((row) => row.proof_storage_key));
        return { deleted: rows.length, proofKeys: keys.filter((key) => !stillReferenced.has(key)) };
      });
      for (const key of proofKeys) {
        try {
          await storage.remove(key);
          result.objectsRemoved += 1;
        } catch {
          result.objectsFailed += 1;
        }
      }
      return deleted;
    },
    (deleted) => (result.rejectedSchoolApplications += deleted),
  );
}

function purgeSchoolNotifications(
  sql: Sql,
  schoolId: string,
  now: Date,
  counted: Counter,
): Promise<void> {
  const cutoff = retentionCutoff("notifications", now);
  return drain(
    () =>
      withSystemTenantTx(sql, { schoolId }, async (tx) => {
        const deleted = await tx`
        DELETE FROM app.notifications
        WHERE school_id = ${schoolId}::uuid
          AND id IN (
            SELECT id FROM app.notifications
            WHERE school_id = ${schoolId}::uuid AND created_at < ${cutoff}
            LIMIT ${DATA_RETENTION_BATCH_SIZE}
          )
      `;
        return deleted.count;
      }),
    counted,
  );
}

/** Must match tenantExportPrefix (tenant-export.worker.ts); the trailing slash keeps one request's
 * listing from matching another request id that starts with the same characters. */
function exportBundlePrefix(schoolId: string, requestId: string): string {
  return `dsr-exports/${schoolId}/${requestId}/`;
}

async function purgeSchoolExportBundles(
  sql: Sql,
  storage: RetentionObjectStore,
  schoolId: string,
  now: Date,
  result: DataRetentionSweepResult,
): Promise<void> {
  const cutoff = retentionCutoff("dsrExports", now);
  // Requests whose objects could not all be deleted stay unmarked; skip them for the rest of this
  // run so a stuck one cannot stall the loop, and retry them tomorrow.
  const skipped: string[] = [];
  for (;;) {
    const due = await withSystemTenantTx(
      sql,
      { schoolId },
      (tx) =>
        tx<{ id: string }[]>`
        SELECT id FROM app.data_subject_requests
        WHERE school_id = ${schoolId}::uuid
          AND request_type = 'export'
          AND status IN ('completed', 'failed')
          AND export_deleted_at IS NULL
          AND completed_at < ${cutoff}
          AND NOT (id = ANY(${skipped}::uuid[]))
        ORDER BY completed_at
        LIMIT ${DSR_EXPORT_BATCH_SIZE}
      `,
    );
    for (const { id } of due) {
      let complete = true;
      for await (const object of storage.list(exportBundlePrefix(schoolId, id))) {
        try {
          await storage.remove(object.key);
          result.objectsRemoved += 1;
        } catch {
          result.objectsFailed += 1;
          complete = false;
        }
      }
      if (!complete) {
        skipped.push(id);
        continue;
      }
      await withSystemTenantTx(
        sql,
        { schoolId },
        (tx) =>
          tx`
          UPDATE app.data_subject_requests
             SET export_deleted_at = greatest(${now}::timestamptz, completed_at),
                 updated_at = greatest(${now}::timestamptz, updated_at)
           WHERE school_id = ${schoolId}::uuid AND id = ${id}::uuid AND export_deleted_at IS NULL
        `,
      );
      result.dsrExports += 1;
    }
    if (due.length < DSR_EXPORT_BATCH_SIZE) return;
  }
}

/**
 * Runs every rule in DATA_RETENTION_RULES once. [storage] null (no bucket configured) skips the two
 * categories that own stored files rather than deleting rows and orphaning their files.
 */
export async function purgeExpiredRetainedData(
  sql: Sql,
  storage: RetentionObjectStore | null,
  now: Date = new Date(),
  log: DataRetentionLogger = silentLogger,
): Promise<DataRetentionSweepResult> {
  const result: DataRetentionSweepResult = {
    schools: 0,
    securityEvents: 0,
    salesInquiries: 0,
    rejectedSchoolApplications: 0,
    notifications: 0,
    dsrExports: 0,
    objectsRemoved: 0,
    objectsFailed: 0,
    failed: 0,
  };

  const globalSteps: [RetainedDataCategory, () => Promise<void>][] = [
    [
      "securityEvents",
      () => purgeSecurityEvents(sql, now, (deleted) => (result.securityEvents += deleted)),
    ],
    [
      "salesInquiries",
      () => purgeSalesInquiries(sql, now, (deleted) => (result.salesInquiries += deleted)),
    ],
  ];
  if (storage) {
    globalSteps.push([
      "rejectedSchoolApplications",
      () => purgeRejectedSchoolApplications(sql, storage, now, result),
    ]);
  } else {
    log.warn(
      {},
      "data retention: object storage is not configured; rejected applications and export bundles skipped",
    );
  }
  for (const [category, step] of globalSteps) {
    try {
      await step();
    } catch (error) {
      result.failed += 1;
      log.warn({ category, error }, "data retention purge failed; batch rolled back, continuing");
    }
  }

  const schoolIds = await loadSchoolIds(sql);
  result.schools = schoolIds.length;
  for (const schoolId of schoolIds) {
    try {
      await purgeSchoolNotifications(sql, schoolId, now, (deleted) => {
        result.notifications += deleted;
      });
      if (storage) await purgeSchoolExportBundles(sql, storage, schoolId, now, result);
    } catch (error) {
      result.failed += 1;
      log.warn(
        { school_id: schoolId, error },
        "data retention purge failed for school; batch rolled back and school skipped",
      );
    }
  }

  if (result.objectsFailed > 0) {
    log.warn(
      { objects_failed: result.objectsFailed },
      "data retention: some stored objects could not be deleted",
    );
  }
  log.info(
    {
      security_events: result.securityEvents,
      sales_inquiries: result.salesInquiries,
      rejected_school_applications: result.rejectedSchoolApplications,
      notifications: result.notifications,
      dsr_exports: result.dsrExports,
      objects_removed: result.objectsRemoved,
      objects_failed: result.objectsFailed,
      schools: result.schools,
      failed: result.failed,
    },
    "data retention sweep finished",
  );
  return result;
}
