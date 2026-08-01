import { DOMAIN_EVENTS, SUBSCRIPTION_STATUSES, type DomainEvent } from "@studafy/constants";
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

  // ── School ───────────────────────────────────────────────────────────
  [DOMAIN_EVENTS.SCHOOL_REGISTERED]: z.object({
    schoolId: uid,
    adminUserId: uid,
    email: z.string().email(),
    slug: z.string(),
  }),
  [DOMAIN_EVENTS.SCHOOL_VERIFICATION_EMAIL_SENT]: z.object({
    schoolId: uid,
    email: z.string().email(),
    expiresAt: z.string().datetime(),
    // The one-time verification token, so the email dispatcher can build the verify link. The raw
    // token normally exists only in the API response; the outbox is the one other place the same
    // bearer credential must travel, because the email is sent asynchronously from this event.
    token: z.string().min(1),
  }),
  [DOMAIN_EVENTS.SCHOOL_EMAIL_VERIFIED]: z.object({
    schoolId: uid,
    email: z.string().email(),
    slug: z.string(),
  }),
  [DOMAIN_EVENTS.SCHOOL_CREATED]: z.object({
    schoolId: uid,
    slug: z.string(),
    name: z.string(),
    countryId: uid,
    defaultCurrencyId: uid,
  }),

  // ── Invitation ────────────────────────────────────────────────────────
  [DOMAIN_EVENTS.INVITATION_SENT]: z.object({
    invitationId: uid,
    email: z.string().email(),
    role: z.string(),
    expiresAt: z.string().datetime(),
    invitedByUserId: uid.nullable(),
    // The one-time invitation token, so the email dispatcher can build the accept link. The raw
    // token normally exists only in the API response; the outbox is the one other place the same
    // bearer credential must travel, because the email is sent asynchronously from this event.
    token: z.string().min(1),
  }),
  [DOMAIN_EVENTS.INVITATION_REVOKED]: z.object({
    invitationId: uid,
    email: z.string().email(),
    role: z.string(),
  }),

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

  // ── Materials ─────────────────────────────────────────────────────────
  [DOMAIN_EVENTS.MATERIAL_UPLOADED]: z.object({
    materialId: uid,
    classId: uid,
  }),
  [DOMAIN_EVENTS.MATERIAL_AI_ENABLED]: z.object({ materialId: uid }),
  [DOMAIN_EVENTS.MATERIAL_AI_DISABLED]: z.object({ materialId: uid }),

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

  // ── Attendance ────────────────────────────────────────────────────────
  // One event per breach, not per notified parent: consumers care that the threshold was crossed,
  // and the recipient list is a property of that fact rather than a separate occurrence.
  [DOMAIN_EVENTS.ATTENDANCE_ALERT_RAISED]: z.object({
    studentId: uid,
    ruleType: z.enum(["consecutive_days", "period_count"]),
    thresholdValue: z.number().int().positive(),
    absentDays: z.number().int().positive(),
    boundaryDate: z.string().date(),
    parentUserIds: z.array(uid),
  }),

  // ── Digest ────────────────────────────────────────────────────────────
  // One event per parent per digest run, produced by the workers digest producer from the
  // parent-facing outbox events that accumulated since the previous run. It carries everything
  // the email dispatcher needs to render, so the producer owns the aggregation and the channel
  // stays a dumb renderer.
  [DOMAIN_EVENTS.DIGEST_SENT]: z.object({
    parentUserId: uid,
    email: z.string().email(),
    digestDate: z.string().date(),
    items: z
      .array(
        z.object({
          kind: z.enum(["attendance_alert", "fee_overdue"]),
          studentName: z.string().nullable(),
          text: z.string().min(1),
          occurredAt: z.string().datetime(),
        }),
      )
      .min(1),
  }),

  // ── Timetable ───────────────────────────────────────────────────────
  [DOMAIN_EVENTS.TIMETABLE_APPROVED]: z.object({
    timetableVersionId: uid,
    termId: uid,
    approvedByUserId: uid,
    slotCount: z.number().int(),
  }),
  [DOMAIN_EVENTS.TIMETABLE_REJECTED]: z.object({
    timetableVersionId: uid,
    termId: uid,
    rejectedReason: z.string(),
  }),

  // ── Exam ───────────────────────────────────────────────────────────
  [DOMAIN_EVENTS.EXAM_SCHEDULED]: z.object({
    examId: uid,
    classId: uid,
    scheduledByUserId: uid,
  }),
  [DOMAIN_EVENTS.EXAM_UPDATED]: z.object({
    examId: uid,
    classId: uid,
    updatedByUserId: uid,
  }),
  [DOMAIN_EVENTS.EXAM_CANCELLED]: z.object({
    examId: uid,
    classId: uid,
  }),

  // ── Grade workflow ────────────────────────────────────────────────
  [DOMAIN_EVENTS.GRADES_SUBMITTED]: z.object({
    submissionId: uid,
    gradebookId: uid,
    studentId: uid,
  }),
  [DOMAIN_EVENTS.GRADES_PUBLISHED]: z.object({
    submissionId: uid,
    gradebookId: uid,
    studentId: uid,
    approvedByUserId: uid,
  }),

  // ── Finance reconciliation (ST-122) ────────────────────────────────
  [DOMAIN_EVENTS.FEE_INSTALLMENT_OVERDUE]: z.object({
    studentId: uid,
    scheduleId: uid,
    dueDate: z.string().date(),
    outstandingAmountMinor: z.number().int(),
  }),
  [DOMAIN_EVENTS.FINANCE_RECONCILIATION_DIVERGENCE]: z.object({
    schoolId: uid,
    studentId: uid,
    erpnextFeeScheduleId: z.string(),
    erpnextOutstanding: z.number(),
    localOutstanding: z.number(),
  }),

  // ── Notification dispatch (ST-139) ────────────────────────────────
  // Correlation handles only. The error message and stack live in app.notification_dead_letters,
  // which is tenant-isolated; this payload is published verbatim onto the Redis pub/sub channel
  // `events:{school_id}:{event_name}` with no redaction, and outbox rows are never reaped — so a
  // dispatch stack (recipient addresses, provider request ids) must not travel in it. A consumer
  // that needs detail follows deadLetterId into the table.
  [DOMAIN_EVENTS.NOTIFICATION_DISPATCH_FAILED]: z.object({
    deadLetterId: uid,
    jobId: z.string(),
    jobName: z.string(),
    queueName: z.string(),
    attemptsMade: z.number().int().positive(),
    errorClass: z.string().max(200),
    failedAt: z.string(),
  }),

  // ── Subscription state transitions (ST-133) ───────────────────────
  // Emitted by the billing state machine inside the transaction that applies the status change.
  //
  // Correlation handles and enum values only — no plan names, no amounts, no customer identifiers.
  // Like NOTIFICATION_DISPATCH_FAILED above, these are published verbatim onto the Redis pub/sub
  // channel `events:{school_id}:{event_name}` with no redaction, and outbox rows are never reaped.
  //
  // entitlementsVersion is the value the emitting transaction's version bump returned. It is what
  // makes invalidation version-guarded rather than a blind DEL: a consumer that arrives out of order
  // can refuse to move the cached version backwards, and the JWT middleware sees the new version the
  // moment the cache is written rather than waiting for someone to re-resolve from Postgres. The
  // `>= 2` floor mirrors ck_entitlement_versions_version — an absent row is version 1, so the first
  // persisted bump is 2 and no event can ever carry the genesis value.
  [DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED]: z.object({
    schoolId: uid,
    subscriptionId: uid,
    previousStatus: z.enum(SUBSCRIPTION_STATUSES),
    status: z.enum(SUBSCRIPTION_STATUSES),
    entitlementsVersion: z.number().int().min(2),
  }),
  [DOMAIN_EVENTS.AI_SUBSCRIPTION_STATUS_CHANGED]: z.object({
    schoolId: uid,
    studentId: uid,
    aiSubscriptionId: uid,
    previousStatus: z.enum(SUBSCRIPTION_STATUSES),
    status: z.enum(SUBSCRIPTION_STATUSES),
    entitlementsVersion: z.number().int().min(2),
  }),

  // ── ERPNext (freeform — external system payloads) ─────────────────────
  [DOMAIN_EVENTS.ERPNEXT_INVOICE_SUBMITTED]: z.record(z.string(), z.unknown()),
  [DOMAIN_EVENTS.ERPNEXT_FEE_DUE]: z.record(z.string(), z.unknown()),
  [DOMAIN_EVENTS.ERPNEXT_PAYMENT_RECEIVED]: z.record(z.string(), z.unknown()),
  [DOMAIN_EVENTS.ERPNEXT_CREDIT_NOTE_ISSUED]: z.record(z.string(), z.unknown()),
  [DOMAIN_EVENTS.ERPNEXT_FEE_STRUCTURE_SUBMITTED]: z.record(z.string(), z.unknown()),
} as const;

/**
 * Compile-time payload type for each domain event. Derived from the Zod schemas so there's
 * exactly one source of truth.
 */
export type EventPayloadMap = {
  [K in DomainEvent]: z.infer<(typeof eventPayloadSchemas)[K]>;
};
