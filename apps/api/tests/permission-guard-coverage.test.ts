/**
 * CI gate: every mutating route that acts on another user's data must carry a
 * requirePermission() guard.
 *
 * Mirrors the structure of audit-coverage.test.ts: scan source files for mutating
 * route registrations, verify each is accompanied by a requirePermission() call in
 * the same file, and pin the expected count so a blind scanner fails loudly.
 *
 * Self-service routes (session lifecycle) and webhook routes (HMAC-authenticated)
 * are exempt — they either operate on the caller's own data or authenticate by
 * other means. The exemption list is explicit and enumerable.
 *
 * ## Why per-file, not per-route
 *
 * `requirePermission` is mounted as `routes.use(path, guard)` before the route
 * handler is registered, so it lives in the same file but on a different line.
 * A 15-line proximity window (like audit-coverage) would work, but per-file is
 * simpler and equally correct because Hono route files are small and focused —
 * a single file never mixes guarded and unguarded admin routes.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

const SRC_DIR = resolve(import.meta.dir, "../src");
const EXCLUDE_PATTERNS = [/\.test\.ts$/, /\.d\.ts$/, /__tests__/];
const MUTATING_METHODS = ["post", "put", "patch", "delete"] as const;

/**
 * Every mutating route that currently exists, by "METHOD path".
 *
 * Kept in sync with audit-coverage.test.ts's list. A new mutating route must be
 * added here and to audit-coverage.test.ts simultaneously.
 */
const EXPECTED_MUTATING_ROUTES = [
  "POST /api/invitations",
  "POST /api/invitations/{id}/revoke",
  "POST /api/invitations/{id}/regenerate",
  "POST /api/auth/invitations/{token}/activate",
  "POST /api/auth/login/oauth",
  "POST /api/auth/providers/link/start",
  "POST /api/schools/register",
  "POST /erpnext/webhooks",
  "POST /email/webhooks/sns",
  "POST /api/subscriptions/webhook/stripe",
  "POST /api/auth/refresh",
  "POST /api/auth/logout",
  "DELETE /api/auth/sessions/{sessionId}",
  "DELETE /api/auth/devices/{deviceId}/sessions",
  "DELETE /api/auth/devices/{deviceId}",
  "DELETE /api/auth/providers/{provider}",
  "DELETE /api/admin/users/{userId}/devices",
  "DELETE /api/admin/users/{userId}/devices/{deviceId}",
  "DELETE /api/admin/users/{userId}/providers/{provider}",
  // School email verification (ST-088). Self-service; authorized by the caller's school identity.
  "POST /api/schools/resend-verification",
  // School settings (ST-090). Gated on ORGANIZATION_MANAGE_SETTINGS.
  "PATCH /api/schools/current/settings",
  // Tenant provisioning (ST-089). School admin triggers provisioning for their own school;
  // school context is sufficient — no cross-user row-level permission.
  "POST /api/schools/{schoolId}/provision",
  // Academic year & term management (ST-091). Tenant-scoped CRUD protected by requireAuth; the
  // school context is sufficient — there is no cross-user row-level permission to check.
  "POST /api/academics/years",
  "PATCH /api/academics/years/{yearId}",
  "DELETE /api/academics/years/{yearId}",
  "POST /api/academics/years/{yearId}/rollover",
  "POST /api/academics/years/{yearId}/terms",
  "PATCH /api/academics/terms/{termId}",
  "DELETE /api/academics/terms/{termId}",
  // Subjects & courses (ST-099). Tenant-scoped CRUD protected by requireAuth; school-level
  // catalog data with no cross-user row-level permission.
  "POST /api/academics/subjects",
  "PATCH /api/academics/subjects/{subjectId}",
  "DELETE /api/academics/subjects/{subjectId}",
  "POST /api/academics/subjects/{subjectId}/courses",
  "PATCH /api/academics/courses/{courseId}",
  "DELETE /api/academics/courses/{courseId}",
  // User management & administration (ST-093). Authenticated, tenant-scoped CRUD with per-route
  // requirePermission() guards for USER_READ, USER_CREATE, USER_UPDATE, ROLE_ASSIGN, and USER_SUSPEND.
  "POST /api/users",
  "PATCH /api/users/{userId}",
  "PATCH /api/users/{userId}/role",
  "PATCH /api/users/{userId}/deactivate",
  // Student profiles. Authenticated, tenant-scoped CRUD with per-route requirePermission() guards
  // for STUDENT_READ, STUDENT_CREATE, and STUDENT_UPDATE.
  "POST /api/students",
  "PATCH /api/students/{studentId}",
  // Teacher profiles. Authenticated, tenant-scoped CRUD with per-route requirePermission() guards
  // for TEACHER_READ, TEACHER_CREATE, and TEACHER_UPDATE.
  "POST /api/teachers",
  "PATCH /api/teachers/{teacherId}",
  // Student guardian (parent-child) linking. Authenticated, tenant-scoped CRUD with per-route
  // requirePermission() guards for STUDENT_READ and STUDENT_UPDATE.
  "POST /api/students/{studentId}/guardians",
  "DELETE /api/students/{studentId}/guardians/{userId}",
  // Family household management is guarded by PARENT_LINK/PARENT_UNLINK.
  "POST /api/families",
  "PATCH /api/families/{familyId}",
  "DELETE /api/families/{familyId}",
  "POST /api/families/{familyId}/links",
  "PATCH /api/families/{familyId}/links/{parentUserId}/{studentId}",
  "DELETE /api/families/{familyId}/links/{parentUserId}/{studentId}",
  // Student CSV imports. Upload and confirm are mutating; guarded by STUDENT_IMPORT permission.
  "POST /api/imports/students/upload",
  "POST /api/imports/students/{importId}/confirm",
  // Bulk invitations. Admin dispatches invitations in batches; guarded by USER_INVITE permission.
  "POST /api/invitations/bulk",
  "POST /api/invitations/bulk/{bulkInviteId}/retry",
  // Classes & enrollments (ST-100). Tenant-scoped CRUD protected by requireAuth; school-level
  // catalog data with no cross-user row-level permission.
  "POST /api/academics/classes",
  "PATCH /api/academics/classes/{classId}",
  "DELETE /api/academics/classes/{classId}",
  "POST /api/academics/classes/{classId}/enrollments",
  "DELETE /api/academics/classes/{classId}/enrollments/{studentId}",
  "POST /api/academics/classes/{classId}/enrollments/transfer",
  // Timetable (ST-101). Tenant-scoped CRUD protected by requireAuth; school-level
  // catalog data with no cross-user row-level permission.
  "POST /api/academics/timetable-versions",
  "PATCH /api/academics/timetable-versions/{versionId}",
  "DELETE /api/academics/timetable-versions/{versionId}",
  "POST /api/academics/timetable-versions/{versionId}/submit",
  "POST /api/academics/timetable-versions/{versionId}/approve",
  "POST /api/academics/timetable-versions/{versionId}/reject",
  "POST /api/academics/timetable-versions/copy",
  "POST /api/academics/timetable-versions/{versionId}/slots",
  "PATCH /api/academics/slots/{slotId}",
  "DELETE /api/academics/slots/{slotId}",
  // Assignments (ST-103). Guarded per method by requirePermission() on ASSIGNMENT_CREATE,
  // ASSIGNMENT_UPDATE, and ASSIGNMENT_DELETE — see permissionByMethod() in the route file. These
  // are genuinely row-level: a teacher may only act on classes they teach, so unlike the rest of
  // academics they are NOT exempt below.
  "POST /api/academics/assignments",
  "PATCH /api/academics/assignments/{assignmentId}",
  "DELETE /api/academics/assignments/{assignmentId}",
  "POST /api/academics/assignments/{assignmentId}/attachments/upload-url",
  "POST /api/academics/assignments/{assignmentId}/attachments",
  "DELETE /api/academics/assignments/{assignmentId}/attachments/{attachmentId}",
  // Submissions (ST-104). Guarded per method by requirePermission() on SUBMISSION_CREATE,
  // SUBMISSION_GRADE, and SUBMISSION_UPDATE — see permissionByMethod() in the route file. Row-level
  // for the same reason the assignments routes are, and then some: a student may only act on their
  // own submission and a teacher only on classes they teach, so these are NOT exempt below. The
  // attachment routes gate on SUBMISSION_UPDATE specifically because INSTRUCTOR does not hold it —
  // a teacher can read the work they are marking but cannot alter it.
  "POST /api/academics/assignments/{assignmentId}/submissions",
  "PATCH /api/academics/submissions/{submissionId}/grade",
  "POST /api/academics/submissions/{submissionId}/attachments/upload-url",
  "POST /api/academics/submissions/{submissionId}/attachments",
  "DELETE /api/academics/submissions/{submissionId}/attachments/{attachmentId}",
  // Exam scheduling (ST-102). Tenant-scoped CRUD protected by requireAuth; school-level
  // catalog data with no cross-user row-level permission to check.
  "POST /api/academics/exams",
  "PATCH /api/academics/exams/{examId}",
  "DELETE /api/academics/exams/{examId}",
  // Gradebook configuration (ST-112). Guarded by requirePermission() on GRADE_READ/GRADE_UPDATE.
  // Row-level: only the teaching teacher or a school admin may manage a gradebook.
  "POST /api/grades/config/gradebooks/{gradebookId}/categories",
  "PATCH /api/grades/config/gradebooks/{gradebookId}/categories/{categoryId}",
  "DELETE /api/grades/config/gradebooks/{gradebookId}/categories/{categoryId}",
  "POST /api/grades/config/gradebooks/{gradebookId}/scheme/link",
  "POST /api/grades/config/schemes",
  // Attendance sessions. Tenant-scoped session management protected by requireAuth; school-level
  // data with no cross-user row-level permission.
  "POST /api/attendance/records/batch",
  "POST /api/attendance/reports/export",
  "POST /api/attendance/sessions",
  "PATCH /api/attendance/sessions/{sessionId}",
  // Attendance corrections (ST-109). Guarded by requirePermission() on
  // ATTENDANCE_RECORD_CORRECT; ATTENDANCE_CORRECTION_OVERRIDE is then checked in the handler to
  // decide whether the caller may correct past the school's window.
  "PATCH /api/attendance/records/{recordId}",
  // Grade entry (ST-113). Guarded by requirePermission() on GRADE_UPDATE.
  "PATCH /api/grades/gradebooks/{gradebookId}/grades",
  "PATCH /api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/decide",
  "PATCH /api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/submit",
  "PATCH /api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/unlock",
  // Discipline incidents & actions. Guarded per method by requirePermissionIn() on
  // DISCIPLIN_INCIDENT_CREATE/READ/UPDATE/RESOLVE and DISCIPLINE_ACTION_CREATE/READ/UPDATE.
  // Finance gateway (ST-119). Guarded by requirePermission(BILLING_UPDATE); FINANCE_PERMISSIONS
  // already holds it, so the FINANCE role gains this surface without a matrix change.
  "POST /api/finance/fee-structures",
  "PATCH /api/finance/fee-structures/{feeStructureId}",
  "POST /api/finance/expenses",
  "PATCH /api/finance/expenses/{expenseId}",
  "POST /api/finance/expenses/upload-url",
  "POST /api/finance/expenses/{expenseId}/attachments",
  "POST /api/finance/reports/export",
  // ST-046x. Audit explorer export queue, gated on AUDIT_LOG_EXPORT via requirePermission.
  "POST /api/audit/logs/export",
  // ST-122. Fee schedule generation gated on BILLING_UPDATE via requirePermission middleware.
  "POST /api/finance/fee-schedules/generate",
  // ST-122. Internal API-key-authenticated reconciliation job; listed here for inventory accuracy
  // but added to GUARD_EXEMPT_ROUTES below because there is no bearer token to check.
  "POST /api/finance/reconciliation/run",
  // ST-121. Guarded by billing:update. The payment-confirmed webhook is not listed here because it
  // carries no requirePermission — it authenticates by HMAC over the raw body, not by a bearer token.
  "POST /api/finance/payments",
  "POST /api/discipline/incidents",
  "PATCH /api/discipline/incidents/{incidentId}",
  "POST /api/discipline/incidents/{incidentId}/resolve",
  "POST /api/discipline/incidents/{incidentId}/actions",
  "PATCH /api/discipline/incidents/{incidentId}/actions/{actionId}",
  // Evaluation criteria templates. Guarded per method by requirePermission() on
  // EVALUATION_TEMPLATE_CREATE/UPDATE/DELETE.
  "POST /api/evaluations/templates",
  "PATCH /api/evaluations/templates/{templateId}",
  "DELETE /api/evaluations/templates/{templateId}",
  // Teacher evaluations. Guarded per method by requirePermission() on
  // EVALUATION_CREATE/UPDATE/SUBMIT/SHARE.
  "POST /api/evaluations",
  "PATCH /api/evaluations/{evaluationId}",
  "POST /api/evaluations/{evaluationId}/submit",
  "POST /api/evaluations/{evaluationId}/share",
  // Evaluation scores. Guarded per method by requirePermission() on
  // EVALUATION_SCORE_CREATE/DELETE.
  "PUT /api/evaluations/{evaluationId}/scores/{criteriaTemplateId}",
  "DELETE /api/evaluations/{evaluationId}/scores/{criteriaTemplateId}",
  // Learning materials (ST-102). Tenant-scoped CRUD protected by requireAuth; school-level
  // catalog data with no cross-user row-level permission.
  "POST /api/academics/materials/upload",
  "POST /api/academics/materials/{materialId}/confirm",
  "PATCH /api/academics/materials/{materialId}",
  "PATCH /api/academics/materials/{materialId}/ai-visible",
  "DELETE /api/academics/materials/{materialId}",
  // Generic object storage gateway (SAD §22). Authorized per content class by requirePermissionIn()
  // in the handler — the required permission arrives in the request body, so the mount-time
  // requirePermission() form cannot see it. Exempted below on that basis.
  "POST /api/storage/uploads/request-upload",
  "POST /api/storage/uploads/confirm",
  // Approval queue (ST-115). Atomic bulk approve/reject with per-item partial-failure.
  // Gated on APPROVAL_REVIEW permission via requirePermission middleware.
  "POST /api/approvals/bulk-decision",
  // Scholarship/discount awards (ST-119 extension). Maker-checker workflow gated on
  // BILLING_UPDATE permission via requirePermission middleware.
  "POST /api/finance/scholarship-discounts/awards",
  "POST /api/finance/scholarship-discounts/awards/{awardId}/confirm",
  // Refund processing (ST-124). Maker-checker workflow gated on BILLING_REFUND permission
  // via requirePermission middleware in routes.ts.
  "POST /api/finance/refunds/initiate",
  "POST /api/finance/refunds/{refundId}/approve",
  "POST /api/finance/refunds/{refundId}/reject",
  // In-app inbox (ST-142). Personal per-user read state; RLS already fences every row to the
  // authenticated user (user_id = app.current_user_id()), so the caller's identity is sufficient
  // authorization and there is no other user's row to protect. Listed here for inventory accuracy
  // and added to GUARD_EXEMPT_ROUTES below for the same reason the session-lifecycle routes are.
  "POST /api/notifications/{notificationId}/read",
  "POST /api/notifications/read-all",
  // Notification preferences (ST-143). Self-service on the caller's own rows; the mandatory-type
  // and digest-eligibility rules are enforced in the handler and, redundantly, by CHECK constraints
  // in migration 000083 — there is no other user's row this could reach.
  "PATCH /api/notification-preferences",
  // School billing portal (ST-137). Guarded by requirePermission(ORGANIZATION_MANAGE_BILLING) in
  // cancellation-routes.ts.
  "POST /api/subscriptions/current/cancel",
  "POST /api/subscriptions/current/cancel/reverse",
  // Hybrid retrieval (ST-162). Gated by the ST-155 AI entitlement gate (403/402/429), not the
  // permission matrix; exempt below because the gate is the authorization surface for every
  // /api/ai/* route and the search's one write is the metered student's own usage ledger.
  "POST /api/ai/students/{studentId}/search",
  // LLM gateway (ST-164). Same gate and same rationale as the retrieval route above: the gate is
  // the authorization surface for every /api/ai/* route, and the generate route's one write is the
  // metered student's own usage ledger.
  "POST /api/ai/students/{studentId}/generate",
  // Ask AI streaming (ST-165). Same gate and same rationale as the gateway route above; the ask
  // route's writes are the grounded answer's messages, citations, and the student's usage ledger.
  "POST /api/ai/students/{studentId}/ask",
  // Study-material summarizer. Same gate and same rationale as the retrieval route above; the
  // summarize route's one write is the metered student's own usage ledger.
  "POST /api/ai/students/{studentId}/summarize",
  // Key-concept extraction (ST-169). Same gate and same rationale as the summarizer route above;
  // the concepts route's one write is the metered student's own usage ledger.
  "POST /api/ai/students/{studentId}/concepts",
  // Quiz generation and grading (ST-167). Same gate and same rationale as the retrieval route
  // above; generation's writes are the quiz, its questions, and the student's usage ledger, and
  // grading acts only on the requesting student's own quiz (scoped by student_id, see
  // quiz/persistence.ts's loadQuizForGrading).
  "POST /api/ai/students/{studentId}/quizzes",
  "POST /api/ai/students/{studentId}/quizzes/{quizId}/grade",
  // Flashcard deck generation and spaced-repetition reviews (ST-168). Same gate and same rationale
  // as the quiz routes above; generation's writes are the deck, its cards, and the student's usage
  // ledger, and the review endpoints act only on the requesting student's own deck (scoped by
  // student_id, see flashcards/persistence.ts's loadDeckCards / loadDueCards).
  "POST /api/ai/students/{studentId}/decks",
  "POST /api/ai/students/{studentId}/decks/{deckId}/review",
];

/**
 * Mutating routes exempt from the requirePermission() guard.
 *
 * Self-service routes operate on the caller's own data — the caller's identity
 * (established by jwtAuth.ts) is sufficient authorization; there is no
 * "someone else's row" to protect. Webhook routes authenticate by HMAC signature,
 * not by bearer token, and are structurally outside the permission model.
 *
 * Invitation routes predate the permission guard and use inline role checks
 * instead of requirePermission(). They carry equivalent authorization but not
 * through the standardised middleware. They are exempt until migrated.
 */
const GUARD_EXEMPT_ROUTES = new Set([
  // Session lifecycle — caller's own data.
  "POST /api/auth/refresh",
  "POST /api/auth/logout",
  "DELETE /api/auth/sessions/{sessionId}",
  "DELETE /api/auth/devices/{deviceId}/sessions",
  "DELETE /api/auth/devices/{deviceId}",
  // Webhook — HMAC-authenticated, not bearer.
  "POST /erpnext/webhooks",
  // SES → SNS email-event webhook (R-08) — SNS-signature-authenticated, not bearer.
  "POST /email/webhooks/sns",
  // Stripe billing webhook (ST-132) — authenticated by the Stripe-Signature HMAC over the raw
  // request body, not by a bearer token. Stripe holds no Studafy identity and no permission could
  // be checked against one, so this is the same exemption the two webhooks above take.
  "POST /api/subscriptions/webhook/stripe",
  // Daily reconciliation (ST-122) — API-key-authenticated, not bearer; no JWT to check.
  "POST /api/finance/reconciliation/run",
  // Account activation (ST-078) — public self-service onboarding. Authorized by the invitation
  // token in the path plus a verified Microsoft OIDC identity, not by a bearer permission; there is
  // no other user's data to protect.
  "POST /api/auth/invitations/{token}/activate",
  // Returning-user OAuth login (ST-079) — public self-service login. Authorized by a verified
  // Microsoft OIDC id_token, not by a bearer permission; authenticates the caller, not another user.
  "POST /api/auth/login/oauth",
  // Provider linking (ST-080) — self-service link/unlink on the caller's own data.
  "POST /api/auth/providers/link/start",
  "DELETE /api/auth/providers/{provider}",
  // School self-registration (ST-081) — public unauthenticated endpoint; no caller identity or
  // bearer permission; authorized by Turnstile captcha only.
  "POST /api/schools/register",
  // School email verification (ST-088) — self-service resend for the caller's own school.
  // School email verification (ST-088) — public self-service endpoint; authorized by a one-time
  // verification token, not by a bearer permission; no other user's data to protect.
  "POST /api/schools/resend-verification",
  // Tenant provisioning (ST-089) — school admin self-service on their own school's provisioning.
  "POST /api/schools/{schoolId}/provision",
  // Pre-ST-072 inline role checks — migrate to requirePermission and remove.
  "POST /api/invitations",
  "POST /api/invitations/{id}/revoke",
  "POST /api/invitations/{id}/regenerate",
  // Academic year & term management (ST-091) — tenant-scoped school-level access protected by
  // requireAuth; no cross-user row-level permission to check.
  "POST /api/academics/years",
  "PATCH /api/academics/years/{yearId}",
  "DELETE /api/academics/years/{yearId}",
  "POST /api/academics/years/{yearId}/rollover",
  "POST /api/academics/years/{yearId}/terms",
  "PATCH /api/academics/terms/{termId}",
  "DELETE /api/academics/terms/{termId}",
  // Subjects & courses (ST-099) — tenant-scoped school-level catalog data protected by
  // requireAuth; no cross-user row-level permission to check.
  "POST /api/academics/subjects",
  "PATCH /api/academics/subjects/{subjectId}",
  "DELETE /api/academics/subjects/{subjectId}",
  "POST /api/academics/subjects/{subjectId}/courses",
  "PATCH /api/academics/courses/{courseId}",
  "DELETE /api/academics/courses/{courseId}",
  // Classes & enrollments (ST-100) — tenant-scoped school-level catalog data protected by
  // requireAuth; no cross-user row-level permission to check.
  "POST /api/academics/classes",
  "PATCH /api/academics/classes/{classId}",
  "DELETE /api/academics/classes/{classId}",
  "POST /api/academics/classes/{classId}/enrollments",
  "DELETE /api/academics/classes/{classId}/enrollments/{studentId}",
  "POST /api/academics/classes/{classId}/enrollments/transfer",
  // Timetable (ST-101) — tenant-scoped school-level catalog data protected by
  // requireAuth; no cross-user row-level permission to check.
  "POST /api/academics/timetable-versions",
  "PATCH /api/academics/timetable-versions/{versionId}",
  "DELETE /api/academics/timetable-versions/{versionId}",
  "POST /api/academics/timetable-versions/{versionId}/submit",
  "POST /api/academics/timetable-versions/{versionId}/approve",
  "POST /api/academics/timetable-versions/{versionId}/reject",
  "POST /api/academics/timetable-versions/copy",
  "POST /api/academics/timetable-versions/{versionId}/slots",
  "PATCH /api/academics/slots/{slotId}",
  "DELETE /api/academics/slots/{slotId}",
  // Exam scheduling (ST-102) — tenant-scoped school-level catalog data protected by
  // requireAuth; no cross-user row-level permission to check.
  "POST /api/academics/exams",
  "PATCH /api/academics/exams/{examId}",
  "DELETE /api/academics/exams/{examId}",
  // Attendance sessions (ST-107) — idempotent session management; teacher self-service
  // on the class period they teach, guarded by a route handler that verifies the caller
  // is the class teacher rather than requirePermission().
  "POST /api/attendance/sessions",
  "PATCH /api/attendance/sessions/{sessionId}",
  // Learning materials (ST-106) — storage-triggered upload flow, authorized by
  // signed upload URL and row ownership, not by the permission guard.
  "POST /api/academics/materials/upload",
  "POST /api/academics/materials/{materialId}/confirm",
  "PATCH /api/academics/materials/{materialId}",
  "PATCH /api/academics/materials/{materialId}/ai-visible",
  "DELETE /api/academics/materials/{materialId}",
  // In-app inbox (ST-142) — personal per-user read state; the caller's own rows only. RLS
  // (`user_id = app.current_user_id()`) is the fence, so the bearer identity is sufficient
  // authorization — same rationale as the session-lifecycle routes above.
  "POST /api/notifications/{notificationId}/read",
  "POST /api/notifications/read-all",
  // Notification preferences (ST-143) — personal per-user rows; RLS
  // (`notification_preferences_owner`, `user_id = app.current_user_id()`) is the fence.
  "PATCH /api/notification-preferences",
  // Generic object storage gateway (SAD §22) — authorized per content class. The class (and thus
  // the required permission) is in the request body, so it is asserted in the handler via
  // requirePermissionIn() rather than mounted at route time — the same per-method pattern the
  // discipline and evaluation routes use, but with no class-independent READ gate to mount. A
  // caller still cannot reach a class's upload without holding that class's permission.
  "POST /api/storage/uploads/request-upload",
  "POST /api/storage/uploads/confirm",
  // Hybrid retrieval (ST-162) — the ST-155 AI entitlement gate (school active -> AI add-on active ->
  // quota available; 403/402/429), not the permission matrix, is the authorization surface for every
  // /api/ai/* route. The search reads only the school's own corpus under forced RLS, and its one
  // write is the metered student's own ai_usage_meters row.
  "POST /api/ai/students/{studentId}/search",
  // LLM gateway (ST-164) — same gate, same RLS, same single write to the metered student's own
  // ai_usage_meters row.
  "POST /api/ai/students/{studentId}/generate",
  // Ask AI streaming (ST-165) — same gate, same RLS; its writes are the answer's messages,
  // citations, and the student's ai_usage_meters row.
  "POST /api/ai/students/{studentId}/ask",
  // Study-material summarizer — same gate, same RLS, same single write to the metered student's
  // own ai_usage_meters row.
  "POST /api/ai/students/{studentId}/summarize",
  // Key-concept extraction (ST-169) — same gate, same RLS, same single write to the metered
  // student's own ai_usage_meters row.
  "POST /api/ai/students/{studentId}/concepts",
  // Quiz generation and grading (ST-167) — same gate, same RLS. Generation writes the quiz, its
  // questions, and the student's own ai_usage_meters row; grading is explicitly scoped to the
  // requesting student's own quiz (student_id filter in quiz/persistence.ts) and writes nothing.
  "POST /api/ai/students/{studentId}/quizzes",
  "POST /api/ai/students/{studentId}/quizzes/{quizId}/grade",
  // Flashcard deck generation and spaced-repetition reviews (ST-168) — same gate, same RLS.
  // Generation writes the deck, its cards, and the student's own ai_usage_meters row; the review
  // endpoints are explicitly scoped to the requesting student's own deck (student_id filter in
  // flashcards/persistence.ts) and update only that student's per-card progress rows.
  "POST /api/ai/students/{studentId}/decks",
  "POST /api/ai/students/{studentId}/decks/{deckId}/review",
]);

// ---------------------------------------------------------------------------
// File scanning (same pattern as audit-coverage.test.ts)
// ---------------------------------------------------------------------------

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from a readdir of our own src tree
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (entry.endsWith(".ts") && !EXCLUDE_PATTERNS.some((p) => p.test(entry))) {
      files.push(fullPath);
    }
  }

  return files;
}

function stripComments(source: string): string[] {
  let inBlockComment = false;

  return source.split("\n").map((line) => {
    const trimmed = line.trim();

    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      return "";
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      return "";
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return "";

    return line;
  });
}

interface MutatingRoute {
  file: string;
  line: number;
  method: string;
  path: string;
  hasRequirePermission: boolean;
}

function hasRequirePermissionInFile(source: string): boolean {
  return /\brequirePermission\s*\(/.test(source);
}

function findMutatingRoutes(files: string[]): MutatingRoute[] {
  const routes: MutatingRoute[] = [];
  const methods = MUTATING_METHODS.join("|");

  for (const file of files) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path comes from our own src tree
    const lines = stripComments(readFileSync(file, "utf-8"));
    const relFile = relative(SRC_DIR, file);
    const source = lines.join("\n");
    const guarded = hasRequirePermissionInFile(source);

    const record = (line: number, method: string, path: string) => {
      routes.push({
        file: relFile,
        line,
        method: method.toUpperCase(),
        path,
        hasRequirePermission: guarded,
      });
    };

    // Style 1: plain Hono — routes.post("/path", ...)
    const directPattern = new RegExp(
      "routes\\.(" + methods + ")\\s*\\(\\s*[\"'`](/[^\"'`]+)[\"'`]",
      "g",
    );
    for (let i = 0; i < lines.length; i++) {
      directPattern.lastIndex = 0;
      const match = directPattern.exec(lines[i]!);
      if (match) record(i + 1, match[1]!, match[2]!);
    }

    // Style 2: @hono/zod-openapi — createRoute({ method: "post", path: "/path", ... }).
    if (/routes\.openapi\s*\(/.test(source)) {
      const createRoutePattern = /createRoute\s*\(\s*\{([\s\S]*?)\n\}\s*\)/g;
      let block: RegExpExecArray | null;

      while ((block = createRoutePattern.exec(source)) !== null) {
        const body = block[1]!;
        const method = new RegExp(`method:\\s*["'\`](${methods})["'\`]`).exec(body);
        const path = /path:\s*["'`](\/[^"'`]*)["'`]/.exec(body);
        if (!method || !path) continue;

        record(source.slice(0, block.index).split("\n").length, method[1]!, path[1]!);
      }
    }
  }

  return routes;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("permission guard route coverage", () => {
  test("every mutating route is accounted for in the expected list", () => {
    const files = collectSourceFiles(SRC_DIR);
    const routes = findMutatingRoutes(files);

    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [...EXPECTED_MUTATING_ROUTES].sort(),
    );
  });

  test("every non-exempt mutating route has requirePermission in its file", () => {
    const files = collectSourceFiles(SRC_DIR);
    const routes = findMutatingRoutes(files);

    const unguarded = routes.filter(
      (r) => !GUARD_EXEMPT_ROUTES.has(`${r.method} ${r.path}`) && !r.hasRequirePermission,
    );

    if (unguarded.length > 0) {
      const detail = unguarded
        .map((r) => `  ${r.file}:${r.line}  ${r.method} ${r.path}`)
        .join("\n");
      throw new Error(
        `Mutating routes without requirePermission():\n${detail}\n\n` +
          "Every mutating route that acts on another user's data must use requirePermission(). " +
          "Self-service and webhook routes are exempt — add them to GUARD_EXEMPT_ROUTES.",
      );
    }

    expect(unguarded).toHaveLength(0);
  });

  test("does not mistake doc-comment examples for routes", () => {
    const routes = findMutatingRoutes(collectSourceFiles(SRC_DIR));

    expect(
      routes.filter((r) => r.file.includes("authz") || r.file.includes("auditEmitter")),
    ).toEqual([]);
  });
});
