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
} as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];
