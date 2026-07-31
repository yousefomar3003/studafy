/**
 * Notification dispatcher (ST-139).
 *
 * Consumes one job per published domain event, resolves exactly the people it concerns, decides
 * per channel whether each of them should actually be told, renders the message in their locale,
 * and delivers it — at most once per recipient per channel, ever.
 *
 * ## Reserve, send, confirm — and why a plain claim is not enough here
 *
 * app.attendance_alert_logs (000056) dedups with a bare `INSERT ... ON CONFLICT DO NOTHING`, and
 * that is right *there*: the claim and the notification are written in one transaction, so either
 * both commit or neither does, and a lost race is indistinguishable from never having run.
 *
 * This dispatcher is not in that position for every channel. `in_app` writes a row and is
 * transactional, so it keeps the single-transaction shape. `push` and `email` hand work to a
 * delivery job in Redis, which no database transaction can roll back. With a bare claim, a crash
 * between the key insert and the enqueue would leave a committed key with nothing sent; the retry
 * would see the key, skip that recipient, and the job would then *succeed* — a silent drop that
 * produces no dead-letter row, no failed job, and no trace anywhere. That is strictly worse than a
 * duplicate.
 *
 * So the key is reserved before the send and confirmed after it, and a reservation older than
 * IDEMPOTENCY_LEASE_MS is reclaimable. `dispatched_at IS NULL` means the outcome is unknown, not
 * that nothing happened — which is the honest thing for the database to say, and the thing a retry
 * needs to know. Same shape 000069 already uses for payment idempotency.
 *
 * ## One transaction per recipient
 *
 * Not one per job. A per-job transaction would roll back the idempotency rows of recipients whose
 * messages were already sent, so the retry would send them again — turning a partial failure into
 * guaranteed duplicates, which is the exact outcome this whole file exists to prevent. It would
 * also pin one PgBouncer server connection across N external calls, ten deep at this queue's
 * concurrency. The rule is already stated in attendance-alert.worker.ts; this follows it.
 */

import { NOTIFICATION_TYPES } from "@studafy/constants";
import { NOTIFICATION_CATALOG } from "@studafy/notification-templates";
import postgres from "postgres";

import { withSystemTenantTx } from "../../db/tenant-tx";

import { isUrgent, isWithinQuietHours } from "./quiet-hours";
import { resolveGradeContext, resolveGradeRecipients } from "./resolvers/recipient.resolver";
import { render, resolveLocale, resolveRoute } from "./templates/renderer";

import type { DispatchRecipient, GradeEventContext } from "./resolvers/recipient.resolver";
import type { NotificationType } from "@studafy/constants";
import type { NotificationChannel } from "@studafy/notification-templates";
import type { Sql, TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DispatchNotificationJobData {
  schoolId: string;
  /**
   * The originating event's stable identity. For grades.published this is the submission id, not a
   * generated uuid: publication is a one-shot `approved -> published` transition, so the submission
   * id is the same across a duplicate enqueue and a job replay, which is exactly the property an
   * idempotency key needs. A generated id would make every replay look like a new event.
   */
  eventId: string;
  eventType: string;
  submissionId: string;
}

export interface DeliverNotificationJobData {
  schoolId: string;
  dispatchLogId: string;
  recipientId: string;
  channel: NotificationChannel;
  notificationType: string;
  title: string;
  body: string;
}

export type DeliveryEnqueuer = (data: DeliverNotificationJobData) => Promise<void>;

export interface DispatchDependencies {
  databaseUrl: string;
  enqueueDelivery: DeliveryEnqueuer;
  jobId?: string | null;
}

export interface DispatchResult {
  processed: true;
  recipientsResolved: number;
  /** Channel deliveries that actually happened or were handed to a delivery job. */
  dispatched: number;
  /** Claims lost to an earlier run. Non-zero here is the idempotency ledger working, not a fault. */
  duplicatesSkipped: number;
  suppressedPreference: number;
  suppressedQuietHours: number;
  /** Recipients left in an unknown state. Non-zero makes the job throw. */
  unresolved: number;
}

interface RecipientSettings {
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  local_time: string;
  recipient_locale: string | null;
  school_locale: string | null;
}

interface PreferenceRow {
  channel: string;
  enabled: boolean;
}

type DispatchStatus =
  "suppressed_preference" | "suppressed_quiet_hours" | "enqueued" | "delivered" | "failed";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How long a reservation stays another worker's business before it can be reclaimed.
 *
 * Bounded on both sides, and both bounds are load-bearing:
 *
 *   Lower — it must exceed BullMQ's 30s `lockDuration` plus however long a delivery enqueue takes,
 *   or a worker that is merely slow would have its own reservation stolen by a concurrent one and
 *   the recipient would be notified twice.
 *
 *   Upper — it must fit inside the job's own retry window, or no retry could ever reclaim a crashed
 *   attempt. With `attempts: 5` and exponential backoff from 5s the delays are 5/10/20/40s, about
 *   75s of backoff plus execution; a fifteen-minute lease would mean every retry in the job's
 *   lifetime skips the recipient it was retrying for.
 *
 * Two minutes clears the first bound comfortably and sits inside the second.
 */
export const IDEMPOTENCY_LEASE_MS = 2 * 60 * 1000;

/** BullMQ options for the delivery jobs this dispatcher fans out to. */
export const DELIVERY_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 60 * 60 },
  removeOnFail: { age: 30 * 24 * 60 * 60 },
} as const;

// ---------------------------------------------------------------------------
// Idempotency key
// ---------------------------------------------------------------------------

/**
 * `{event_type}:{event_id}:{recipient_id}:{channel}`, as ST-139 specifies.
 *
 * The channel is in the key, not just the row: a recipient who should get both an email and a push
 * is two deliveries, and keying without it would let the first channel's reservation swallow the
 * second's — the same trap 000056 documents for `parent_user_id`. The school is deliberately *not*
 * in the string; it is a column, and the unique index is `(school_id, idempotency_key)`.
 */
export function buildIdempotencyKey(
  eventType: string,
  eventId: string,
  recipientId: string,
  channel: string,
): string {
  return `${eventType}:${eventId}:${recipientId}:${channel}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The recipient's quiet-hours window, their current wall-clock time, and the locales to render in.
 *
 * `local_time` is computed by PostgreSQL rather than by Bun because PostgreSQL ships and updates
 * the IANA tz database, and the runtime's copy is whatever its base image baked in — a difference
 * that shows up precisely when a country changes its rules. See quiet-hours.ts.
 *
 * LEFT JOIN on the settings: a user who has never opened a notification settings page has no row,
 * and that means "no quiet hours", not "no notifications". COALESCE to the school's timezone so the
 * clock is still right for a user who has customised nothing.
 */
async function loadRecipientSettings(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
): Promise<RecipientSettings> {
  const [row] = await tx<RecipientSettings[]>`
    SELECT
      settings.quiet_hours_start::text AS quiet_hours_start,
      settings.quiet_hours_end::text AS quiet_hours_end,
      (CURRENT_TIMESTAMP AT TIME ZONE coalesce(
        settings.timezone, school_settings.timezone, 'UTC'
      ))::time::text AS local_time,
      settings.locale AS recipient_locale,
      school_settings.locale AS school_locale
    FROM app.users AS target_user
    LEFT JOIN app.user_notification_settings AS settings
      ON settings.user_id = target_user.id
     AND settings.school_id = target_user.school_id
    LEFT JOIN app.school_settings AS school_settings
      ON school_settings.school_id = target_user.school_id
    WHERE target_user.id = ${userId}::uuid
      AND target_user.school_id = ${schoolId}::uuid
  `;

  return (
    row ?? {
      quiet_hours_start: null,
      quiet_hours_end: null,
      local_time: "00:00:00",
      recipient_locale: null,
      school_locale: null,
    }
  );
}

/**
 * Which channels this user has left enabled for this notification type.
 *
 * A channel with no row is treated as enabled. app.notification_preferences is seeded for every
 * user at activation by trg_users_seed_notification_preferences, so a missing row means the enum
 * gained a value after that user was activated — and the default the trigger itself writes is
 * `true`. Defaulting to disabled would silently mute every existing user the moment a channel is
 * added, which is the wrong way for this to fail.
 */
async function loadEnabledChannels(
  tx: TransactionSql,
  userId: string,
  notificationType: string,
): Promise<Map<string, boolean>> {
  const rows = await tx<PreferenceRow[]>`
    SELECT channel::text AS channel, enabled
    FROM app.notification_preferences
    WHERE user_id = ${userId}::uuid
      AND notification_type = ${notificationType}::app.notification_type
  `;

  return new Map(rows.map((row) => [row.channel, row.enabled]));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Reserve the right to deliver one notification to one recipient on one channel.
 *
 * Returns the ledger row id when this call won the reservation — either because nobody held it, or
 * because the previous holder's lease expired without confirming — and `null` when the delivery is
 * already confirmed or another worker holds a live lease.
 *
 * This single statement is where every duplicate-suppression guarantee in the dispatcher lives. The
 * unique index arbitrates, not the application, which is what makes it correct under concurrent
 * workers rather than merely correct under one.
 */
async function reserveDispatch(
  tx: TransactionSql,
  schoolId: string,
  idempotencyKey: string,
  recipientUserId: string,
  channel: string,
): Promise<string | null> {
  const leaseInterval = `${Math.floor(IDEMPOTENCY_LEASE_MS / 1000)} seconds`;

  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.notification_idempotency_keys (
      school_id, idempotency_key, recipient_user_id, channel, reserved_at, attempt_count
    ) VALUES (
      ${schoolId}::uuid,
      ${idempotencyKey},
      ${recipientUserId}::uuid,
      ${channel}::app.notification_channel,
      CURRENT_TIMESTAMP,
      1
    )
    ON CONFLICT (school_id, idempotency_key) DO UPDATE
      SET reserved_at = CURRENT_TIMESTAMP,
          attempt_count = app.notification_idempotency_keys.attempt_count + 1
      WHERE app.notification_idempotency_keys.dispatched_at IS NULL
        AND app.notification_idempotency_keys.reserved_at
            < CURRENT_TIMESTAMP - ${leaseInterval}::interval
    RETURNING id
  `;

  return row?.id ?? null;
}

/** Confirm a reservation: the delivery is known to have happened and can never be repeated. */
async function confirmDispatch(
  tx: TransactionSql,
  schoolId: string,
  reservationId: string,
): Promise<void> {
  await tx`
    UPDATE app.notification_idempotency_keys
    SET dispatched_at = CURRENT_TIMESTAMP
    WHERE id = ${reservationId}::uuid
      AND school_id = ${schoolId}::uuid
  `;
}

/**
 * Record what happened to one (event, recipient, channel), whatever that was.
 *
 * Suppressions are logged as loudly as deliveries. "Why was I not told about my child's grade" is
 * the support question this table exists to answer, and it is unanswerable if the interesting case
 * leaves no row.
 */
async function writeDispatchLog(
  tx: TransactionSql,
  params: {
    schoolId: string;
    eventId: string;
    eventType: string;
    recipient: DispatchRecipient;
    channel: string;
    idempotencyKey: string;
    status: DispatchStatus;
    title: string | null;
    body: string | null;
    notificationId: string | null;
  },
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.notification_dispatch_logs (
      school_id, event_id, event_type, recipient_id, recipient_role, channel,
      idempotency_key, status, rendered_title, rendered_body, notification_id
    ) VALUES (
      ${params.schoolId}::uuid,
      ${params.eventId},
      ${params.eventType},
      ${params.recipient.userId}::uuid,
      ${params.recipient.role}::app.notification_recipient_role,
      ${params.channel}::app.notification_channel,
      ${params.idempotencyKey},
      ${params.status}::app.notification_dispatch_status,
      ${params.title},
      ${params.body},
      ${params.notificationId}::uuid
    )
    RETURNING id
  `;
  return row!.id;
}

/**
 * Write the in-app inbox row.
 *
 * tx.json(), not JSON.stringify() + ::jsonb. With an explicit ::jsonb cast postgres.js infers the
 * parameter type as jsonb and JSON-encodes the string it was handed, producing a jsonb *string*
 * rather than an object — which ck_notifications_metadata rejects outright. See the same note in
 * attendance-alert.worker.ts.
 */
async function writeInAppNotification(
  tx: TransactionSql,
  params: {
    schoolId: string;
    recipientId: string;
    notificationType: string;
    title: string;
    body: string;
    route: string;
    context: GradeEventContext;
  },
): Promise<string> {
  const metadata = tx.json({
    route: params.route,
    student_id: params.context.studentId,
    class_id: params.context.classId,
    course_id: params.context.courseId,
  });

  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, metadata)
    VALUES (
      ${params.schoolId}::uuid,
      ${params.recipientId}::uuid,
      ${params.notificationType}::app.notification_type,
      ${params.title},
      ${params.body},
      ${metadata}
    )
    RETURNING id
  `;
  return row!.id;
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

/**
 * Dispatch one published-grades event.
 *
 * `databaseUrl` and `enqueueDelivery` are injected rather than read from the environment, so the
 * processor is callable from a test against a disposable database with no Redis at all — the shape
 * processAttendanceAlert, processBulkInvite and processStudentImport already establish.
 */
export async function processNotificationDispatch(
  data: DispatchNotificationJobData,
  deps: DispatchDependencies,
): Promise<DispatchResult> {
  const { schoolId, eventId, eventType, submissionId } = data;
  const notificationType = NOTIFICATION_TYPES.GRADE_POSTED;
  const channels = NOTIFICATION_CATALOG[notificationType].channels;

  // prepare: false is mandatory — the runtime sits behind PgBouncer in transaction pooling mode,
  // where server-side prepared statements do not survive between transactions.
  const sql = postgres(deps.databaseUrl, { max: 4, idle_timeout: 20, prepare: false });

  const result: DispatchResult = {
    processed: true,
    recipientsResolved: 0,
    dispatched: 0,
    duplicatesSkipped: 0,
    suppressedPreference: 0,
    suppressedQuietHours: 0,
    unresolved: 0,
  };

  // Kept so the thrown error can carry the underlying cause. The last one wins rather than all of
  // them being collected: the dead-letter row has one error_message, and a worker that fails one
  // recipient has almost always failed the rest for the same reason.
  let lastError: unknown;

  try {
    const resolved = await withSystemTenantTx(sql, { schoolId }, async (tx) => {
      const context = await resolveGradeContext(tx, schoolId, submissionId);
      if (context === null) return null;

      const recipients = await resolveGradeRecipients(tx, schoolId, [context.studentId]);
      return { context, recipients };
    });

    // A submission that has been deleted, or rolled back out of `published`, is stale rather than
    // broken: there is nothing to send and nothing for an operator to fix. Returning cleanly keeps
    // it out of the dead-letter table, which is reserved for things somebody must act on.
    if (resolved === null) return result;

    const { context, recipients } = resolved;
    result.recipientsResolved = recipients.length;

    const templateVars = {
      courseName: context.courseName,
      assignmentName: context.assignmentName,
      grade: context.grade,
    };
    const route = resolveRoute(notificationType, {
      courseId: context.courseId,
      classId: context.classId,
      studentId: context.studentId,
    });

    for (const recipient of recipients) {
      for (const channel of channels) {
        try {
          const outcome = await dispatchOne(sql, {
            schoolId,
            eventId,
            eventType,
            recipient,
            channel,
            notificationType,
            context,
            templateVars,
            route,
            enqueueDelivery: deps.enqueueDelivery,
          });

          switch (outcome) {
            case "delivered":
            case "enqueued":
              result.dispatched += 1;
              break;
            case "duplicate":
              result.duplicatesSkipped += 1;
              break;
            case "suppressed_preference":
              result.suppressedPreference += 1;
              break;
            case "suppressed_quiet_hours":
              result.suppressedQuietHours += 1;
              break;
          }
        } catch (error) {
          // One recipient's channel failing must not abandon the rest — a database blip on the
          // third parent should not cost the first two their notifications. The failure is counted
          // and rethrown as a whole-job failure at the end, which is what routes it to the DLQ.
          result.unresolved += 1;
          lastError = error;
        }
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  if (result.unresolved > 0) {
    throw new Error(
      `notification dispatch left ${String(result.unresolved)} recipient channel(s) unresolved ` +
        `for ${eventType}:${eventId}`,
      { cause: lastError },
    );
  }

  return result;
}

type DispatchOutcome =
  "delivered" | "enqueued" | "duplicate" | "suppressed_preference" | "suppressed_quiet_hours";

/**
 * One recipient, one channel.
 *
 * The transaction boundary differs by channel, and that difference is the point:
 *
 *   in_app  — reserve, write the inbox row, confirm, log. All in one transaction, because the
 *             "delivery" *is* a database write. There is no external boundary to straddle, so the
 *             single-transaction shape of attendance-alert.worker.ts applies unchanged.
 *
 *   push/email — reserve and log in one transaction, enqueue the delivery job, confirm in a second.
 *             The enqueue is a Redis call no transaction can roll back, so the reservation has to
 *             outlive the first commit in an explicitly unconfirmed state.
 */
async function dispatchOne(
  sql: Sql,
  params: {
    schoolId: string;
    eventId: string;
    eventType: string;
    recipient: DispatchRecipient;
    channel: NotificationChannel;
    notificationType: NotificationType;
    context: GradeEventContext;
    templateVars: Record<string, string>;
    route: string;
    enqueueDelivery: DeliveryEnqueuer;
  },
): Promise<DispatchOutcome> {
  const { schoolId, recipient, channel, notificationType } = params;
  const idempotencyKey = buildIdempotencyKey(
    params.eventType,
    params.eventId,
    recipient.userId,
    channel,
  );

  const prepared = await withSystemTenantTx(sql, { schoolId }, async (tx) => {
    const settings = await loadRecipientSettings(tx, schoolId, recipient.userId);
    const enabledChannels = await loadEnabledChannels(tx, recipient.userId, notificationType);

    // Absent row means enabled — see loadEnabledChannels.
    if (enabledChannels.get(channel) === false) {
      await writeDispatchLog(tx, {
        ...params,
        idempotencyKey,
        status: "suppressed_preference",
        title: null,
        body: null,
        notificationId: null,
      });
      return { outcome: "suppressed_preference" as const };
    }

    if (
      !isUrgent(notificationType) &&
      isWithinQuietHours(settings.local_time, settings.quiet_hours_start, settings.quiet_hours_end)
    ) {
      await writeDispatchLog(tx, {
        ...params,
        idempotencyKey,
        status: "suppressed_quiet_hours",
        title: null,
        body: null,
        notificationId: null,
      });
      return { outcome: "suppressed_quiet_hours" as const };
    }

    const reservationId = await reserveDispatch(
      tx,
      schoolId,
      idempotencyKey,
      recipient.userId,
      channel,
    );
    // Already delivered, or another worker holds a live lease. Either way this run has nothing to
    // do and must not write a second log row — the first run's row is the record.
    if (reservationId === null) return { outcome: "duplicate" as const };

    const locale = resolveLocale(settings.recipient_locale, settings.school_locale);
    const { title, body } = render(notificationType, channel, locale, params.templateVars);

    if (channel === "in_app") {
      const notificationId = await writeInAppNotification(tx, {
        schoolId,
        recipientId: recipient.userId,
        notificationType,
        title,
        body,
        route: params.route,
        context: params.context,
      });
      await confirmDispatch(tx, schoolId, reservationId);
      await writeDispatchLog(tx, {
        ...params,
        idempotencyKey,
        status: "delivered",
        title,
        body,
        notificationId,
      });
      return { outcome: "delivered" as const };
    }

    const dispatchLogId = await writeDispatchLog(tx, {
      ...params,
      idempotencyKey,
      status: "enqueued",
      title,
      body,
      notificationId: null,
    });
    return { outcome: "pending" as const, reservationId, dispatchLogId, title, body };
  });

  if (prepared.outcome !== "pending") return prepared.outcome;

  await params.enqueueDelivery({
    schoolId,
    dispatchLogId: prepared.dispatchLogId,
    recipientId: recipient.userId,
    channel,
    notificationType,
    title: prepared.title,
    body: prepared.body,
  });

  // Only now is the delivery someone else's problem, and only now may the reservation be confirmed.
  // If the enqueue above throws, the reservation stays unconfirmed and a retry reclaims it once the
  // lease expires — which is the whole reason this is two transactions and not one.
  await withSystemTenantTx(sql, { schoolId }, async (tx) => {
    await confirmDispatch(tx, schoolId, prepared.reservationId);
  });

  return "enqueued";
}
