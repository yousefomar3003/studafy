/**
 * Daily notification digest producer.
 *
 * Runs as a repeatable BullMQ job (JOB_NAMES.SEND_NOTIFICATION_DIGESTS) and collapses each
 * recipient's undigested in-app notifications into one digest.sent-shaped email per day, for
 * whichever (type, email) pairs that recipient has opted into via
 * app.notification_preferences.digest (ST-143). The email dispatcher then sends each digest
 * through the ordinary channel, so delivery dedup, suppression, and SES correlation apply
 * unchanged — see email/resolve.ts.
 *
 * Distinct from email/digest-producer.ts, which is the parent-specific attendance/fee digest.
 * That one predates the preferences.digest flag, aggregates unconditionally for every linked
 * parent, and is sourced straight from outbox events rather than app.notifications. This producer
 * is the general, opt-in mechanism the flag was actually built for, and deliberately excludes
 * ATTENDANCE_ALERT even though it is digest_eligible, so the same alert can never be folded into
 * two digests by two independent jobs.
 *
 * Crash-safety mirrors digest-producer.ts: each school's claim, per-recipient digest.sent inserts,
 * and digested-marking of the claimed rows commit together in one transaction. A crash rolls the
 * whole school back, so the next run rebuilds the same digests from the same rows; a committed run
 * can never be re-run, because its rows are already marked digested.
 */

import { DOMAIN_EVENTS, NOTIFICATION_TYPES } from "@studafy/constants";
import postgres from "postgres";

import { withSystemTenantTx } from "../../../db/tenant-tx";

import { loadSchoolIds } from "./schools";

import type { TransactionSql } from "postgres";

/**
 * The notification types this job digests. A subset of DIGEST_ELIGIBLE_NOTIFICATION_TYPES
 * (packages/constants/src/notifications.ts) with ATTENDANCE_ALERT deliberately left out — that
 * type keeps its own dedicated parent digest (digest-producer.ts), which predates this flag and
 * is not gated by it.
 */
const NOTIFICATION_DIGEST_SOURCE_TYPES: readonly string[] = [
  NOTIFICATION_TYPES.COURSE_PUBLISHED,
  NOTIFICATION_TYPES.DISCUSSION_REPLY,
  NOTIFICATION_TYPES.STUDY_GROUP_INVITE,
];

interface ClaimedNotificationRow {
  id: string;
  user_id: string;
  notification_type: string;
  title: string;
  body: string;
  created_at: string;
}

/**
 * One digest line item, carried verbatim from the already-rendered notification row. Deliberately
 * a `type` rather than an `interface`, the same reason digest-producer.ts's DigestItem is: tx.json()
 * types its argument as an index-signature `JSONValue`, and only type aliases get the implicit
 * index signature TS needs to accept an object here.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- see comment above
type DigestItem = {
  notificationType: string;
  title: string;
  body: string;
  occurredAt: string;
};

export interface NotificationDigestResult {
  processed: true;
  schoolsScanned: number;
  recipientsDigested: number;
  itemsDigested: number;
  notificationsClaimed: number;
}

/**
 * Undigested, digest-eligible notifications whose recipient has actually opted into email digest
 * for that (type, channel) pair. `enabled = false` excludes a recipient who has turned the type off
 * on email entirely — digest = true on a disabled channel is a contradiction no caller should be
 * able to write, but this query treats "off" as the controlling fact rather than assuming it can't
 * happen.
 *
 * Rows that don't match (no preference row, or digest = false) are left untouched: they stay
 * undigested indefinitely, which is correct today, since no immediate-send path exists yet for
 * these types either — see DIGEST_ELIGIBLE_NOTIFICATION_TYPES's own comment on that gap.
 */
async function claimNotificationRows(
  tx: TransactionSql,
  limit: number,
): Promise<ClaimedNotificationRow[]> {
  return await tx<ClaimedNotificationRow[]>`
    SELECT n.id, n.user_id, n.notification_type::text, n.title, n.body, n.created_at
    FROM app.notifications AS n
    JOIN app.notification_preferences AS p
      ON p.user_id = n.user_id
     AND p.notification_type = n.notification_type
     AND p.channel = 'email'
    WHERE n.notification_type = ANY(${[...NOTIFICATION_DIGEST_SOURCE_TYPES]}::app.notification_type[])
      AND n.digested_at IS NULL
      AND p.digest = true
      AND p.enabled = true
    ORDER BY n.user_id, n.created_at
    FOR UPDATE OF n SKIP LOCKED
    LIMIT ${limit}
  `;
}

/**
 * A recipient's email address and their own local calendar date, the same
 * `CURRENT_TIMESTAMP AT TIME ZONE` computation quiet-hours.ts and dispatcher.worker.ts use — done
 * in SQL rather than in Bun for the reason those two document: PostgreSQL, not the runtime image,
 * owns an up-to-date IANA tz database. COALESCE order mirrors loadRecipientSettings in
 * dispatcher.worker.ts: the recipient's own timezone, then their school's, then UTC.
 */
async function loadRecipientContext(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
): Promise<{ email: string; digestDate: string } | null> {
  const [row] = await tx<{ email: string; digest_date: string }[]>`
    SELECT
      target_user.email,
      (CURRENT_TIMESTAMP AT TIME ZONE coalesce(
        settings.timezone, school_settings.timezone, 'UTC'
      ))::date::text AS digest_date
    FROM app.users AS target_user
    LEFT JOIN app.user_notification_settings AS settings
      ON settings.user_id = target_user.id
     AND settings.school_id = target_user.school_id
    LEFT JOIN app.school_settings AS school_settings
      ON school_settings.school_id = target_user.school_id
    WHERE target_user.id = ${userId}::uuid
      AND target_user.school_id = ${schoolId}::uuid
  `;

  return row ? { email: row.email, digestDate: row.digest_date } : null;
}

/**
 * Process one school: claim its undigested, opted-in notifications and turn them into
 * per-recipient notification.digestSent outbox events, all in one transaction.
 */
async function processSchool(
  sql: postgres.Sql,
  schoolId: string,
): Promise<{ recipients: number; items: number; claimed: number }> {
  return withSystemTenantTx(sql, { schoolId }, async (tx) => {
    const rows = await claimNotificationRows(tx, 200);
    if (rows.length === 0) return { recipients: 0, items: 0, claimed: 0 };

    // Group by recipient across all claimed rows, so one user gets exactly one digest.
    const byUser = new Map<string, DigestItem[]>();
    for (const row of rows) {
      const existing = byUser.get(row.user_id) ?? [];
      existing.push({
        notificationType: row.notification_type,
        title: row.title,
        body: row.body,
        occurredAt: row.created_at,
      });
      byUser.set(row.user_id, existing);
    }

    let recipients = 0;
    let items = 0;

    for (const [userId, digestItems] of byUser) {
      const context = await loadRecipientContext(tx, schoolId, userId);
      if (context === null) {
        // A recipient with no user row cannot be emailed; their notifications stay claimed but
        // silent. The in-app notifications they did receive are the record.
        continue;
      }
      // digestItems is never empty here: byUser only ever holds keys pushed to alongside a claimed
      // row, so a user with nothing to say is simply absent from the map — the empty-digest case
      // the acceptance criteria calls out is satisfied by construction, not by a runtime check.

      // Hand-built to match eventPayloadSchemas[NOTIFICATION_DIGEST_SENT] in
      // apps/api/src/lib/events/schemas.ts (the contract of record); apps/workers does not depend
      // on apps/api. tx.json() keeps the jsonb an object — see attendance-alert.worker.ts's
      // emitAlertRaised for why that matters.
      const payload = tx.json({
        userId,
        email: context.email,
        digestDate: context.digestDate,
        items: digestItems,
      });

      await tx`
        INSERT INTO app.outbox_events (school_id, event_name, payload)
        VALUES (${schoolId}::uuid, ${DOMAIN_EVENTS.NOTIFICATION_DIGEST_SENT}, ${payload})
      `;
      recipients += 1;
      items += digestItems.length;
    }

    const now = new Date().toISOString();
    await tx`UPDATE app.notifications SET digested_at = ${now} WHERE id = ANY(${rows.map((r) => r.id)})`;

    return { recipients, items, claimed: rows.length };
  });
}

/**
 * Run one notification-digest cycle. `databaseUrl` is a parameter rather than read from the
 * environment so the processor is callable from a test against a disposable database — the same
 * shape digest-producer.ts and the attendance alert processor establish.
 */
export async function processNotificationDigest(
  databaseUrl: string,
): Promise<NotificationDigestResult> {
  const sql = postgres(databaseUrl, { max: 4, idle_timeout: 20, prepare: false });

  try {
    const schoolIds = await loadSchoolIds(sql);

    let recipients = 0;
    let items = 0;
    let claimed = 0;

    for (const schoolId of schoolIds) {
      const outcome = await processSchool(sql, schoolId);
      recipients += outcome.recipients;
      items += outcome.items;
      claimed += outcome.claimed;
    }

    return {
      processed: true,
      schoolsScanned: schoolIds.length,
      recipientsDigested: recipients,
      itemsDigested: items,
      notificationsClaimed: claimed,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
