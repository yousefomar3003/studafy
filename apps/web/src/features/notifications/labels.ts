import { NOTIFICATION_TYPES } from "@studafy/constants";
import { NOTIFICATION_CHANNELS } from "@studafy/notification-templates";

import type { NotificationType } from "@studafy/constants";
import type { NotificationChannel } from "@studafy/notification-templates";

// Maps (not plain objects), same reasoning `billing/labels.ts`'s STATUS_LABEL gives: a wire string
// can never resolve a prototype member off a Map, only off a plain object.

const NOTIFICATION_TYPE_LABEL = new Map<NotificationType, string>([
  [NOTIFICATION_TYPES.ASSIGNMENT_DUE_SOON, "Assignment due soon"],
  [NOTIFICATION_TYPES.GRADE_POSTED, "Grade posted"],
  [NOTIFICATION_TYPES.ENROLLMENT_APPROVED, "Enrollment approved"],
  [NOTIFICATION_TYPES.COURSE_PUBLISHED, "Course published"],
  [NOTIFICATION_TYPES.DISCUSSION_REPLY, "Discussion reply"],
  [NOTIFICATION_TYPES.STUDY_GROUP_INVITE, "Study group invite"],
  [NOTIFICATION_TYPES.CERTIFICATE_ISSUED, "Certificate issued"],
  [NOTIFICATION_TYPES.SUPPORT_MESSAGE, "Support message"],
  [NOTIFICATION_TYPES.ATTENDANCE_ALERT, "Attendance alert"],
  [NOTIFICATION_TYPES.ADMIN_ANNOUNCEMENT, "School announcement"],
  [NOTIFICATION_TYPES.ANNOUNCEMENT, "Announcement"],
  [NOTIFICATION_TYPES.MATERIAL_SCAN_QUARANTINED, "Material blocked by security scan"],
  [NOTIFICATION_TYPES.MATERIAL_SCAN_FAILED, "Material scan failed"],
  [NOTIFICATION_TYPES.MATERIAL_OCR_LOW_CONFIDENCE, "Material text quality warning"],
  [NOTIFICATION_TYPES.MATERIAL_INGESTED, "Material ready for AI search"],
  [NOTIFICATION_TYPES.MATERIAL_INGEST_FAILED, "Material processing failed"],
]);

/** Falls back to the raw wire value for a type this map hasn't been kept in lockstep with yet,
 * rather than rendering nothing. */
export function notificationTypeLabel(type: string): string {
  return NOTIFICATION_TYPE_LABEL.get(type as NotificationType) ?? type;
}

const NOTIFICATION_CHANNEL_LABEL = new Map<NotificationChannel, string>([
  [NOTIFICATION_CHANNELS.IN_APP, "In-app"],
  [NOTIFICATION_CHANNELS.PUSH, "Push"],
  [NOTIFICATION_CHANNELS.EMAIL, "Email"],
]);

export function notificationChannelLabel(channel: string): string {
  return NOTIFICATION_CHANNEL_LABEL.get(channel as NotificationChannel) ?? channel;
}
