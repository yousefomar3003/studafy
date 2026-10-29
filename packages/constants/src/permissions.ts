import { ROLES, type Role } from "./roles";

/**
 * Full permission matrix, `resource:action`. This is the single source of truth for
 * authorization checks across the platform — see docs/adr/0002-fixed-roles-authorization.md.
 * The generated permission-matrix doc (docs/permission-matrix.md) is derived from this file
 * and ROLE_PERMISSIONS below; never hand-duplicate this list elsewhere.
 */
export const PERMISSIONS = {
  USER_CREATE: "user:create",
  USER_READ: "user:read",
  USER_UPDATE: "user:update",
  USER_DELETE: "user:delete",
  USER_INVITE: "user:invite",
  USER_SUSPEND: "user:suspend",
  USER_IMPERSONATE: "user:impersonate",

  ROLE_READ: "role:read",
  ROLE_ASSIGN: "role:assign",
  ROLE_REVOKE: "role:revoke",

  ORGANIZATION_CREATE: "organization:create",
  ORGANIZATION_READ: "organization:read",
  ORGANIZATION_UPDATE: "organization:update",
  ORGANIZATION_DELETE: "organization:delete",
  // Closing one's own school (POST /api/schools/current/closure): the school is archived, every
  // member is signed out and can no longer sign in, and all data is retained. Distinct from
  // `organization:delete`, which is the platform's (SUPER_ADMIN) cross-tenant power; this one is
  // the school admin acting on their own tenant.
  ORGANIZATION_CLOSE: "organization:close",
  ORGANIZATION_MANAGE_SETTINGS: "organization:manageSettings",
  ORGANIZATION_MANAGE_BILLING: "organization:manageBilling",

  COURSE_CREATE: "course:create",
  COURSE_READ: "course:read",
  COURSE_UPDATE: "course:update",
  COURSE_DELETE: "course:delete",
  COURSE_PUBLISH: "course:publish",
  COURSE_ARCHIVE: "course:archive",
  COURSE_DUPLICATE: "course:duplicate",
  COURSE_MANAGE_ENROLLMENT: "course:manageEnrollment",

  LESSON_CREATE: "lesson:create",
  LESSON_READ: "lesson:read",
  LESSON_UPDATE: "lesson:update",
  LESSON_DELETE: "lesson:delete",
  LESSON_PUBLISH: "lesson:publish",
  LESSON_REORDER: "lesson:reorder",

  ENROLLMENT_CREATE: "enrollment:create",
  ENROLLMENT_READ: "enrollment:read",
  ENROLLMENT_UPDATE: "enrollment:update",
  ENROLLMENT_DELETE: "enrollment:delete",
  ENROLLMENT_APPROVE: "enrollment:approve",
  ENROLLMENT_CANCEL: "enrollment:cancel",

  ASSIGNMENT_CREATE: "assignment:create",
  ASSIGNMENT_READ: "assignment:read",
  ASSIGNMENT_UPDATE: "assignment:update",
  ASSIGNMENT_DELETE: "assignment:delete",
  ASSIGNMENT_PUBLISH: "assignment:publish",
  ASSIGNMENT_EXTEND_DEADLINE: "assignment:extendDeadline",

  SUBMISSION_CREATE: "submission:create",
  SUBMISSION_READ: "submission:read",
  SUBMISSION_UPDATE: "submission:update",
  SUBMISSION_DELETE: "submission:delete",
  SUBMISSION_GRADE: "submission:grade",
  SUBMISSION_REQUEST_RESUBMISSION: "submission:requestResubmission",

  GRADE_READ: "grade:read",
  GRADE_UPDATE: "grade:update",
  GRADE_EXPORT: "grade:export",
  GRADE_OVERRIDE: "grade:override",

  DISCUSSION_CREATE: "discussion:create",
  DISCUSSION_READ: "discussion:read",
  DISCUSSION_UPDATE: "discussion:update",
  DISCUSSION_DELETE: "discussion:delete",
  DISCUSSION_MODERATE: "discussion:moderate",
  DISCUSSION_PIN: "discussion:pin",

  NOTIFICATION_READ: "notification:read",
  NOTIFICATION_SEND: "notification:send",
  NOTIFICATION_MANAGE: "notification:manage",
  NOTIFICATION_DELETE: "notification:delete",

  BILLING_READ: "billing:read",
  BILLING_UPDATE: "billing:update",
  BILLING_REFUND: "billing:refund",
  BILLING_VIEW_INVOICES: "billing:viewInvoices",
  // Approving, rejecting and revoking a student's scholarship award. Finance requests an award with
  // `billing:update`; only school leadership (ORG_ADMIN) decides it, the same split as refunds.
  BILLING_APPROVE_SCHOLARSHIP: "billing:approveScholarship",

  REPORT_READ: "report:read",
  REPORT_EXPORT: "report:export",
  REPORT_VIEW_FINANCIAL: "report:viewFinancial",

  APPROVAL_REVIEW: "approval:review",

  // Opening the school-leadership dashboard (/portal/principal and its discipline, attendance and
  // evaluation pages). Split out from `organization:manageSettings` so a PRINCIPAL reaches those
  // pages without also getting the ops-facing admin console (users, invitations, settings).
  PRINCIPAL_DASHBOARD_VIEW: "principalDashboard:view",

  // Opening the attendance dashboard (/portal/attendance): today's numbers, register progress,
  // students at risk, trends and per-student attendance, each within the caller's row scope (a
  // teacher sees their own classes). Taking registers on top of that needs attendance:record:create,
  // which the ATTENDANCE_OFFICER and INSTRUCTOR hold. Its own permission so a role gets the dashboard
  // without the principal dashboard (grades, approvals, discipline, evaluations) or the admin console.
  ATTENDANCE_DASHBOARD_VIEW: "attendanceDashboard:view",

  // The school calendar's own entries (app.school_events: holidays, events, meetings, exam periods).
  // Terms and exams appear on the calendar too, but under their own academics permissions.
  CALENDAR_EVENT_READ: "calendarEvent:read",
  CALENDAR_EVENT_MANAGE: "calendarEvent:manage",

  // Parent<->teacher 1-to-1 messaging (apps/api/src/modules/messaging, migration 000127). Holding
  // these is only the floor: the database limits every thread to its two participants, and a parent
  // may open one only about a linked child with a teacher who teaches that child.
  MESSAGE_READ: "message:read",
  MESSAGE_SEND: "message:send",
  // Working the school's queue of messaging reports (a participant reporting a message or the other
  // participant, migration 000136): reading the report and its evidence snapshot, and resolving it.
  // A safeguarding duty, so school leadership only -- ORG_ADMIN (and SUPER_ADMIN) automatically,
  // PRINCIPAL explicitly. Mirrored in the database by app.current_user_can_review_message_reports().
  MESSAGE_REPORT_REVIEW: "messageReport:review",

  // Building and publishing the weekly timetable (versions, slots, school days). Reading the live
  // timetable stays open to every authenticated school member -- teachers and students need it.
  TIMETABLE_MANAGE: "timetable:manage",

  // Academic grading configuration (migration 000160), per academic year: grade programs, subject
  // grading rules and their section overrides, assessments, grading scales and teacher subject
  // assignments. Teaching staff read the rules they grade by; school leadership changes them.
  ACADEMIC_CONFIG_READ: "academicConfig:read",
  ACADEMIC_CONFIG_MANAGE: "academicConfig:manage",
  // Finalizing a section's term or annual results and correcting finalized results. Leadership only.
  RESULT_FINALIZE: "result:finalize",
  // Issuing, reissuing and revoking school report cards and certificates from finalized results.
  // Distinct from CERTIFICATE_*, which are course-completion certificates a teacher may issue.
  ACADEMIC_CERTIFICATE_ISSUE: "academicCertificate:issue",

  // The Studafy platform console (/portal/platform): every school on the platform, their lifecycle,
  // per-school feature flags, plans and platform settings. Cross-tenant by nature, so held by
  // SUPER_ADMIN alone -- deliberately excluded from ORG_ADMIN, which runs one school, not Studafy.
  PLATFORM_READ: "platform:read",
  PLATFORM_MANAGE: "platform:manage",

  // The school's own feature license (docs/billing/feature-licensing.md): reading its tiers, seats and
  // usage, and assigning seats to the school's students, teachers and parents. The license itself --
  // tiers, seat counts, dates, status -- is the super admin's (platform:manage); a school can only
  // request a change.
  LICENSE_READ: "license:read",
  LICENSE_MANAGE: "license:manage",

  AUDIT_LOG_READ: "auditLog:read",
  AUDIT_LOG_EXPORT: "auditLog:export",

  // GDPR data subject requests (ST-268): filing and reading the export/erasure pipeline for one
  // user. Deliberately not granted to FINANCE (which reads AUDIT_LOG_* for billing recovery, not to
  // erase anyone) or SUPPORT_AGENT -- a DSR is an ORG_ADMIN/SUPER_ADMIN decision, not a read-only
  // support lookup.
  PRIVACY_DSR_MANAGE: "privacy:manageDsr",

  API_KEY_CREATE: "apiKey:create",
  API_KEY_READ: "apiKey:read",
  API_KEY_REVOKE: "apiKey:revoke",

  STUDY_GROUP_CREATE: "studyGroup:create",
  STUDY_GROUP_READ: "studyGroup:read",
  STUDY_GROUP_UPDATE: "studyGroup:update",
  STUDY_GROUP_DELETE: "studyGroup:delete",
  STUDY_GROUP_JOIN: "studyGroup:join",
  STUDY_GROUP_MODERATE: "studyGroup:moderate",

  QUIZ_CREATE: "quiz:create",
  QUIZ_READ: "quiz:read",
  QUIZ_UPDATE: "quiz:update",
  QUIZ_DELETE: "quiz:delete",
  QUIZ_PUBLISH: "quiz:publish",
  QUIZ_GRADE: "quiz:grade",

  CERTIFICATE_ISSUE: "certificate:issue",
  CERTIFICATE_READ: "certificate:read",
  CERTIFICATE_REVOKE: "certificate:revoke",

  STUDENT_CREATE: "student:create",
  STUDENT_READ: "student:read",
  STUDENT_UPDATE: "student:update",
  STUDENT_IMPORT: "student:import",
  // School-defined student and parent records (docs/modules/student-records.md). Building the
  // templates is separate from filling them in, and reading a sensitive value in full is separate
  // again: it is a masked-by-default value whose every reveal is audited (ADR-019), so holding
  // studentRecord:read never implies seeing a national ID or a medical note.
  RECORD_TEMPLATE_MANAGE: "recordTemplate:manage",
  STUDENT_RECORD_READ: "studentRecord:read",
  STUDENT_RECORD_UPDATE: "studentRecord:update",
  STUDENT_RECORD_READ_SENSITIVE: "studentRecord:readSensitive",

  TEACHER_CREATE: "teacher:create",
  TEACHER_READ: "teacher:read",
  TEACHER_UPDATE: "teacher:update",

  MATERIAL_CREATE: "material:create",
  MATERIAL_READ: "material:read",
  MATERIAL_UPDATE: "material:update",
  MATERIAL_DELETE: "material:delete",
  MATERIAL_MANAGE_AI: "material:manageAi",
  // Working the AI content moderation queue (ST-306): reading reported and filter-escalated AI
  // output and resolving it. Withheld from INSTRUCTOR on purpose -- the queue
  // spans the whole school and can hold child-safety escalations, which belong to the school's
  // designated safeguarding lead (an ORG_ADMIN), not to every teacher.
  AI_CONTENT_MODERATE: "aiContent:moderate",

  ATTENDANCE_RECORD_CREATE: "attendance:record:create",
  ATTENDANCE_RECORD_READ: "attendance:record:read",
  ATTENDANCE_RECORD_CORRECT: "attendance:record:correct",
  ATTENDANCE_REPORT_READ: "attendance:report:read",
  ATTENDANCE_REPORT_EXPORT: "attendance:report:export",
  // Amend a record whose correction window has closed. Deliberately withheld from INSTRUCTOR:
  // holding it is what distinguishes a principal's administrative override from a teacher's
  // routine same-week fix.
  ATTENDANCE_CORRECTION_OVERRIDE: "attendance:correction:override",

  PARENT_LINK: "parent:link",
  PARENT_UNLINK: "parent:unlink",

  DISCIPLINE_INCIDENT_CREATE: "disciplineIncident:create",
  DISCIPLINE_INCIDENT_READ: "disciplineIncident:read",
  DISCIPLINE_INCIDENT_UPDATE: "disciplineIncident:update",
  DISCIPLINE_INCIDENT_RESOLVE: "disciplineIncident:resolve",

  DISCIPLINE_ACTION_CREATE: "disciplineAction:create",
  DISCIPLINE_ACTION_READ: "disciplineAction:read",
  DISCIPLINE_ACTION_UPDATE: "disciplineAction:update",

  EVALUATION_TEMPLATE_CREATE: "evaluationTemplate:create",
  EVALUATION_TEMPLATE_READ: "evaluationTemplate:read",
  EVALUATION_TEMPLATE_UPDATE: "evaluationTemplate:update",
  EVALUATION_TEMPLATE_DELETE: "evaluationTemplate:delete",

  EVALUATION_CREATE: "evaluation:create",
  EVALUATION_READ: "evaluation:read",
  EVALUATION_UPDATE: "evaluation:update",
  EVALUATION_SUBMIT: "evaluation:submit",
  EVALUATION_SHARE: "evaluation:share",

  EVALUATION_SCORE_CREATE: "evaluationScore:create",
  EVALUATION_SCORE_READ: "evaluationScore:read",
  EVALUATION_SCORE_UPDATE: "evaluationScore:update",
  EVALUATION_SCORE_DELETE: "evaluationScore:delete",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

const ORG_ADMIN_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS.filter(
  (permission) =>
    permission !== PERMISSIONS.USER_IMPERSONATE &&
    permission !== PERMISSIONS.ORGANIZATION_CREATE &&
    permission !== PERMISSIONS.ORGANIZATION_DELETE &&
    permission !== PERMISSIONS.PLATFORM_READ &&
    permission !== PERMISSIONS.PLATFORM_MANAGE &&
    permission !== PERMISSIONS.API_KEY_CREATE &&
    permission !== PERMISSIONS.API_KEY_READ &&
    permission !== PERMISSIONS.API_KEY_REVOKE &&
    // Attendance is taken by the attendance officer and the class teacher and corrected only by the
    // officer and the principal; the school admin views it.
    permission !== PERMISSIONS.ATTENDANCE_RECORD_CREATE &&
    permission !== PERMISSIONS.ATTENDANCE_RECORD_CORRECT &&
    permission !== PERMISSIONS.ATTENDANCE_CORRECTION_OVERRIDE,
);

const INSTRUCTOR_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.CALENDAR_EVENT_READ,
  PERMISSIONS.MESSAGE_READ,
  PERMISSIONS.MESSAGE_SEND,
  PERMISSIONS.COURSE_CREATE,
  PERMISSIONS.COURSE_READ,
  PERMISSIONS.COURSE_UPDATE,
  PERMISSIONS.COURSE_DELETE,
  PERMISSIONS.COURSE_PUBLISH,
  PERMISSIONS.COURSE_ARCHIVE,
  PERMISSIONS.COURSE_DUPLICATE,
  PERMISSIONS.COURSE_MANAGE_ENROLLMENT,
  PERMISSIONS.LESSON_CREATE,
  PERMISSIONS.LESSON_READ,
  PERMISSIONS.LESSON_UPDATE,
  PERMISSIONS.LESSON_DELETE,
  PERMISSIONS.LESSON_PUBLISH,
  PERMISSIONS.LESSON_REORDER,
  PERMISSIONS.ENROLLMENT_READ,
  PERMISSIONS.ENROLLMENT_APPROVE,
  PERMISSIONS.ASSIGNMENT_CREATE,
  PERMISSIONS.ASSIGNMENT_READ,
  PERMISSIONS.ASSIGNMENT_UPDATE,
  PERMISSIONS.ASSIGNMENT_DELETE,
  PERMISSIONS.ASSIGNMENT_PUBLISH,
  PERMISSIONS.ASSIGNMENT_EXTEND_DEADLINE,
  PERMISSIONS.SUBMISSION_READ,
  PERMISSIONS.SUBMISSION_GRADE,
  PERMISSIONS.SUBMISSION_REQUEST_RESUBMISSION,
  PERMISSIONS.GRADE_READ,
  PERMISSIONS.GRADE_UPDATE,
  PERMISSIONS.ACADEMIC_CONFIG_READ,
  PERMISSIONS.DISCUSSION_CREATE,
  PERMISSIONS.DISCUSSION_READ,
  PERMISSIONS.DISCUSSION_UPDATE,
  PERMISSIONS.DISCUSSION_DELETE,
  PERMISSIONS.DISCUSSION_MODERATE,
  PERMISSIONS.DISCUSSION_PIN,
  PERMISSIONS.STUDY_GROUP_CREATE,
  PERMISSIONS.STUDY_GROUP_READ,
  PERMISSIONS.STUDY_GROUP_UPDATE,
  PERMISSIONS.STUDY_GROUP_DELETE,
  PERMISSIONS.STUDY_GROUP_JOIN,
  PERMISSIONS.STUDY_GROUP_MODERATE,
  PERMISSIONS.QUIZ_CREATE,
  PERMISSIONS.QUIZ_READ,
  PERMISSIONS.QUIZ_UPDATE,
  PERMISSIONS.QUIZ_DELETE,
  PERMISSIONS.QUIZ_PUBLISH,
  PERMISSIONS.QUIZ_GRADE,
  PERMISSIONS.CERTIFICATE_ISSUE,
  PERMISSIONS.CERTIFICATE_READ,
  PERMISSIONS.NOTIFICATION_READ,
  PERMISSIONS.NOTIFICATION_SEND,
  PERMISSIONS.STUDENT_READ,
  PERMISSIONS.TEACHER_READ,
  PERMISSIONS.MATERIAL_CREATE,
  PERMISSIONS.MATERIAL_READ,
  PERMISSIONS.MATERIAL_UPDATE,
  PERMISSIONS.MATERIAL_DELETE,
  PERMISSIONS.MATERIAL_MANAGE_AI,
  PERMISSIONS.DISCIPLINE_INCIDENT_CREATE,
  PERMISSIONS.DISCIPLINE_INCIDENT_READ,
  // Takes registers for their own classes (row scope limits writes to classes they teach, as it
  // does reads); corrections stay with the attendance officer and the principal.
  PERMISSIONS.ATTENDANCE_DASHBOARD_VIEW,
  PERMISSIONS.ATTENDANCE_RECORD_CREATE,
  PERMISSIONS.ATTENDANCE_RECORD_READ,
  PERMISSIONS.ATTENDANCE_REPORT_READ,
  // Reads the record fields the school marked teacher-visible (an allergy, a bus stop) for
  // students they teach. The service narrows to visibility "teachers" or "parent", never a
  // sensitive field, and the row scope is app.can_read_student -- the same predicate the student
  // profile uses -- so a teacher outside the student's classes and sections reads nothing.
  PERMISSIONS.STUDENT_RECORD_READ,
];

const STUDENT_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.COURSE_READ,
  PERMISSIONS.LESSON_READ,
  PERMISSIONS.ASSIGNMENT_READ,
  PERMISSIONS.SUBMISSION_CREATE,
  PERMISSIONS.SUBMISSION_READ,
  PERMISSIONS.SUBMISSION_UPDATE,
  PERMISSIONS.GRADE_READ,
  PERMISSIONS.DISCUSSION_CREATE,
  PERMISSIONS.DISCUSSION_READ,
  PERMISSIONS.DISCUSSION_UPDATE,
  PERMISSIONS.STUDY_GROUP_CREATE,
  PERMISSIONS.STUDY_GROUP_READ,
  PERMISSIONS.STUDY_GROUP_UPDATE,
  PERMISSIONS.STUDY_GROUP_JOIN,
  PERMISSIONS.QUIZ_READ,
  PERMISSIONS.CERTIFICATE_READ,
  PERMISSIONS.NOTIFICATION_READ,
  PERMISSIONS.STUDENT_READ,
  PERMISSIONS.MATERIAL_READ,
];

// A parent reads their own child's coursework and nothing else. The narrowing is done by the
// database, not by this list: app.is_related_to_student -- the same predicate the
// role_scope_visibility policies on app.assignments and app.assignment_submissions already call --
// resolves parent_child_links, so holding assignment:read here grants a parent exactly the
// assignments their child can see, and submission:read exactly their child's hand-ins (ST-104).
//
// Note what a parent does NOT hold: submission:create, submission:update, submission:grade. They
// can read a submission and they cannot touch one.
const PARENT_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.STUDENT_READ,
  PERMISSIONS.ASSIGNMENT_READ,
  PERMISSIONS.SUBMISSION_READ,
  PERMISSIONS.GRADE_READ,
  PERMISSIONS.DISCIPLINE_INCIDENT_READ,
  // Message their child's teachers; see MESSAGE_READ above for the row-level narrowing.
  PERMISSIONS.MESSAGE_READ,
  PERMISSIONS.MESSAGE_SEND,
  // Reads their linked child's record fields the school marked parent-visible and not sensitive.
  // Row scope is app.is_related_to_student, as for every other child-scoped read above. A parent
  // enters nothing: no studentRecord:update.
  PERMISSIONS.STUDENT_RECORD_READ,
];

const GUEST_PERMISSIONS: readonly Permission[] = [PERMISSIONS.COURSE_READ, PERMISSIONS.LESSON_READ];

// School leadership: oversight of attendance, discipline, staff evaluations, approvals and
// announcements across the whole school. Not the ops console -- no user/role/settings management and
// no billing -- which is what separates a PRINCIPAL from an ORG_ADMIN. School-wide row visibility
// (every student, class and attendance record) comes from app.current_user_is_school_admin(), which
// migration 000120 widened to include PRINCIPAL.
const PRINCIPAL_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.PRINCIPAL_DASHBOARD_VIEW,
  PERMISSIONS.LICENSE_READ,
  PERMISSIONS.LICENSE_MANAGE,
  PERMISSIONS.ATTENDANCE_DASHBOARD_VIEW,
  PERMISSIONS.MESSAGE_REPORT_REVIEW,
  PERMISSIONS.CALENDAR_EVENT_READ,
  PERMISSIONS.CALENDAR_EVENT_MANAGE,
  PERMISSIONS.TIMETABLE_MANAGE,
  PERMISSIONS.ACADEMIC_CONFIG_READ,
  PERMISSIONS.ACADEMIC_CONFIG_MANAGE,
  PERMISSIONS.RESULT_FINALIZE,
  PERMISSIONS.ACADEMIC_CERTIFICATE_ISSUE,
  PERMISSIONS.APPROVAL_REVIEW,
  PERMISSIONS.ORGANIZATION_READ,
  PERMISSIONS.USER_READ,
  PERMISSIONS.TEACHER_READ,
  PERMISSIONS.STUDENT_READ,
  PERMISSIONS.COURSE_READ,
  PERMISSIONS.ENROLLMENT_READ,
  PERMISSIONS.GRADE_READ,
  PERMISSIONS.REPORT_READ,
  PERMISSIONS.NOTIFICATION_READ,
  PERMISSIONS.NOTIFICATION_SEND,
  PERMISSIONS.NOTIFICATION_MANAGE,
  PERMISSIONS.ATTENDANCE_RECORD_READ,
  PERMISSIONS.ATTENDANCE_RECORD_CORRECT,
  PERMISSIONS.ATTENDANCE_REPORT_READ,
  PERMISSIONS.ATTENDANCE_REPORT_EXPORT,
  PERMISSIONS.ATTENDANCE_CORRECTION_OVERRIDE,
  PERMISSIONS.DISCIPLINE_INCIDENT_CREATE,
  PERMISSIONS.DISCIPLINE_INCIDENT_READ,
  PERMISSIONS.DISCIPLINE_INCIDENT_UPDATE,
  PERMISSIONS.DISCIPLINE_INCIDENT_RESOLVE,
  PERMISSIONS.DISCIPLINE_ACTION_CREATE,
  PERMISSIONS.DISCIPLINE_ACTION_READ,
  PERMISSIONS.DISCIPLINE_ACTION_UPDATE,
  PERMISSIONS.EVALUATION_TEMPLATE_CREATE,
  PERMISSIONS.EVALUATION_TEMPLATE_READ,
  PERMISSIONS.EVALUATION_TEMPLATE_UPDATE,
  PERMISSIONS.EVALUATION_TEMPLATE_DELETE,
  PERMISSIONS.EVALUATION_CREATE,
  PERMISSIONS.EVALUATION_READ,
  PERMISSIONS.EVALUATION_UPDATE,
  PERMISSIONS.EVALUATION_SUBMIT,
  PERMISSIONS.EVALUATION_SHARE,
  PERMISSIONS.EVALUATION_SCORE_CREATE,
  PERMISSIONS.EVALUATION_SCORE_READ,
  PERMISSIONS.EVALUATION_SCORE_UPDATE,
  PERMISSIONS.EVALUATION_SCORE_DELETE,
  // The school's records are the principal's to shape and keep complete, exactly as they are the
  // admin's: build the templates, fill in and correct the records of students and parents who
  // already exist (still no student:create / user:create), and reveal a sensitive value when the
  // work needs it -- every reveal audited like a write.
  PERMISSIONS.RECORD_TEMPLATE_MANAGE,
  PERMISSIONS.STUDENT_RECORD_READ,
  PERMISSIONS.STUDENT_RECORD_UPDATE,
  PERMISSIONS.STUDENT_RECORD_READ_SENSITIVE,
];

// The attendance office: takes, corrects and reports attendance for the whole school, and nothing
// else. School-wide row visibility is scoped to rosters and attendance alone by migration 000133
// (app.current_user_is_attendance_officer), deliberately not app.current_user_is_school_admin(), so
// an officer sees every class's roster and attendance but no grades, exams, materials or discipline.
// It takes any class's register; a teacher takes only their own. Correcting past the school's correction window
// (ATTENDANCE_CORRECTION_OVERRIDE) stays the principal's call.
const ATTENDANCE_OFFICER_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.ATTENDANCE_DASHBOARD_VIEW,
  PERMISSIONS.ATTENDANCE_RECORD_CREATE,
  PERMISSIONS.ATTENDANCE_RECORD_READ,
  PERMISSIONS.ATTENDANCE_RECORD_CORRECT,
  PERMISSIONS.ATTENDANCE_REPORT_READ,
  PERMISSIONS.ATTENDANCE_REPORT_EXPORT,
  PERMISSIONS.STUDENT_READ,
  PERMISSIONS.COURSE_READ,
  PERMISSIONS.ENROLLMENT_READ,
  PERMISSIONS.CALENDAR_EVENT_READ,
  PERMISSIONS.NOTIFICATION_READ,
];

const FINANCE_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.BILLING_READ,
  PERMISSIONS.BILLING_UPDATE,
  PERMISSIONS.BILLING_VIEW_INVOICES,
  PERMISSIONS.REPORT_READ,
  PERMISSIONS.REPORT_EXPORT,
  PERMISSIONS.REPORT_VIEW_FINANCIAL,
  PERMISSIONS.AUDIT_LOG_READ,
  PERMISSIONS.AUDIT_LOG_EXPORT,
  PERMISSIONS.ORGANIZATION_READ,
  PERMISSIONS.USER_READ,
  PERMISSIONS.NOTIFICATION_READ,
  // Reads only the record fields marked finance-visible (a sponsor, a fee-paying guardian's
  // employer), never a sensitive one; the service filters by visibility, not this list.
  PERMISSIONS.STUDENT_RECORD_READ,
];

const SUPPORT_AGENT_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.USER_READ,
  PERMISSIONS.ORGANIZATION_READ,
  PERMISSIONS.COURSE_READ,
  PERMISSIONS.ENROLLMENT_READ,
  PERMISSIONS.BILLING_READ,
  PERMISSIONS.BILLING_VIEW_INVOICES,
  PERMISSIONS.REPORT_READ,
  PERMISSIONS.AUDIT_LOG_READ,
  PERMISSIONS.NOTIFICATION_READ,
  PERMISSIONS.NOTIFICATION_SEND,
  PERMISSIONS.STUDENT_READ,
  PERMISSIONS.DISCIPLINE_INCIDENT_READ,
];

/**
 * Static role → permission assignment. `SUPER_ADMIN` intentionally holds every permission,
 * which also guarantees every entry in PERMISSIONS is reachable by at least one role
 * (enforced by permissions.test.ts).
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  [ROLES.SUPER_ADMIN]: ALL_PERMISSIONS,
  [ROLES.ORG_ADMIN]: ORG_ADMIN_PERMISSIONS,
  [ROLES.PRINCIPAL]: PRINCIPAL_PERMISSIONS,
  [ROLES.ATTENDANCE_OFFICER]: ATTENDANCE_OFFICER_PERMISSIONS,
  [ROLES.FINANCE]: FINANCE_PERMISSIONS,
  [ROLES.INSTRUCTOR]: INSTRUCTOR_PERMISSIONS,
  [ROLES.STUDENT]: STUDENT_PERMISSIONS,
  [ROLES.PARENT]: PARENT_PERMISSIONS,
  [ROLES.GUEST]: GUEST_PERMISSIONS,
  [ROLES.SUPPORT_AGENT]: SUPPORT_AGENT_PERMISSIONS,
};
