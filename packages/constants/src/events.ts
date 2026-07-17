/**
 * Domain event names, `resource.pastTenseAction`. Distinct from permissions (which express
 * "may this role act") — events express "this already happened" and are what consumers
 * subscribe to (e.g. for notifications, webhooks, audit logging).
 */
export const DOMAIN_EVENTS = {
  USER_CREATED: "user.created",
  USER_SUSPENDED: "user.suspended",
  USER_INVITED: "user.invited",

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

  STUDY_GROUP_CREATED: "studyGroup.created",
  STUDY_GROUP_JOINED: "studyGroup.joined",

  CERTIFICATE_ISSUED: "certificate.issued",
  CERTIFICATE_REVOKED: "certificate.revoked",

  // ERPNext finance doc-events. Ingested via verified webhooks and written into app.outbox_events
  // by the API, then relayed by the outbox-relay worker like any other domain event.
  ERPNEXT_INVOICE_SUBMITTED: "erpnext.invoiceSubmitted",
  ERPNEXT_FEE_DUE: "erpnext.feeDue",
  ERPNEXT_PAYMENT_RECEIVED: "erpnext.paymentReceived",
  ERPNEXT_CREDIT_NOTE_ISSUED: "erpnext.creditNoteIssued",
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
};

export type DomainEvent = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];
