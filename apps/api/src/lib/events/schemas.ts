import { DOMAIN_EVENTS, type DomainEvent } from "@studafy/constants";
import { z } from "zod";

const uid = z.string().uuid();

/**
 * Per-event payload schemas. Single source of truth: the `EventPayloadMap` type is derived from
 * these via `z.infer`, so callers get compile-time payload checking without a separate type
 * definition.
 */
export const eventPayloadSchemas = {
  // ── User ──────────────────────────────────────────────────────────────
  [DOMAIN_EVENTS.USER_CREATED]: z.object({ userId: uid }),
  [DOMAIN_EVENTS.USER_SUSPENDED]: z.object({ userId: uid }),
  [DOMAIN_EVENTS.USER_INVITED]: z.object({ userId: uid }),

  // ── Organization ──────────────────────────────────────────────────────
  [DOMAIN_EVENTS.ORGANIZATION_CREATED]: z.object({ organizationId: uid }),
  [DOMAIN_EVENTS.ORGANIZATION_UPDATED]: z.object({ organizationId: uid }),

  // ── Course ────────────────────────────────────────────────────────────
  [DOMAIN_EVENTS.COURSE_CREATED]: z.object({ courseId: uid }),
  [DOMAIN_EVENTS.COURSE_PUBLISHED]: z.object({ courseId: uid }),
  [DOMAIN_EVENTS.COURSE_ARCHIVED]: z.object({ courseId: uid }),

  // ── Enrollment ────────────────────────────────────────────────────────
  [DOMAIN_EVENTS.ENROLLMENT_CREATED]: z.object({
    enrollmentId: uid,
    courseId: uid,
    studentId: uid,
  }),
  [DOMAIN_EVENTS.ENROLLMENT_APPROVED]: z.object({
    enrollmentId: uid,
    courseId: uid,
    studentId: uid,
  }),
  [DOMAIN_EVENTS.ENROLLMENT_CANCELLED]: z.object({
    enrollmentId: uid,
    courseId: uid,
    studentId: uid,
  }),

  // ── Assignment ────────────────────────────────────────────────────────
  [DOMAIN_EVENTS.ASSIGNMENT_PUBLISHED]: z.object({
    assignmentId: uid,
    courseId: uid,
  }),
  [DOMAIN_EVENTS.ASSIGNMENT_DEADLINE_EXTENDED]: z.object({
    assignmentId: uid,
    courseId: uid,
  }),

  // ── Submission ────────────────────────────────────────────────────────
  [DOMAIN_EVENTS.SUBMISSION_CREATED]: z.object({
    submissionId: uid,
    assignmentId: uid,
    studentId: uid,
  }),
  [DOMAIN_EVENTS.SUBMISSION_GRADED]: z.object({
    submissionId: uid,
    assignmentId: uid,
    studentId: uid,
  }),
  [DOMAIN_EVENTS.SUBMISSION_RESUBMISSION_REQUESTED]: z.object({
    submissionId: uid,
    assignmentId: uid,
    studentId: uid,
  }),

  // ── Discussion ────────────────────────────────────────────────────────
  [DOMAIN_EVENTS.DISCUSSION_POSTED]: z.object({ discussionId: uid }),
  [DOMAIN_EVENTS.DISCUSSION_MODERATED]: z.object({ discussionId: uid }),

  // ── Study Group ───────────────────────────────────────────────────────
  [DOMAIN_EVENTS.STUDY_GROUP_CREATED]: z.object({ groupId: uid }),
  [DOMAIN_EVENTS.STUDY_GROUP_JOINED]: z.object({ groupId: uid }),

  // ── Certificate ───────────────────────────────────────────────────────
  [DOMAIN_EVENTS.CERTIFICATE_ISSUED]: z.object({
    certificateId: uid,
    studentId: uid,
  }),
  [DOMAIN_EVENTS.CERTIFICATE_REVOKED]: z.object({
    certificateId: uid,
    studentId: uid,
  }),

  // ── ERPNext (freeform — external system payloads) ─────────────────────
  [DOMAIN_EVENTS.ERPNEXT_INVOICE_SUBMITTED]: z.record(z.string(), z.unknown()),
  [DOMAIN_EVENTS.ERPNEXT_FEE_DUE]: z.record(z.string(), z.unknown()),
  [DOMAIN_EVENTS.ERPNEXT_PAYMENT_RECEIVED]: z.record(z.string(), z.unknown()),
  [DOMAIN_EVENTS.ERPNEXT_CREDIT_NOTE_ISSUED]: z.record(z.string(), z.unknown()),
} as const;

/**
 * Compile-time payload type for each domain event. Derived from the Zod schemas so there's
 * exactly one source of truth.
 */
export type EventPayloadMap = {
  [K in DomainEvent]: z.infer<(typeof eventPayloadSchemas)[K]>;
};
