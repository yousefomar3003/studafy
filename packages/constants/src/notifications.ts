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
  // ST-194. The non-mandatory sibling of ADMIN_ANNOUNCEMENT: a school/role/class-targeted notice a
  // recipient *can* disable via notification preferences, unlike ADMIN_ANNOUNCEMENT. Exists because
  // ADMIN_ANNOUNCEMENT is the platform's only MANDATORY_NOTIFICATION_TYPES entry — routing every
  // announcement through it would make the compose UI's "mandatory" toggle a no-op. Mirrored in
  // app.notification_type by migration 000104. Sent by apps/api/src/modules/announcements (the first
  // real producer of either announcement type).
  ANNOUNCEMENT: "ANNOUNCEMENT",
  // Raised by the file-scan worker when ClamAV flags a confirmed material. Tells the uploader the
  // file was blocked and will never be served. Mirrored in app.notification_type by 000088.
  MATERIAL_SCAN_QUARANTINED: "MATERIAL_SCAN_QUARANTINED",
  // Raised by the file-scan worker when a material's scan could not be completed (ClamAV
  // unreachable, timeout, scan error) and its retries were exhausted. Fail-closed alert: the
  // material is marked failed, never available. Mirrored in app.notification_type by 000088.
  MATERIAL_SCAN_FAILED: "MATERIAL_SCAN_FAILED",
  // Raised by the ai-ingestion worker when an OCR'd material has pages whose mean per-word
  // confidence fell below the flagging threshold. Tells the uploader (usually the teacher) which
  // pages to review before trusting the transcription. Mirrored in app.notification_type by 000090.
  MATERIAL_OCR_LOW_CONFIDENCE: "MATERIAL_OCR_LOW_CONFIDENCE",
  // Raised by the ai-ingestion worker when a material finished ingestion and is ready for AI
  // search. Tells the uploader (usually the teacher) their material is live. Mirrored in
  // app.notification_type by 000096.
  MATERIAL_INGESTED: "MATERIAL_INGESTED",
  // Raised by the ai-ingestion worker when a material's ingestion could not be completed (parse,
  // OCR, chunk or embed failure) and its retries were exhausted. The material is marked failed
  // and never available; the uploader is told it is not searchable and can re-ingest. Mirrored
  // in app.notification_type by 000096.
  MATERIAL_INGEST_FAILED: "MATERIAL_INGEST_FAILED",
  // Raised by apps/api/src/modules/messaging for the other participant when a parent or teacher
  // sends a message in a parent<->teacher thread. Metadata carries the thread's conversation_id.
  // Optional (a recipient may disable it) and immediate-only. Mirrored in app.notification_type by
  // migration 000126.
  DIRECT_MESSAGE: "DIRECT_MESSAGE",
  // Fee notices to a student's guardians, written by apps/api/src/modules/finance/communications.
  // The first two are automatic (from ERPNext's invoice and payment webhooks), the last two are sent
  // by finance from a family's page. Every one is optional and immediate-only, and
  // app.finance_communications (000153) keeps each to a single send. Mirrored in
  // app.notification_type by migration 000152.
  FEE_INVOICE_ISSUED: "FEE_INVOICE_ISSUED",
  FEE_PAYMENT_RECEIVED: "FEE_PAYMENT_RECEIVED",
  FEE_PAYMENT_REMINDER: "FEE_PAYMENT_REMINDER",
  FEE_STATEMENT: "FEE_STATEMENT",
  // A student, teacher or parent with an App Store subscription received a school seat that covers
  // it. Apple renewals cannot be stopped from our server, so this tells them how to turn renewal off
  // themselves (docs/billing/feature-licensing.md). Optional and immediate-only. Written by
  // apps/api/src/modules/licensing; mirrored in app.notification_type by migration 000164.
  LICENSE_SEAT_APPLE_RENEWAL: "LICENSE_SEAT_APPLE_RENEWAL",
  // License billing reminders (session 3), written in-app by the workers' license reminder job to the
  // super admins and the school's admins and principals: a license ending in 30 and in 7 days, an
  // invoice due today, an invoice overdue; and to the super admins, a transfer receipt the school
  // uploaded. Optional and immediate-only; app.license_reminders keeps each to one send. Mirrored in
  // app.notification_type by migration 000166.
  LICENSE_EXPIRING: "LICENSE_EXPIRING",
  LICENSE_INVOICE_DUE: "LICENSE_INVOICE_DUE",
  LICENSE_INVOICE_OVERDUE: "LICENSE_INVOICE_OVERDUE",
  LICENSE_RECEIPT_UPLOADED: "LICENSE_RECEIPT_UPLOADED",
  // A licence paid in instalments stops covering its AI seats once an instalment is unpaid
  // LICENSE_NONPAYMENT_GRACE_DAYS after its due date (000233): a warning 7 days before that cutoff,
  // and a notice when the AI stops. Same recipients and delivery as the reminders above (in-app and
  // push, never emailed). Mirrored in app.notification_type by migration 000233.
  LICENSE_AI_STOP_WARNING: "LICENSE_AI_STOP_WARNING",
  LICENSE_AI_STOPPED: "LICENSE_AI_STOPPED",
  // Everyday school events, written by the workers' outbox notify consumer
  // (apps/workers/src/queues/notifications/school-events.ts): an assignment published (to the class's
  // students and their parents), a hand-in's mark released (to that student and their parents), and a
  // submitted register marking a student absent or late (to their parents). Optional and
  // immediate-only. Mirrored in app.notification_type by migration 000215.
  ASSIGNMENT_PUBLISHED: "ASSIGNMENT_PUBLISHED",
  ASSIGNMENT_GRADED: "ASSIGNMENT_GRADED",
  ATTENDANCE_MARKED: "ATTENDANCE_MARKED",
  // A class material became visible to its students: written by the same outbox notify consumer
  // from material.published, which app.materials' trg_materials_published raises the first time a
  // material turns `ready` (000228). To the class's active students only -- parents have no
  // materials screen to open. Optional, immediate-only and never emailed. Mirrored in
  // app.notification_type by migration 000228.
  MATERIAL_PUBLISHED: "MATERIAL_PUBLISHED",
  // Academic marks were released to the family: written by the same outbox notify consumer from
  // marks.released (a whole period's mark sheet, or one assessment, approved by leadership). To the
  // student and their linked parents. Optional, immediate-only and never emailed. Mirrored in
  // app.notification_type by migration 000230.
  MARKS_RELEASED: "MARKS_RELEASED",
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
 *
 * ANNOUNCEMENT is deliberately absent: it is ADMIN_ANNOUNCEMENT's non-mandatory sibling (ST-194),
 * the database constraint ck_notification_preferences_mandatory_enabled (migration 000083) only
 * names ADMIN_ANNOUNCEMENT — so ANNOUNCEMENT staying out of this set matches the database exactly,
 * not by oversight.
 */
export const MANDATORY_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set([
  NOTIFICATION_TYPES.ADMIN_ANNOUNCEMENT,
]);
