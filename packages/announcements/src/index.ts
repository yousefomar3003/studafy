/**
 * Announcement audience resolution and publishing (ST-194), shared between the API's immediate-
 * publish path (apps/api/src/modules/announcements) and the workers' scheduled-publish sweep
 * (apps/workers/src/queues/announcements) — the same "one function, two callers" split
 * @studafy/audit-reporting uses between the audit explorer's API and its export worker.
 *
 * Deliberately not built on the event-driven notification dispatcher
 * (apps/workers/src/queues/notifications/dispatcher.worker.ts). That pipeline exists to fan a single
 * domain event out to a small, event-derived recipient set with per-channel idempotency and quiet
 * hours — machinery an admin broadcast doesn't need: publishing an announcement is a one-shot,
 * admin-initiated status transition (not a replayable domain event), it explicitly wants to bypass
 * quiet hours (a school notice is not something a recipient asked to be woken for, but it is
 * something they need to see promptly), and it has no push/email provider to fan out to regardless
 * (see docs/architecture/SAD_21_notification_dispatch_flow.md's "What does not exist"). What it does
 * need — respecting a recipient's own notification_preferences for the non-mandatory type — is
 * handled directly here with one set-based query, rather than by standing up an event, a payload
 * schema, and a resolver for a fan-out this module already computes in one place.
 *
 * This module is deliberately agnostic to RLS: it never sets session state. Callers open their own
 * tenant transaction (withTenantTx in the API, withSystemTenantTx in the worker) and hand this the
 * transaction handle.
 */

import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AnnouncementAudienceType = "school" | "role" | "class";

export interface AnnouncementAudience {
  audienceType: AnnouncementAudienceType;
  audienceRole: string | null;
  audienceClassId: string | null;
}

export interface AnnouncementRow {
  id: string;
  school_id: string;
  created_by: string;
  title: string;
  body: string;
  mandatory: boolean;
  audience_type: AnnouncementAudienceType;
  audience_role: string | null;
  audience_class_id: string | null;
  status: "scheduled" | "published";
  scheduled_at: Date;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface PublishAnnouncementResult {
  /** False when the row was not claimable — already published, or not found (or not yet due). */
  published: boolean;
  /** Size of the resolved audience at publish time, regardless of preference suppression. */
  recipientCount: number;
  /** How many of that audience actually received an app.notifications row. */
  notifiedCount: number;
}

export interface AnnouncementReach {
  recipientCount: number;
  notifiedCount: number;
}

const NOTIFICATION_TYPE_FOR = {
  mandatory: "ADMIN_ANNOUNCEMENT",
  optional: "ANNOUNCEMENT",
} as const;

// ---------------------------------------------------------------------------
// Audience resolution
// ---------------------------------------------------------------------------

/**
 * Resolves an audience descriptor to the exact set of active user ids it names, at the instant this
 * runs. Non-active users are excluded here rather than downstream, mirroring the grade-publication
 * dispatcher's recipient resolution: a suspended account has no seeded notification_preferences
 * row, so leaving it in would surface as a false "preference suppression" instead of what it is.
 */
export async function resolveAnnouncementRecipientIds(
  tx: TransactionSql,
  schoolId: string,
  audience: AnnouncementAudience,
): Promise<string[]> {
  if (audience.audienceType === "school") {
    const rows = await tx<{ id: string }[]>`
      SELECT id FROM app.users WHERE school_id = ${schoolId}::uuid AND status = 'active'
    `;
    return rows.map((row) => row.id);
  }

  if (audience.audienceType === "role") {
    const rows = await tx<{ id: string }[]>`
      SELECT u.id
      FROM app.user_roles ur
      JOIN app.users u ON u.id = ur.user_id AND u.school_id = ur.school_id
      WHERE ur.school_id = ${schoolId}::uuid
        AND ur.role = ${audience.audienceRole}::app.user_role
        AND u.status = 'active'
    `;
    return rows.map((row) => row.id);
  }

  // "class": every actively enrolled student's account. A class's lead teacher is not included —
  // the audience picker names a class as a stand-in for "this class's students", the reachable
  // roster (app.enrollments), not everyone with a scheduling relationship to it.
  const rows = await tx<{ id: string }[]>`
    SELECT u.id
    FROM app.enrollments e
    JOIN app.students st ON st.id = e.student_id AND st.school_id = e.school_id
    JOIN app.users u ON u.id = st.user_id AND u.school_id = st.school_id
    WHERE e.school_id = ${schoolId}::uuid
      AND e.class_id = ${audience.audienceClassId}::uuid
      AND e.status = 'active'
      AND u.status = 'active'
  `;
  return rows.map((row) => row.id);
}

/**
 * Recipient ids among `candidateIds` who have explicitly disabled the non-mandatory 'ANNOUNCEMENT'
 * type on the `in_app` channel. A missing preference row means enabled (the seeding trigger's
 * default, see docs/database/notifications-data-model.md), so this only ever narrows, never widens,
 * the audience.
 *
 * Goes through app.get_announcement_opted_out_users (000105) rather than querying
 * app.notification_preferences directly: that table's `notification_preferences_owner` policy
 * (000017) is RESTRICTIVE and self-only, so a plain SELECT here would silently return zero rows —
 * "opted out by no one" — whenever this runs as the acting admin (the API's immediate-publish path)
 * rather than as studafy_admin (the workers' scheduled sweep, via withSystemTenantTx). Going through
 * the SECURITY DEFINER function makes the check correct under both callers identically, which is the
 * reason this whole module exists as one function rather than two.
 *
 * Never called for the mandatory type: ck_notification_preferences_mandatory_enabled (000083) makes
 * `enabled = false` impossible to write for 'ADMIN_ANNOUNCEMENT', so the query would always return
 * empty — calling it anyway would just be a wasted round trip that could be mistaken for a real check.
 */
async function resolveOptedOutRecipientIds(
  tx: TransactionSql,
  candidateIds: string[],
): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();
  const rows = await tx<{ user_id: string }[]>`
    SELECT * FROM app.get_announcement_opted_out_users(${candidateIds}::uuid[])
  `;
  return new Set(rows.map((row) => row.user_id));
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/**
 * Inserts one app.notifications row addressed to `params.userId` and returns its id. The id is
 * generated here rather than read back via `RETURNING id`: app.notifications carries a RESTRICTIVE,
 * SELECT-scoped `notifications_owner_select` policy (000017), and PostgreSQL evaluates a SELECT
 * policy against a `RETURNING` clause exactly as it would a real SELECT — so a plain INSERT for
 * someone else succeeds (there is no restrictive INSERT policy; see that migration's own comment)
 * while `RETURNING` on it would be silently disallowed for every row but the caller's own. Skipping
 * RETURNING sidesteps that read-side check entirely rather than working around it with an elevated
 * role the API's own runtime credential cannot assume (see resolveOptedOutRecipientIds' doc comment
 * for the same "no admin membership from apps/api" constraint on the write side of the problem).
 */
async function insertAnnouncementNotification(
  tx: TransactionSql,
  params: {
    schoolId: string;
    userId: string;
    notificationType: string;
    title: string;
    body: string;
    announcementId: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const metadata = tx.json({ announcement_id: params.announcementId, route: "/announcements" });
  await tx`
    INSERT INTO app.notifications (id, school_id, user_id, notification_type, title, body, metadata)
    VALUES (
      ${id}::uuid,
      ${params.schoolId}::uuid,
      ${params.userId}::uuid,
      ${params.notificationType}::app.notification_type,
      ${params.title},
      ${params.body},
      ${metadata}
    )
  `;
  return id;
}

/**
 * Publishes one announcement: atomically claims it (so a concurrent sweep tick or a retried request
 * can never double-publish — the same "status transition is the idempotency boundary" shape
 * grade-submission publication uses), resolves its audience, writes one app.notifications row per
 * recipient who has not disabled the type, and snapshots the *full* resolved audience into
 * app.announcement_recipients so reach stats reflect "who was targeted" even for recipients a
 * preference suppressed.
 *
 * `published: false` is not an error — it means there was nothing to do (already published, not
 * found, or not yet due), the same "stale job, not broken" reasoning
 * apps/workers/.../resolvers/recipient.resolver.ts's resolveGradeContext documents for a null result.
 */
export async function publishAnnouncement(
  tx: TransactionSql,
  schoolId: string,
  announcementId: string,
  now: Date,
): Promise<PublishAnnouncementResult> {
  const [claimed] = await tx<AnnouncementRow[]>`
    UPDATE app.announcements
    SET status = 'published', published_at = ${now}::timestamptz, updated_at = ${now}::timestamptz
    WHERE id = ${announcementId}::uuid
      AND school_id = ${schoolId}::uuid
      AND status = 'scheduled'
      AND scheduled_at <= ${now}::timestamptz
    RETURNING *
  `;
  if (!claimed) return { published: false, recipientCount: 0, notifiedCount: 0 };

  const recipientIds = await resolveAnnouncementRecipientIds(tx, schoolId, {
    audienceType: claimed.audience_type,
    audienceRole: claimed.audience_role,
    audienceClassId: claimed.audience_class_id,
  });
  if (recipientIds.length === 0) return { published: true, recipientCount: 0, notifiedCount: 0 };

  const notificationType = claimed.mandatory
    ? NOTIFICATION_TYPE_FOR.mandatory
    : NOTIFICATION_TYPE_FOR.optional;
  const optedOut = claimed.mandatory
    ? new Set<string>()
    : await resolveOptedOutRecipientIds(tx, recipientIds);
  const notifiedIds = recipientIds.filter((id) => !optedOut.has(id));

  // Pipelined, not sequential: postgres.js issues everything queued on `tx` over its one connection
  // as a pipeline, and Promise.all preserves result order against `notifiedIds`, so the zip below is
  // safe without a lookup map.
  const notificationIds = await Promise.all(
    notifiedIds.map((userId) =>
      insertAnnouncementNotification(tx, {
        schoolId,
        userId,
        notificationType,
        title: claimed.title,
        body: claimed.body,
        announcementId,
      }),
    ),
  );
  const notificationIdByUser = new Map(
    notifiedIds.map((id, index) => [id, notificationIds[index]!]),
  );

  await Promise.all(
    recipientIds.map((userId) => {
      const notificationId = notificationIdByUser.get(userId) ?? null;
      return tx`
        INSERT INTO app.announcement_recipients
          (school_id, announcement_id, user_id, notified_at, notification_id)
        VALUES (
          ${schoolId}::uuid,
          ${announcementId}::uuid,
          ${userId}::uuid,
          ${notificationId ? now : null}::timestamptz,
          ${notificationId}::uuid
        )
      `;
    }),
  );

  return {
    published: true,
    recipientCount: recipientIds.length,
    notifiedCount: notifiedIds.length,
  };
}

/** Reach stats for an already-published announcement, straight off the recipient snapshot. */
export async function getAnnouncementReach(
  tx: TransactionSql,
  schoolId: string,
  announcementId: string,
): Promise<AnnouncementReach> {
  const [row] = await tx<{ recipient_count: number; notified_count: number }[]>`
    SELECT
      count(*)::int AS recipient_count,
      count(*) FILTER (WHERE notified_at IS NOT NULL)::int AS notified_count
    FROM app.announcement_recipients
    WHERE school_id = ${schoolId}::uuid AND announcement_id = ${announcementId}::uuid
  `;
  return { recipientCount: row?.recipient_count ?? 0, notifiedCount: row?.notified_count ?? 0 };
}
