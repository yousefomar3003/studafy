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
 *   - app.email_events: the email provider's bounce/complaint/delivery webhook ledger, 12 months after
 *     it arrived. Global. The suppression list derived from it (app.email_suppressions) is kept.
 *   - app.notifications: in-app inbox rows, read or unread, 12 months after they were created. Per
 *     school. 000189 turned the dispatch/announcement/alert logs' links into ON DELETE SET NULL, so
 *     the logs stay and only their pointer to the inbox row is cleared.
 *   - The notification ledgers, 12 months after they were written, the same period as the inbox
 *     rows they describe. Per school: app.notification_dispatch_logs (created_at),
 *     app.notification_idempotency_keys (reserved_at), app.notification_dead_letters (failed_at),
 *     app.attendance_alert_logs (sent_at).
 *   - app.outbox_events: a domain event every consumer has finished with, 14 days after it was
 *     written. Per school. See isFinishedOutboxEvent below; an unfinished event is never deleted.
 *   - app.email_deliveries: one row per email sent, 12 months after it was written, once its outbox
 *     event is gone. Per school.
 *   - app.refresh_tokens: a sign-in session (one token family) 90 days after the last of its tokens
 *     expired. Per school.
 *   - Data subject request export bundles (dsr-exports/<school>/<request>/...), 30 days after the
 *     request finished. Per school. The app.data_subject_requests row is the compliance record and
 *     stays; its storage_key cannot be cleared (ck_data_subject_requests_terminal_state), so
 *     export_deleted_at (000189) records that the objects are gone.
 *
 * Rows are deleted in batches of DATA_RETENTION_BATCH_SIZE, one transaction per batch, until a
 * batch comes back short, so a backlog never holds locks for long. Every batch is a range scan of a
 * school-leading index (000201 added the ones that were missing). A failure in one category, or in
 * one category for one school, is logged and counted and the sweep moves on. Stored files are
 * deleted only after the transaction that deleted their row committed; an export bundle is marked
 * deleted only after every one of its objects was.
 *
 * app.erpnext_webhook_dedup is deliberately not swept: ERPNext's webhook signature covers the body
 * only, with no timestamp, so that table is the only thing that stops a captured webhook from being
 * replayed. Partitioned audit-log and attendance tables are not swept either; dropping their
 * partitions is a compliance decision (docs/database/audit-log-partition-maintenance.md).
 */

import { withSystemTenantTx, withSystemTx } from "../../db/tenant-tx";
import { ENTITLEMENT_EVENT_NAMES, USER_ENTITLEMENT_EVENT_NAME } from "../entitlements/claim";
import { DIGEST_SOURCE_EVENTS } from "../notifications/email/digest-producer";
import { EMAIL_EVENT_NAMES } from "../notifications/email/resolve";
import { loadSchoolIds } from "../notifications/email/schools";

import type { Sql, TransactionSql } from "postgres";

export const SECURITY_EVENT_RETENTION_MONTHS = 12;
export const SALES_INQUIRY_RETENTION_MONTHS = 12;
export const REJECTED_SCHOOL_APPLICATION_RETENTION_MONTHS = 12;
export const NOTIFICATION_RETENTION_MONTHS = 12;
export const DSR_EXPORT_RETENTION_DAYS = 30;
export const EMAIL_RECORD_RETENTION_MONTHS = 12;
export const NOTIFICATION_LOG_RETENTION_MONTHS = 12;
export const FINISHED_OUTBOX_EVENT_RETENTION_DAYS = 14;
export const EXPIRED_SESSION_RETENTION_DAYS = 90;

/** Rows per DELETE statement. */
export const DATA_RETENTION_BATCH_SIZE = 1000;
/** Export requests per batch; each one is a storage listing plus its deletes. */
const DSR_EXPORT_BATCH_SIZE = 100;
/** Sign-in sessions (token families) per batch; a family is deleted whole, whatever its size. */
export const SESSION_FAMILY_BATCH_SIZE = 200;

export type RetainedDataCategory =
  | "securityEvents"
  | "salesInquiries"
  | "rejectedSchoolApplications"
  | "notifications"
  | "dsrExports"
  | "emailEvents"
  | "emailDeliveries"
  | "notificationDispatchLogs"
  | "notificationIdempotencyKeys"
  | "notificationDeadLetters"
  | "attendanceAlertLogs"
  | "outboxEvents"
  | "expiredSessions";

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
  {
    category: "emailEvents",
    data: "app.email_events rows (the suppression list derived from them is kept)",
    from: "received_at",
    months: EMAIL_RECORD_RETENTION_MONTHS,
    scope: "global",
  },
  {
    category: "emailDeliveries",
    data: "app.email_deliveries rows past 'claimed' whose outbox event is gone",
    from: "created_at",
    months: EMAIL_RECORD_RETENTION_MONTHS,
    scope: "per-school",
  },
  {
    category: "notificationDispatchLogs",
    data: "app.notification_dispatch_logs rows, with their rendered title and body",
    from: "created_at",
    months: NOTIFICATION_LOG_RETENTION_MONTHS,
    scope: "per-school",
  },
  {
    category: "notificationIdempotencyKeys",
    data: "app.notification_idempotency_keys rows",
    from: "reserved_at",
    months: NOTIFICATION_LOG_RETENTION_MONTHS,
    scope: "per-school",
  },
  {
    category: "notificationDeadLetters",
    data: "app.notification_dead_letters rows, replayed or not",
    from: "failed_at",
    months: NOTIFICATION_LOG_RETENTION_MONTHS,
    scope: "per-school",
  },
  {
    category: "attendanceAlertLogs",
    data: "app.attendance_alert_logs rows",
    from: "sent_at",
    months: NOTIFICATION_LOG_RETENTION_MONTHS,
    scope: "per-school",
  },
  {
    category: "outboxEvents",
    data: "app.outbox_events rows every consumer has finished with",
    from: "created_at",
    days: FINISHED_OUTBOX_EVENT_RETENTION_DAYS,
    scope: "per-school",
  },
  {
    category: "expiredSessions",
    data: "app.refresh_tokens rows, a whole token family at a time",
    from: "the family's latest expires_at",
    days: EXPIRED_SESSION_RETENTION_DAYS,
    scope: "per-school",
  },
] as const satisfies readonly DataRetentionRule[];

/**
 * Which outbox events each consumer claims, and so which cursor column must be set before the event
 * is finished. Read from the consumers' own lists, so a consumer that starts claiming a new event
 * name protects it here too:
 *
 *   relayed_at              every event (outbox-relay/claim.ts)
 *   email_dispatched_at     EMAIL_EVENT_NAMES (email/claim.ts) and DIGEST_SOURCE_EVENTS
 *                           (email/digest-producer.ts)
 *   entitlement_applied_at  ENTITLEMENT_EVENT_NAMES and USER_ENTITLEMENT_EVENT_NAME
 *                           (entitlements/claim.ts)
 *
 * A column a consumer does not claim the event for stays NULL forever, so "finished" is: relayed,
 * and email-dispatched if an email consumer claims it, and entitlement-applied if the entitlement
 * consumer claims it. Nothing else reads an outbox row.
 */
export const OUTBOX_EMAIL_EVENT_NAMES: readonly string[] = [
  ...new Set([...EMAIL_EVENT_NAMES, ...DIGEST_SOURCE_EVENTS]),
];
export const OUTBOX_ENTITLEMENT_EVENT_NAMES: readonly string[] = [
  ...ENTITLEMENT_EVENT_NAMES,
  USER_ENTITLEMENT_EVENT_NAME,
];

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
  emailEvents: number;
  emailDeliveries: number;
  notificationDispatchLogs: number;
  notificationIdempotencyKeys: number;
  notificationDeadLetters: number;
  attendanceAlertLogs: number;
  outboxEvents: number;
  /** app.refresh_tokens rows deleted (a session is one family of them). */
  expiredSessions: number;
  /** Objects deleted from storage: application proofs and export bundle files. */
  objectsRemoved: number;
  /** Objects whose deletion failed. An export is retried the next day; a proof is left orphaned. */
  objectsFailed: number;
  /** Global categories, and (school, category) pairs, whose step failed; each is logged. */
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

function purgeEmailEvents(sql: Sql, now: Date, counted: Counter): Promise<void> {
  const cutoff = retentionCutoff("emailEvents", now);
  return drain(
    () =>
      withSystemTx(sql, async (tx) => {
        // idx_email_events_received_at (000201).
        const result = await tx`
        DELETE FROM app.email_events
        WHERE id IN (
          SELECT id FROM app.email_events
          WHERE received_at < ${cutoff}
          LIMIT ${DATA_RETENTION_BATCH_SIZE}
        )
      `;
        return result.count;
      }),
    counted,
  );
}

/** One batch of one per-school category: deletes up to a batch, returns how many it deleted. */
type SchoolBatch = (tx: TransactionSql, schoolId: string, cutoff: Date) => Promise<number>;

/**
 * Finished outbox events (see OUTBOX_EMAIL_EVENT_NAMES). SKIP LOCKED leaves any row a consumer holds
 * at that moment for tomorrow; a finished row is never claimed, so it only matters if a consumer's
 * list ever runs ahead of the one imported here. idx_outbox_events_school_created (000201).
 */
const outboxEventBatch: SchoolBatch = async (tx, schoolId, cutoff) => {
  const result = await tx`
    DELETE FROM app.outbox_events
    WHERE school_id = ${schoolId}::uuid
      AND id IN (
        SELECT id FROM app.outbox_events
        WHERE school_id = ${schoolId}::uuid
          AND created_at < ${cutoff}
          AND relayed_at IS NOT NULL
          AND (email_dispatched_at IS NOT NULL
               OR NOT (event_name = ANY(${OUTBOX_EMAIL_EVENT_NAMES as string[]}::text[])))
          AND (entitlement_applied_at IS NOT NULL
               OR NOT (event_name = ANY(${OUTBOX_ENTITLEMENT_EVENT_NAMES as string[]}::text[])))
        LIMIT ${DATA_RETENTION_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
  `;
  return result.count;
};

/**
 * Email deliveries. A delivery row is the dispatcher's dedup arbiter for (outbox event, recipient),
 * so one is deleted only once that event is gone -- deleted by outboxEventBatch, which waits until
 * every consumer finished -- and the row itself has left 'claimed' (a send still in progress or
 * waiting to be retried). idx_email_deliveries_school_created (000077); the outbox probe is its
 * primary key.
 */
const emailDeliveryBatch: SchoolBatch = async (tx, schoolId, cutoff) => {
  const result = await tx`
    DELETE FROM app.email_deliveries
    WHERE school_id = ${schoolId}::uuid
      AND id IN (
        SELECT delivery.id FROM app.email_deliveries AS delivery
        WHERE delivery.school_id = ${schoolId}::uuid
          AND delivery.created_at < ${cutoff}
          AND delivery.status <> 'claimed'
          AND NOT EXISTS (
            SELECT 1 FROM app.outbox_events AS event WHERE event.id = delivery.outbox_event_id
          )
        LIMIT ${DATA_RETENTION_BATCH_SIZE}
      )
  `;
  return result.count;
};

/** idx_notification_dispatch_logs_school_created (000201). */
const dispatchLogBatch: SchoolBatch = async (tx, schoolId, cutoff) => {
  const result = await tx`
    DELETE FROM app.notification_dispatch_logs
    WHERE school_id = ${schoolId}::uuid
      AND id IN (
        SELECT id FROM app.notification_dispatch_logs
        WHERE school_id = ${schoolId}::uuid AND created_at < ${cutoff}
        LIMIT ${DATA_RETENTION_BATCH_SIZE}
      )
  `;
  return result.count;
};

/**
 * A key guards one (event, recipient, channel) against a second send while the event can still be
 * dispatched again: a BullMQ retry (minutes) or a replay of its dead letter, which this sweep deletes
 * on the same 12-month schedule. Past that nothing re-dispatches the event.
 * idx_notification_idempotency_keys_school_reserved (000201).
 */
const idempotencyKeyBatch: SchoolBatch = async (tx, schoolId, cutoff) => {
  const result = await tx`
    DELETE FROM app.notification_idempotency_keys
    WHERE school_id = ${schoolId}::uuid
      AND id IN (
        SELECT id FROM app.notification_idempotency_keys
        WHERE school_id = ${schoolId}::uuid AND reserved_at < ${cutoff}
        LIMIT ${DATA_RETENTION_BATCH_SIZE}
      )
  `;
  return result.count;
};

/** One row per failed job: small. Read through uq_notification_dead_letters_job's school_id. */
const deadLetterBatch: SchoolBatch = async (tx, schoolId, cutoff) => {
  const result = await tx`
    DELETE FROM app.notification_dead_letters
    WHERE school_id = ${schoolId}::uuid
      AND id IN (
        SELECT id FROM app.notification_dead_letters
        WHERE school_id = ${schoolId}::uuid AND failed_at < ${cutoff}
        LIMIT ${DATA_RETENTION_BATCH_SIZE}
      )
  `;
  return result.count;
};

/**
 * One row per (absence alert, parent): small. Read through
 * idx_attendance_alert_logs_school_student_sent's school_id. The row is the alert's dedup claim, keyed
 * by the absence's date; an alert for an absence over a year old is not raised again in practice,
 * and a repeat would be one more notice, not a lost one.
 */
const attendanceAlertLogBatch: SchoolBatch = async (tx, schoolId, cutoff) => {
  const result = await tx`
    DELETE FROM app.attendance_alert_logs
    WHERE school_id = ${schoolId}::uuid
      AND id IN (
        SELECT id FROM app.attendance_alert_logs
        WHERE school_id = ${schoolId}::uuid AND sent_at < ${cutoff}
        LIMIT ${DATA_RETENTION_BATCH_SIZE}
      )
  `;
  return result.count;
};

function purgeSchoolRows(
  sql: Sql,
  schoolId: string,
  cutoff: Date,
  batch: SchoolBatch,
  counted: Counter,
): Promise<void> {
  return drain(
    () => withSystemTenantTx(sql, { schoolId }, (tx) => batch(tx, schoolId, cutoff)),
    counted,
  );
}

/** The nil uuid sorts before every family id gen_random_uuid() can produce. */
const FIRST_FAMILY = "00000000-0000-0000-0000-000000000000";

/**
 * Sign-in sessions. Rotation links a family's tokens to each other (parent_token_id,
 * replaced_by_token_id, both ON DELETE RESTRICT), so a family is deleted whole, in one statement, and
 * only once every token in it expired more than the period ago: nothing can be issued into such a
 * family again (rotation needs an unexpired token), and the session list shows only live ones.
 * Walked in family_id order on idx_refresh_tokens_school_family with a cursor, so each run reads the
 * school's tokens once and always makes progress. The delete re-checks expiry in its own
 * transaction.
 */
async function purgeSchoolExpiredSessions(
  sql: Sql,
  schoolId: string,
  now: Date,
  counted: Counter,
): Promise<void> {
  const cutoff = retentionCutoff("expiredSessions", now);
  let after = FIRST_FAMILY;
  for (;;) {
    const { families, deleted } = await withSystemTenantTx(sql, { schoolId }, async (tx) => {
      const rows = await tx<{ family_id: string }[]>`
        SELECT family_id FROM app.refresh_tokens
        WHERE school_id = ${schoolId}::uuid AND family_id > ${after}::uuid
        GROUP BY family_id
        HAVING max(expires_at) < ${cutoff}
        ORDER BY family_id
        LIMIT ${SESSION_FAMILY_BATCH_SIZE}
      `;
      const ids = rows.map((row) => row.family_id);
      if (ids.length === 0) return { families: ids, deleted: 0 };
      const result = await tx`
        DELETE FROM app.refresh_tokens
        WHERE school_id = ${schoolId}::uuid
          AND family_id = ANY(${ids}::uuid[])
          AND family_id NOT IN (
            SELECT family_id FROM app.refresh_tokens
            WHERE school_id = ${schoolId}::uuid
              AND family_id = ANY(${ids}::uuid[])
              AND expires_at >= ${cutoff}
          )
      `;
      return { families: ids, deleted: result.count };
    });
    counted(deleted);
    if (families.length < SESSION_FAMILY_BATCH_SIZE) return;
    after = families[families.length - 1]!;
  }
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
    emailEvents: 0,
    emailDeliveries: 0,
    notificationDispatchLogs: 0,
    notificationIdempotencyKeys: 0,
    notificationDeadLetters: 0,
    attendanceAlertLogs: 0,
    outboxEvents: 0,
    expiredSessions: 0,
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
    ["emailEvents", () => purgeEmailEvents(sql, now, (deleted) => (result.emailEvents += deleted))],
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
  // Outbox events before email deliveries, so a delivery whose event goes today can go today too.
  const rowSteps: [RetainedDataCategory, SchoolBatch, Counter][] = [
    ["outboxEvents", outboxEventBatch, (deleted) => (result.outboxEvents += deleted)],
    ["emailDeliveries", emailDeliveryBatch, (deleted) => (result.emailDeliveries += deleted)],
    [
      "notificationDispatchLogs",
      dispatchLogBatch,
      (deleted) => (result.notificationDispatchLogs += deleted),
    ],
    [
      "notificationIdempotencyKeys",
      idempotencyKeyBatch,
      (deleted) => (result.notificationIdempotencyKeys += deleted),
    ],
    [
      "notificationDeadLetters",
      deadLetterBatch,
      (deleted) => (result.notificationDeadLetters += deleted),
    ],
    [
      "attendanceAlertLogs",
      attendanceAlertLogBatch,
      (deleted) => (result.attendanceAlertLogs += deleted),
    ],
  ];
  for (const schoolId of schoolIds) {
    // Each category on its own, so one that fails for a school does not keep the others from it.
    const schoolSteps: [RetainedDataCategory, () => Promise<void>][] = [
      [
        "notifications",
        () =>
          purgeSchoolNotifications(sql, schoolId, now, (deleted) => {
            result.notifications += deleted;
          }),
      ],
      ...rowSteps.map(([category, batch, counted]): [RetainedDataCategory, () => Promise<void>] => [
        category,
        () => purgeSchoolRows(sql, schoolId, retentionCutoff(category, now), batch, counted),
      ]),
      [
        "expiredSessions",
        () =>
          purgeSchoolExpiredSessions(sql, schoolId, now, (deleted) => {
            result.expiredSessions += deleted;
          }),
      ],
    ];
    if (storage) {
      schoolSteps.push([
        "dsrExports",
        () => purgeSchoolExportBundles(sql, storage, schoolId, now, result),
      ]);
    }
    for (const [category, step] of schoolSteps) {
      try {
        await step();
      } catch (error) {
        result.failed += 1;
        log.warn(
          { school_id: schoolId, category, error },
          "data retention purge failed for school; batch rolled back and category skipped",
        );
      }
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
      email_events: result.emailEvents,
      email_deliveries: result.emailDeliveries,
      notification_dispatch_logs: result.notificationDispatchLogs,
      notification_idempotency_keys: result.notificationIdempotencyKeys,
      notification_dead_letters: result.notificationDeadLetters,
      attendance_alert_logs: result.attendanceAlertLogs,
      outbox_events: result.outboxEvents,
      expired_sessions: result.expiredSessions,
      objects_removed: result.objectsRemoved,
      objects_failed: result.objectsFailed,
      schools: result.schools,
      failed: result.failed,
    },
    "data retention sweep finished",
  );
  return result;
}
