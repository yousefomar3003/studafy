/**
 * Domain event names, `resource.pastTenseAction`. Distinct from permissions (which express
 * "may this role act") — events express "this already happened" and are what consumers
 * subscribe to (e.g. for notifications, webhooks, audit logging).
 */
export const DOMAIN_EVENTS = {
  USER_CREATED: "user.created",
  USER_SUSPENDED: "user.suspended",
  USER_INVITED: "user.invited",

  INVITATION_SENT: "invitation.sent",
  INVITATION_REVOKED: "invitation.revoked",

  SCHOOL_REGISTERED: "school.registered",
  SCHOOL_VERIFICATION_EMAIL_SENT: "school.verificationEmailSent",
  SCHOOL_EMAIL_VERIFIED: "school.emailVerified",
  SCHOOL_CREATED: "school.created",

  ORGANIZATION_CREATED: "organization.created",
  ORGANIZATION_UPDATED: "organization.updated",

  COURSE_CREATED: "course.created",
  COURSE_PUBLISHED: "course.published",
  COURSE_ARCHIVED: "course.archived",

  ENROLLMENT_CREATED: "enrollment.created",
  ENROLLMENT_APPROVED: "enrollment.approved",
  ENROLLMENT_CANCELLED: "enrollment.cancelled",

  ASSIGNMENT_PUBLISHED: "assignment.published",
  ASSIGNMENT_DEADLINE_EXTENDED: "assignment.deadlineExtended",

  SUBMISSION_CREATED: "submission.created",
  SUBMISSION_GRADED: "submission.graded",
  SUBMISSION_RESUBMISSION_REQUESTED: "submission.resubmissionRequested",

  DISCUSSION_POSTED: "discussion.posted",
  DISCUSSION_MODERATED: "discussion.moderated",

  MATERIAL_UPLOADED: "material.uploaded",
  MATERIAL_AI_ENABLED: "material.aiEnabled",
  MATERIAL_AI_DISABLED: "material.aiDisabled",

  STUDY_GROUP_CREATED: "studyGroup.created",
  STUDY_GROUP_JOINED: "studyGroup.joined",

  CERTIFICATE_ISSUED: "certificate.issued",
  CERTIFICATE_REVOKED: "certificate.revoked",

  EXAM_SCHEDULED: "exam.scheduled",
  EXAM_UPDATED: "exam.updated",
  EXAM_CANCELLED: "exam.cancelled",

  TIMETABLE_APPROVED: "timetable.approved",
  TIMETABLE_REJECTED: "timetable.rejected",

  // Grade workflow — submission lifecycle and visibility transitions.
  GRADES_SUBMITTED: "grades.submitted",
  GRADES_PUBLISHED: "grades.published",

  // Attendance alerting (ST-110). Raised by the alert worker once a student's absences cross a
  // school's configured threshold and the linked parents have been notified — so consumers see
  // the breach, not each individual absence.
  ATTENDANCE_ALERT_RAISED: "attendance.alertRaised",

  // Finance reconciliation (ST-122). Raised by the daily reconciliation job when an installment
  // passes its due date and remains unpaid — triggers parent notification via the outbox relay.
  FEE_INSTALLMENT_OVERDUE: "fee.installmentOverdue",
  // Raised when the reconciliation job detects a cache-vs-ERPNext divergence that persists after
  // a self-healing re-pull. Contains exact entity IDs for manual investigation.
  FINANCE_RECONCILIATION_DIVERGENCE: "finance.reconciliationDivergence",

  // Notification dispatch (ST-139). Raised when a dispatch job has exhausted every retry and been
  // dead-lettered, so an operator can be paged. Note the name is two segments, not three:
  // app.outbox_events.event_name carries a CHECK of `^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$`, and a
  // `notification.dispatch.failed` would be rejected at INSERT time — inside the very transaction
  // trying to record the failure, so the alert would be lost in production and nowhere else.
  NOTIFICATION_DISPATCH_FAILED: "notification.dispatchFailed",

  // ERPNext finance doc-events. Ingested via verified webhooks and written into app.outbox_events
  // by the API, then relayed by the outbox-relay worker like any other domain event.
  ERPNEXT_INVOICE_SUBMITTED: "erpnext.invoiceSubmitted",
  ERPNEXT_FEE_DUE: "erpnext.feeDue",
  ERPNEXT_PAYMENT_RECEIVED: "erpnext.paymentReceived",
  ERPNEXT_CREDIT_NOTE_ISSUED: "erpnext.creditNoteIssued",
  ERPNEXT_FEE_STRUCTURE_SUBMITTED: "erpnext.feeStructureSubmitted",
} as const;

/**
 * ERPNext webhook doc-events that map to outbox event names. The webhook ingestion layer uses
 * this to translate the external `doc_event` + `action` pair into an internal event_name.
 */
export const ERPNEXT_DOC_EVENT_MAP: Record<string, DomainEvent | undefined> = {
  "Sales Invoice-submitted": DOMAIN_EVENTS.ERPNEXT_INVOICE_SUBMITTED,
  "Fee Schedule-submitted": DOMAIN_EVENTS.ERPNEXT_FEE_DUE,
  "Payment Entry-submitted": DOMAIN_EVENTS.ERPNEXT_PAYMENT_RECEIVED,
  "Sales Invoice-return": DOMAIN_EVENTS.ERPNEXT_CREDIT_NOTE_ISSUED,
  // Fee Structure, not Fee Schedule: a structure is the priced template, a schedule is one dated
  // application of it. They are separate DocTypes and only the schedule was mapped before (ST-119).
  "Fee Structure-submitted": DOMAIN_EVENTS.ERPNEXT_FEE_STRUCTURE_SUBMITTED,
};

export type DomainEvent = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];
