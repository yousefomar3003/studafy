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
} as const;

export type DomainEvent = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];
