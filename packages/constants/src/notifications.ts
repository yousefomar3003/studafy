/**
 * User-facing notification kinds. A notification is a curated projection of some domain
 * events (see events.ts) — not every event produces a notification, so this is a distinct,
 * smaller set rather than a 1:1 mirror of DOMAIN_EVENTS.
 */
export const NOTIFICATION_TYPES = {
  ASSIGNMENT_DUE_SOON: "ASSIGNMENT_DUE_SOON",
  GRADE_POSTED: "GRADE_POSTED",
  ENROLLMENT_APPROVED: "ENROLLMENT_APPROVED",
  COURSE_PUBLISHED: "COURSE_PUBLISHED",
  DISCUSSION_REPLY: "DISCUSSION_REPLY",
  STUDY_GROUP_INVITE: "STUDY_GROUP_INVITE",
  CERTIFICATE_ISSUED: "CERTIFICATE_ISSUED",
  SUPPORT_MESSAGE: "SUPPORT_MESSAGE",
  // ST-110. Raised for a linked parent when a student's absences cross a school's configured
  // threshold. Mirrored in app.notification_type by migration 000057.
  ATTENDANCE_ALERT: "ATTENDANCE_ALERT",
  // ST-143. School-wide administrative notices (closures, policy changes, safety notices). Mirrored
  // in app.notification_type by migration 000082. The one type MANDATORY_NOTIFICATION_TYPES holds
  // today — see the constant below for why that makes it special. No sender exists yet; the type is
  // added ahead of its producer, the same order app.notifications itself was built in (see
  // docs/architecture/SAD_21_notification_dispatch_flow.md).
  ADMIN_ANNOUNCEMENT: "ADMIN_ANNOUNCEMENT",
  // Raised by the file-scan worker when ClamAV flags a confirmed material. Tells the uploader the
  // file was blocked and will never be served. Mirrored in app.notification_type by 000088.
  MATERIAL_SCAN_QUARANTINED: "MATERIAL_SCAN_QUARANTINED",
  // Raised by the file-scan worker when a material's scan could not be completed (ClamAV
  // unreachable, timeout, scan error) and its retries were exhausted. Fail-closed alert: the
  // material is marked failed, never available. Mirrored in app.notification_type by 000088.
  MATERIAL_SCAN_FAILED: "MATERIAL_SCAN_FAILED",
} as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

/**
 * Notification types a user cannot opt out of on any channel. Enforced twice: the notification
 * preferences API rejects a write that would set `enabled = false` for one of these
 * (apps/api/src/modules/notifications/notification-preferences-service.ts), and
 * ck_notification_preferences_mandatory_enabled (migration 000083) makes the same rule true at the
 * database's arbiter of record, so a row cannot exist with `enabled = false` for these regardless of
 * how it was written. The two lists must be kept in lockstep, the same way app.notification_type
 * itself mirrors this file label-for-label.
 *
 * Empty until ADMIN_ANNOUNCEMENT existed to put in it — see URGENT_NOTIFICATION_TYPES in
 * apps/workers/src/queues/notifications/quiet-hours.ts for the same "empty is a deliberate answer"
 * shape applied to a different question.
 */
export const MANDATORY_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set([
  NOTIFICATION_TYPES.ADMIN_ANNOUNCEMENT,
]);

/**
 * Notification types a user may route to email as a batched digest instead of an immediate send.
 *
 * A property of the type, not the channel or the user: whether a delay is tolerable is a fact about
 * what the notification means, the same reasoning URGENT_NOTIFICATION_TYPES applies to quiet hours.
 * Deadline- and status-critical types are excluded on purpose — ASSIGNMENT_DUE_SOON is a deadline
 * reminder a digest could deliver after the deadline, GRADE_POSTED/ENROLLMENT_APPROVED/
 * CERTIFICATE_ISSUED/SUPPORT_MESSAGE are individually significant results a recipient is actively
 * waiting on, and ADMIN_ANNOUNCEMENT is mandatory and therefore always immediate. ATTENDANCE_ALERT is
 * included because a parent digest already exists for it (apps/workers/.../email/digest-producer.ts);
 * the other three are lower-stakes social/catalog updates.
 *
 * Mirrored in ck_notification_preferences_digest_eligible (migration 000083) for the same
 * lockstep reason MANDATORY_NOTIFICATION_TYPES is.
 *
 * This only records which types *may* be marked for digest delivery, and the notification
 * preferences API persists that choice. Whether the wider dispatch pipeline honors it for anything
 * beyond the two events digest-producer.ts already aggregates is a separate, later piece of work.
 */
export const DIGEST_ELIGIBLE_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set([
  NOTIFICATION_TYPES.DISCUSSION_REPLY,
  NOTIFICATION_TYPES.STUDY_GROUP_INVITE,
  NOTIFICATION_TYPES.COURSE_PUBLISHED,
  NOTIFICATION_TYPES.ATTENDANCE_ALERT,
]);
