import { writeFile } from "node:fs/promises";
import path from "node:path";

import { Validator } from "@seriousme/openapi-schema-validator";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createApp } from "../app";
import { createUnusableDatabase } from "../db/unusable";
import { createInflightTracker } from "../lifecycle";
import { createLogger } from "../logger";
import { KeyStore } from "../modules/auth";
import { createUnusableRedis } from "../redis-unusable";

import { buildOpenApiDocument } from "./document";
import { PROBLEM_STATUSES } from "./responses";

/**
 * ST-060: document-wide invariants.
 *
 * These are the actual guarantee behind the contract requirements. standardResponses' type signature
 * makes forgetting the X-Request-Id header or the problem+json envelope awkward, but a hand-written
 * object literal still satisfies RouteConfig — so the enforcement has to be a walk of the generated
 * document, which is what this file is.
 *
 * The sample is three operations, and that is worth being honest about: "every operation documents
 * problem+json" is currently three assertions. The value is as a ratchet — the fourth operation
 * cannot be added without satisfying them.
 */

const COMMITTED_SPEC = path.join(import.meta.dir, "..", "..", "openapi.json");

/** The extension the generator prepends. Not part of the document zod-to-openapi builds. */
const BANNER_KEY = "x-generated-by";

const document = await buildOpenApiDocument();

/**
 * The document as JSON — exactly what the generator writes to disk and the server puts on the wire.
 *
 * Every assertion below runs against this rather than the in-memory object, and that is deliberate:
 * JSON.stringify drops undefined-valued keys and anything non-serializable, so this is the artifact
 * itself rather than an object that merely resembles it. It also gives the validator the plain
 * index-signature object it expects.
 */
const serialized = JSON.parse(JSON.stringify(document)) as Record<string, never>;

interface Operation {
  operationId?: string;
  tags?: string[];
  security?: unknown[];
  responses: Record<string, ResponseObject>;
}

interface ResponseObject {
  headers?: Record<string, { required?: boolean; schema?: { format?: string } }>;
  content?: Record<string, { schema?: { $ref?: string } }>;
}

/** Every (path, method, operation) in the document, so a test can walk it without nesting loops. */
const operations: { path: string; method: string; operation: Operation }[] = Object.entries(
  document.paths ?? {},
).flatMap(([routePath, item]) =>
  Object.entries(item as Record<string, Operation>)
    // A path item can hold non-operation members (parameters, summary); only verbs are operations.
    .filter(([method]) =>
      ["get", "put", "post", "delete", "patch", "options", "head"].includes(method),
    )
    .map(([method, operation]) => ({ path: routePath, method, operation })),
);

describe("structure", () => {
  test("is a structurally valid OpenAPI 3.1 document", async () => {
    const validator = new Validator();

    const result = await validator.validate(serialized);

    // The errors are the useful part of a failure; toBe(true) alone would say only "no".
    expect(result.errors ?? [], JSON.stringify(result.errors, null, 2)).toEqual([]);
    expect(result.valid).toBe(true);
    // `valid` alone would also pass a 3.0 document. The ticket asks for 3.1 specifically, and the
    // nullable type unions the components rely on are 3.1-only syntax.
    expect(validator.version).toBe("3.1");
  });

  test("declares OpenAPI 3.1.0", () => {
    expect(document.openapi).toBe("3.1.0");
  });

  // A plain Hono sub-app mounted on an OpenAPIHono keeps serving traffic while contributing nothing
  // to the document, silently. This is the guard against that regression.
  test("contains every mounted route", () => {
    expect(Object.keys(document.paths ?? {}).sort()).toEqual(
      [
        "/.well-known/jwks.json",
        "/api/admin/subscriptions/sync-prices",
        "/api/admin/users/{userId}/devices",
        "/api/admin/users/{userId}/devices/{deviceId}",
        "/api/admin/users/{userId}/providers/{provider}",
        "/api/admin/users/{userId}/sessions",
        // AI entitlement/quota-gated surface (ST-155 and siblings). Mounted only `if (database &&
        // redis && entitlements)` — see app.ts's AI gate section — so these were invisible to this
        // document until OpenAPI generation started passing a real (if inert) Redis placeholder
        // instead of null. See redis-unusable.ts.
        "/api/ai/admin/metrics",
        "/api/ai/consent",
        "/api/ai/health",
        "/api/ai/moderation/reports",
        "/api/ai/moderation/reports/{reportId}",
        "/api/ai/students/{studentId}/ask",
        "/api/ai/students/{studentId}/concepts",
        "/api/ai/students/{studentId}/decks",
        "/api/ai/students/{studentId}/decks/{deckId}/review",
        "/api/ai/students/{studentId}/exams",
        "/api/ai/students/{studentId}/exams/{examId}",
        "/api/ai/students/{studentId}/exams/{examId}/start",
        "/api/ai/students/{studentId}/exams/{examId}/submit",
        "/api/ai/students/{studentId}/explain",
        "/api/ai/students/{studentId}/generate",
        "/api/ai/students/{studentId}/messages/{messageId}/report",
        "/api/ai/students/{studentId}/quizzes",
        "/api/ai/students/{studentId}/quizzes/{quizId}/grade",
        "/api/ai/students/{studentId}/reports",
        "/api/ai/students/{studentId}/search",
        "/api/ai/students/{studentId}/summarize",
        "/api/ai/usage",
        // The caller's paid features (docs/billing/feature-licensing.md). Mounted with the feature
        // service, which needs a database -- like the AI surface, present here through the inert
        // placeholders.
        "/api/me/features",
        // School feature licenses (modules/licensing): the school's own seats, and the super admin's
        // license console under /api/platform.
        "/api/school/license",
        "/api/school/license/change-requests",
        "/api/school/license/eligible",
        "/api/school/license/seats",
        "/api/school/license/seats/{seatId}",
        "/api/platform/schools/{schoolId}/license-requests",
        "/api/platform/schools/{schoolId}/license-requests/{requestId}/resolve",
        "/api/platform/schools/{schoolId}/licenses",
        "/api/platform/schools/{schoolId}/licenses/{licenseId}",
        "/api/platform/schools/{schoolId}/licenses/{licenseId}/extend",
        "/api/platform/schools/{schoolId}/licenses/{licenseId}/seats",
        "/api/platform/schools/{schoolId}/licenses/{licenseId}/seats/{seatId}",
        "/api/platform/schools/{schoolId}/licenses/{licenseId}/status",
        // License billing (session 3): the school's quotes, invoices, receipts and payments, and the
        // super admin's pricing, quotes, invoices, payments and finance totals.
        "/api/school/license/quotes",
        "/api/school/license/quotes/{quoteId}",
        "/api/school/license/quotes/{quoteId}/accept",
        "/api/school/license/invoices",
        "/api/school/license/invoices/{invoiceId}",
        "/api/school/license/invoices/{invoiceId}/receipts",
        "/api/school/license/payments",
        "/api/school/license/receipts/{receiptId}/file",
        "/api/platform/licenses/price-settings",
        "/api/platform/licenses/price-settings/{currencyCode}",
        "/api/platform/licenses/bank-details",
        "/api/platform/licenses/quote",
        "/api/platform/licenses/invoices",
        "/api/platform/licenses/receipts",
        "/api/platform/licenses/finance",
        "/api/platform/schools/{schoolId}/license-quotes",
        "/api/platform/schools/{schoolId}/license-quotes/{quoteId}",
        "/api/platform/schools/{schoolId}/license-quotes/{quoteId}/send",
        "/api/platform/schools/{schoolId}/license-quotes/{quoteId}/accept",
        "/api/platform/schools/{schoolId}/license-quotes/{quoteId}/withdraw",
        "/api/platform/schools/{schoolId}/license-invoices/{invoiceId}",
        "/api/platform/schools/{schoolId}/license-invoices/{invoiceId}/void",
        "/api/platform/schools/{schoolId}/license-invoices/{invoiceId}/activate-early",
        "/api/platform/schools/{schoolId}/license-invoices/{invoiceId}/payments",
        "/api/platform/schools/{schoolId}/license-payments/{paymentId}/void",
        "/api/platform/schools/{schoolId}/license-payments/upload-url",
        "/api/platform/schools/{schoolId}/license-payments/{paymentId}/receipt-file",
        "/api/platform/schools/{schoolId}/license-receipts/{receiptId}/match",
        "/api/platform/schools/{schoolId}/license-receipts/{receiptId}/file",
        "/api/announcements",
        "/api/school-events",
        "/api/school-events/{eventId}",
        "/api/messaging/contacts",
        "/api/messaging/conversations",
        "/api/messaging/conversations/{conversationId}",
        "/api/messaging/conversations/{conversationId}/block",
        "/api/messaging/conversations/{conversationId}/messages",
        "/api/messaging/conversations/{conversationId}/profile",
        "/api/messaging/conversations/{conversationId}/read",
        "/api/messaging/conversations/{conversationId}/reports",
        "/api/messaging/reports",
        "/api/messaging/reports/{reportId}",
        "/api/messaging/teacher-contacts",
        "/api/messaging/teacher-conversations",
        "/api/attendance/records/batch",
        "/api/attendance/records/{recordId}",
        "/api/attendance/records/{recordId}/history",
        "/api/attendance/reports/export",
        "/api/attendance/reports/export/{jobId}",
        "/api/attendance/reports/summary",
        "/api/attendance/reports/trends",
        "/api/attendance/sessions",
        "/api/attendance/sessions/{sessionId}",
        "/api/attendance/classes/{classId}/roster",
        "/api/attendance/sessions/{sessionId}/records",
        "/api/attendance/students/{studentId}/records",
        "/api/audit/logs",
        "/api/audit/logs/export",
        "/api/audit/logs/export/{jobId}",
        "/api/discipline/incidents",
        "/api/discipline/incidents/{incidentId}",
        "/api/discipline/incidents/{incidentId}/actions",
        "/api/discipline/incidents/{incidentId}/actions/{actionId}",
        "/api/discipline/incidents/{incidentId}/resolve",
        "/api/finance/fee-structures",
        "/api/finance/fee-structures/{feeStructureId}",
        "/api/finance/fee-structures/{feeStructureId}/students",
        "/api/finance/fee-schedules/generate",
        "/api/finance/invoices",
        "/api/finance/invoices/{invoiceId}",
        "/api/finance/invoices/batches",
        "/api/finance/invoices/batches/{batchId}",
        "/api/finance/invoices/batches/{batchId}/items",
        "/api/finance/expenses",
        "/api/finance/expenses/{expenseId}",
        "/api/finance/expenses/summary",
        "/api/finance/expenses/upload-url",
        "/api/finance/expenses/{expenseId}/attachments",
        "/api/finance/payments",
        "/api/finance/payments/{paymentId}",
        "/api/finance/online-payments",
        "/api/finance/online-payments/{paymentId}",
        // Refund processing (ST-124). Maker-checker workflow with ERPNext Credit Notes.
        "/api/finance/refunds",
        "/api/finance/refunds/{refundId}",
        "/api/finance/refunds/{refundId}/approve",
        "/api/finance/refunds/{refundId}/reject",
        "/api/finance/scholarships",
        "/api/finance/scholarships/{scholarshipId}",
        "/api/finance/scholarship-awards",
        "/api/finance/students",
        "/api/finance/scholarship-awards/{awardId}/approve",
        "/api/finance/scholarship-awards/{awardId}/reject",
        "/api/finance/scholarship-awards/{awardId}/revoke",
        "/api/finance/sibling-discount",
        "/api/finance/families",
        "/api/finance/families/{familyId}/profile",
        "/api/finance/families/{familyId}/payments",
        "/api/finance/families/{familyId}/reminders",
        "/api/finance/families/{familyId}/statements",
        "/api/finance/reminders",
        "/api/finance/payments/{paymentId}/receipt",
        "/api/finance/refunds/initiate",
        "/api/finance/reports/ar-aging",
        "/api/finance/reports/collections-vs-due",
        "/api/finance/reports/export",
        "/api/finance/reports/export/{jobId}",
        "/api/finance/reports/family-statement/{familyId}",
        "/api/finance/reports/general-ledger",
        "/api/finance/reports/joinvoice/{invoiceId}",
        // ST-121. Public by design: authenticated by HMAC over the raw body, so it is absent from the
        // authentication-boundary list below.
        "/api/finance/webhooks/erpnext/payment-confirmed",
        // ST-124. Same HMAC-based auth as payment-confirmed; absent from the auth-boundary list below.
        "/api/finance/webhooks/erpnext/refund-processed",
        "/api/finance/reconciliation/run",
        // ST-127. Parent-facing household financial view.
        "/api/finance/families/{familyId}",
        "/api/finance/students/{studentId}/installments",
        // ST-257. Public, un-scoped, mounted unconditionally alongside the health probes.
        "/api/mobile/config",
        // Same endpoint, canonical name (ST-283).
        "/meta/mobile-versions",
        "/api/evaluations",
        "/api/evaluations/{evaluationId}",
        "/api/evaluations/{evaluationId}/scores",
        "/api/evaluations/{evaluationId}/scores/{criteriaTemplateId}",
        "/api/evaluations/{evaluationId}/share",
        "/api/evaluations/{evaluationId}/submit",
        "/api/evaluations/templates",
        "/api/evaluations/templates/{templateId}",
        "/api/families",
        "/api/families/{familyId}",
        "/api/families/{familyId}/links",
        "/api/families/{familyId}/links/{parentUserId}/{studentId}",
        "/api/academics/assignments",
        "/api/academics/assignments/{assignmentId}",
        "/api/academics/assignments/{assignmentId}/attachments",
        "/api/academics/assignments/{assignmentId}/attachments/upload-url",
        "/api/academics/assignments/{assignmentId}/attachments/{attachmentId}",
        "/api/academics/assignments/{assignmentId}/questions",
        "/api/academics/assignments/{assignmentId}/submissions",
        "/api/academics/submissions/{submissionId}",
        "/api/academics/submissions/{submissionId}/grade",
        "/api/academics/submissions/{submissionId}/attachments",
        "/api/academics/submissions/{submissionId}/attachments/upload-url",
        "/api/academics/submissions/{submissionId}/attachments/{attachmentId}",
        "/api/academics/classes",
        "/api/academics/classes/{classId}",
        "/api/academics/classes/{classId}/enrollments",
        "/api/academics/rooms",
        "/api/academics/sections",
        "/api/academics/sections/{sectionId}",
        "/api/academics/sections/{sectionId}/students",
        "/api/academics/sections/{sectionId}/students/{studentId}",
        // Academic grading (000160).
        "/api/grading/assessments/{assessmentId}/decision",
        "/api/grading/certificates",
        "/api/grading/certificates/{certificateId}",
        "/api/grading/certificates/{certificateId}/reissue",
        "/api/grading/certificates/{certificateId}/revoke",
        "/api/grading/finalizations",
        "/api/grading/finalizations/{finalizationId}",
        "/api/grading/finalizations/{finalizationId}/certificates",
        "/api/grading/finalizations/{finalizationId}/certificates/readiness",
        "/api/grading/finalizations/{finalizationId}/corrections",
        "/api/grading/mark-sheets/{sheetId}/decision",
        "/api/grading/my-assignments",
        "/api/grading/scales/{scaleId}",
        "/api/grading/sections/{sectionId}/results/finalize",
        "/api/grading/sections/{sectionId}/results/preview",
        "/api/grading/sections/{sectionId}/subject-enrollments",
        "/api/grading/sections/{sectionId}/subjects",
        "/api/grading/sections/{sectionId}/subjects/{subjectId}/assessments",
        "/api/grading/sections/{sectionId}/subjects/{subjectId}/mark-sheets/submit",
        "/api/grading/sections/{sectionId}/subjects/{subjectId}/marks",
        "/api/grading/sections/{sectionId}/subjects/{subjectId}/override",
        "/api/grading/students/{studentId}/certificates",
        "/api/grading/students/{studentId}/results",
        "/api/grading/subject-configs/{configId}",
        "/api/grading/subject-configs/{configId}/impact",
        "/api/grading/subject-configs/{configId}/keep",
        "/api/grading/subject-configs/{configId}/reset",
        "/api/grading/teacher-assignments",
        "/api/grading/teacher-assignments/{assignmentId}",
        "/api/grading/years/{yearId}/copy",
        "/api/grading/years/{yearId}/mark-sheets",
        "/api/grading/years/{yearId}/overview",
        "/api/grading/years/{yearId}/programs",
        "/api/grading/years/{yearId}/programs/{gradeLevelId}",
        "/api/grading/years/{yearId}/programs/{gradeLevelId}/subjects",
        "/api/grading/years/{yearId}/proposed-assessments",
        "/api/grading/years/{yearId}/publish-check",
        "/api/grading/years/{yearId}/scales",
        "/api/grading/years/{yearId}/status",
        "/api/grading/years/{yearId}/teacher-assignments",
        "/api/academics/classes/{classId}/enrollments/transfer",
        "/api/academics/classes/{classId}/enrollments/{studentId}",
        "/api/academics/courses/{courseId}",
        "/api/academics/exams",
        "/api/academics/exams/{examId}",
        "/api/academics/grade-levels",
        "/api/academics/grade-levels/{gradeLevelId}",
        "/api/academics/materials",
        "/api/academics/materials/{materialId}",
        "/api/academics/materials/{materialId}/ai-visible",
        "/api/academics/materials/{materialId}/confirm",
        "/api/academics/materials/upload",
        "/api/grades/config/gradebooks/{gradebookId}/categories",
        "/api/grades/config/gradebooks/{gradebookId}/categories/{categoryId}",
        "/api/grades/config/gradebooks/{gradebookId}/scheme",
        "/api/grades/config/gradebooks/{gradebookId}/scheme/link",
        "/api/grades/config/schemes",
        "/api/grades/config/schemes/{schemeId}",
        "/api/grades/gradebooks",
        "/api/grades/gradebooks/{gradebookId}/assessments",
        "/api/grades/gradebooks/{gradebookId}/entry",
        "/api/grades/gradebooks/{gradebookId}/grades",
        "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/submit",
        "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/decide",
        "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/unlock",
        "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/revisions",
        "/api/grades/gradebooks/{gradebookId}/revisions/{revisionId}/withdraw",
        "/api/grades/published/students/{studentId}/terms/{termId}",
        "/api/academics/subjects",
        "/api/academics/subjects/{subjectId}",
        "/api/academics/subjects/{subjectId}/courses",
        "/api/academics/slots/{slotId}",
        "/api/academics/timetable-settings",
        "/api/academics/timetable-versions",
        "/api/academics/timetable-versions/{versionId}",
        "/api/academics/timetable-versions/{versionId}/approve",
        "/api/academics/timetable-versions/{versionId}/publish",
        "/api/academics/timetable-versions/{versionId}/reject",
        "/api/academics/timetable-versions/{versionId}/slots",
        "/api/academics/timetable-versions/{versionId}/submit",
        "/api/academics/timetable-versions/copy",
        "/api/academics/years",
        "/api/academics/years/{yearId}",
        "/api/academics/years/{yearId}/rollover",
        "/api/academics/years/{yearId}/terms",
        "/api/academics/terms/{termId}",
        "/api/auth/devices",
        "/api/auth/devices/{deviceId}",
        "/api/auth/devices/{deviceId}/sessions",
        "/api/auth/invitations/{token}/activate",
        "/api/auth/invitations/{token}/verify",
        "/api/auth/invitations/{token}/oauth/google/mobile-start",
        "/api/auth/invitations/{token}/oauth/google/mobile-exchange",
        "/api/auth/invitations/{token}/oauth/microsoft/mobile-start",
        "/api/auth/invitations/{token}/oauth/microsoft/mobile-exchange",
        "/api/auth/invitations/{token}/oauth/mock/mobile-start",
        "/api/auth/invitations/{token}/oauth/mock/mobile-exchange",
        "/api/auth/login/member",
        "/api/auth/login/oauth",
        "/api/auth/login/review",
        "/api/auth/logout",
        "/api/auth/password/change",
        "/api/auth/oauth/google/mobile-start",
        "/api/auth/oauth/google/mobile-exchange",
        "/api/auth/oauth/microsoft/mobile-start",
        "/api/auth/oauth/microsoft/mobile-exchange",
        "/api/auth/oauth/mock/mobile-start",
        "/api/auth/oauth/mock/mobile-exchange",
        "/api/auth/providers",
        "/api/auth/providers/link/start",
        "/api/auth/providers/{provider}",
        "/api/auth/refresh",
        "/api/auth/sessions",
        "/api/auth/sessions/{sessionId}",
        "/api/auth/sessions/revoke-others",
        "/api/imports/students",
        "/api/imports/students/template",
        "/api/imports/students/upload",
        "/api/imports/students/{importId}",
        "/api/imports/students/{importId}/confirm",
        "/api/imports/students/{importId}/mapping",
        "/api/imports/students/{importId}/diff",
        "/api/imports/students/mappings",
        "/api/imports/students/mappings/{mappingId}",
        "/api/invitations",
        "/api/invitations/bulk",
        "/api/invitations/bulk/{bulkInviteId}",
        "/api/invitations/bulk/{bulkInviteId}/recipients",
        "/api/invitations/bulk/{bulkInviteId}/retry",
        "/api/invitations/{id}/regenerate",
        "/api/invitations/{id}/revoke",
        // Reference-data lookups (ST-184). Public, read-only; feeds the school
        // self-registration form's country/currency selectors.
        "/api/lookups/countries",
        "/api/lookups/currencies",
        // In-app inbox (ST-142). Personal per-recipient notifications: list, unread count,
        // and read-state mutations, all RLS-fenced to the authenticated user.
        "/api/notifications",
        "/api/notifications/read-all",
        "/api/notifications/{notificationId}/read",
        "/api/notifications/unread-count",
        // Notification preferences (ST-143). Per-user channel toggles, digest mode, and personal
        // attendance-alert threshold, all RLS-fenced to the authenticated user.
        "/api/notification-preferences",
        // Data subject requests (ST-268). File and check the status of a GDPR export/erasure
        // request for one user, PRIVACY_DSR_MANAGE-gated.
        "/api/privacy/dsr",
        "/api/privacy/dsr/{requestId}",
        // Self-service account deletion/export (ST-268 extension). Bearer-authenticated only --
        // the caller may only ever act on their own account.
        "/api/privacy/me/dsr",
        "/api/platform/finance",
        "/api/platform/inquiries",
        "/api/platform/inquiries/{inquiryId}",
        "/api/platform/overview",
        "/api/platform/plans",
        "/api/platform/plans/{planId}",
        "/api/platform/plans/{planId}/prices/{priceId}",
        "/api/platform/refund-requests",
        "/api/platform/refund-requests/{schoolId}/{requestId}",
        "/api/platform/refund-requests/{schoolId}/{requestId}/approve",
        "/api/platform/refund-requests/{schoolId}/{requestId}/reject",
        "/api/platform/school-applications",
        "/api/platform/school-applications/{applicationId}",
        "/api/platform/school-applications/{applicationId}/approve",
        "/api/platform/school-applications/{applicationId}/reject",
        "/api/platform/schools",
        "/api/platform/schools/{schoolId}",
        "/api/platform/schools/{schoolId}/feature-flags/{flagName}",
        "/api/platform/schools/{schoolId}/members",
        "/api/platform/schools/{schoolId}/status",
        "/api/platform/settings",
        "/api/platform/settings/{key}",
        "/api/platform/users/lookup",
        // Self-service account deletion and profile. Bearer-authenticated; the caller is the subject.
        "/api/account/deletion",
        "/api/account/profile",
        // Public account deletion (ST-302). Unauthenticated: captcha, then an emailed token.
        "/api/account/deletion-requests",
        "/api/account/deletion-requests/confirm",
        // Public "Talk to us" sales inquiry. Unauthenticated: captcha-gated.
        "/api/inquiries",
        // Parent child comparison reports (ST-177). PARENT-role-gated metrics over linked children.
        "/api/reports/children/comparison",
        "/api/reports/children/{studentId}/breakdown",
        "/api/reports/children/{studentId}/timetable",
        "/api/school-applications/me",
        "/api/school-applications/me/proof-upload-url",
        "/api/school-applications/me/sign-out",
        "/api/schools/current",
        "/api/schools/current/closure",
        "/api/schools/current/settings",
        "/api/schools/register",
        "/api/schools/resend-verification",
        "/api/schools/verify-email/{token}",
        "/api/schools/{schoolId}/provision",
        "/api/schools/{schoolId}/provisioning-status",
        "/api/search",
        "/api/storage/downloads/{contentClass}/{objectId}",
        "/api/storage/uploads/confirm",
        "/api/storage/uploads/request-upload",
        "/api/students",
        "/api/students/me",
        "/api/students/{studentId}",
        "/api/students/{studentId}/guardians",
        "/api/students/{studentId}/guardians/{userId}",
        "/api/subscriptions/ai/checkout",
        "/api/subscriptions/ai/refund-requests",
        "/api/subscriptions/ai/offer",
        "/api/subscriptions/ai/store/config",
        "/api/subscriptions/ai/store/purchases",
        "/api/subscriptions/checkout",
        "/api/subscriptions/current",
        "/api/subscriptions/current/cancel",
        "/api/subscriptions/current/cancel/reverse",
        "/api/subscriptions/current/invoices",
        "/api/subscriptions/current/refund-requests",
        "/api/subscriptions/plans",
        "/api/subscriptions/portal",
        "/api/subscriptions/school/checkout",
        "/api/subscriptions/webhook/apple",
        "/api/subscriptions/webhook/google",
        "/api/subscriptions/webhook/stripe",
        "/api/subscriptions/webhook/tap",
        "/api/teachers",

        "/api/approvals/bulk-decision",
        "/api/approvals/queue",
        "/api/teachers/me",
        "/api/teachers/{teacherId}",
        "/api/users",
        "/api/users/member-summary",
        "/api/users/status-counts",
        "/api/users/{userId}",
        "/api/users/{userId}/deactivate",
        "/api/users/{userId}/password/reset",
        "/api/users/{userId}/role",
        "/email/webhooks/sns",
        "/erpnext/webhooks",
        "/healthz",
        "/readyz",
      ].sort(),
    );
  });

  test("has at least one operation", () => {
    expect(operations.length).toBeGreaterThan(0);
  });
});

describe("every operation", () => {
  test("documents an application/problem+json error response", () => {
    for (const { path: p, method, operation } of operations) {
      const problems = Object.entries(operation.responses).filter(
        ([, response]) => response.content?.["application/problem+json"] !== undefined,
      );

      expect(
        problems.length,
        `${method.toUpperCase()} ${p} documents no problem+json response`,
      ).toBeGreaterThan(0);

      for (const [status, response] of problems) {
        expect(
          response.content?.["application/problem+json"]?.schema?.$ref,
          `${method.toUpperCase()} ${p} ${status} does not reference the shared ProblemDetails`,
        ).toBe("#/components/schemas/ProblemDetails");
      }
    }
  });

  // requestIdMiddleware stamps this unconditionally, after next(), including on responses built by
  // app.onError — so every declared response must say so.
  test("declares the X-Request-Id header on every response", () => {
    for (const { path: p, method, operation } of operations) {
      for (const [status, response] of Object.entries(operation.responses)) {
        const header = response.headers?.["X-Request-Id"];

        expect(
          header,
          `${method.toUpperCase()} ${p} ${status} is missing X-Request-Id`,
        ).toBeDefined();
        expect(
          header!.required,
          `${method.toUpperCase()} ${p} ${status} X-Request-Id is optional`,
        ).toBe(true);
        expect(header!.schema?.format).toBe("uuid");
      }
    }
  });

  test("has an operationId", () => {
    for (const { path: p, method, operation } of operations) {
      expect(operation.operationId, `${method.toUpperCase()} ${p} has no operationId`).toBeTruthy();
    }
  });

  test("has a unique operationId", () => {
    const ids = operations.map(({ operation }) => operation.operationId);

    expect(ids.length).toBe(new Set(ids).size);
  });

  test("uses only tags the document declares", () => {
    const declared = new Set((document.tags ?? []).map((tag) => tag.name));

    for (const { path: p, method, operation } of operations) {
      for (const tag of operation.tags ?? []) {
        expect(declared.has(tag), `${method.toUpperCase()} ${p} uses undeclared tag "${tag}"`).toBe(
          true,
        );
      }
    }
  });

  // Documenting a failure the server has no code path to produce is as much a lie as omitting one it
  // does. PROBLEM_STATUSES is derived from errorHandlerMiddleware's own status maps.
  test("documents only problem statuses errorHandlerMiddleware can emit", () => {
    for (const { path: p, method, operation } of operations) {
      for (const [status, response] of Object.entries(operation.responses)) {
        if (response.content?.["application/problem+json"] === undefined) continue;

        expect(
          (PROBLEM_STATUSES as readonly number[]).includes(Number(status)),
          `${method.toUpperCase()} ${p} documents problem+json for un-emittable status ${status}`,
        ).toBe(true);
      }
    }
  });
});

describe("security", () => {
  test("declares the bearerAuth scheme", () => {
    expect(document.components?.securitySchemes?.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
  });

  /**
   * Every operation states its own security, and none inherits a root-level default.
   *
   * This test used to assert the stronger claim that nothing authenticates at all, which was true
   * until ST-070 mounted jwtAuthMiddleware and ST-071 added the first routes behind it — so the
   * name it carried until now ("requires no authentication anywhere") had stopped describing what
   * it checks. What survives from that version, and is the part worth keeping, is the requirement
   * that every operation says so *explicitly*: a document that omits `security` is ambiguous between
   * "public" and "the author forgot", and the two are indistinguishable to a client generator.
   *
   * `document.security` stays undefined deliberately. A root-level requirement would claim the whole
   * API is authenticated, which is false — /healthz, /readyz, the JWKS endpoint, the webhook, and
   * the two refresh-token endpoints are all reachable without a bearer token — and a reader would
   * have to diff each operation's override against it to find out which.
   */
  test("states security explicitly on every operation, with no root-level default", () => {
    expect(document.security).toBeUndefined();

    for (const { path: p, method, operation } of operations) {
      const hasBearerAuth = (operation.security ?? []).some(
        (s) => typeof s === "object" && s !== null && "bearerAuth" in s,
      );
      if (hasBearerAuth) continue;

      expect(
        operation.security,
        `${method.toUpperCase()} ${p} does not state its security`,
      ).toBeDefined();
    }
  });

  /**
   * The authenticated set matches what jwtAuthMiddleware actually enforces.
   *
   * Pinned rather than derived, because the document and the middleware are two independent
   * statements of the same fact and the point is to catch them disagreeing. A route that gains
   * `security: [{ bearerAuth: [] }]` without being moved behind the boundary — or, far worse, one
   * dropped from DEFAULT_PUBLIC_PATHS while still documented as public — fails here.
   */
  test("marks exactly the routes behind the authentication boundary", () => {
    const authenticated = operations
      .filter(({ operation }) => (operation.security ?? []).length > 0)
      .map(({ method, path: p }) => `${method.toUpperCase()} ${p}`)
      .sort();

    expect(authenticated).toEqual(
      [
        // Device revocation (ST-072). The two /api/admin routes are authenticated *and* gated on
        // PERMISSIONS.USER_SUSPEND by middleware/authz.ts — a distinction this document cannot
        // express, since bearerAuth covers only the first half. See routes/admin-device-routes.ts.
        "DELETE /api/admin/users/{userId}/devices",
        "DELETE /api/admin/users/{userId}/devices/{deviceId}",
        "DELETE /api/admin/users/{userId}/providers/{provider}",
        "GET /api/admin/users/{userId}/devices",
        "GET /api/admin/users/{userId}/sessions",
        "GET /api/ai/admin/metrics",
        // AI data-sharing consent (ST-305). Self-service on the caller's own consent record.
        "GET /api/ai/consent",
        "PUT /api/ai/consent",
        "DELETE /api/ai/consent",
        // AI moderation queue (ST-306). Authenticated *and* gated on aiContent:moderate by
        // middleware/authz.ts, which bearerAuth cannot express. See routes/moderation-routes.ts.
        "GET /api/ai/moderation/reports",
        "GET /api/ai/moderation/reports/{reportId}",
        "PATCH /api/ai/moderation/reports/{reportId}",
        "GET /api/ai/students/{studentId}/decks/{deckId}/review",
        "GET /api/ai/students/{studentId}/exams/{examId}",
        "GET /api/ai/usage",
        // The caller's own paid features. Self-service: the caller is always the subject.
        "GET /api/me/features",
        // School feature licenses. Authenticated *and* gated by middleware/authz.ts -- license:read /
        // license:manage on the school's side, platform:read / platform:manage on the console's.
        "GET /api/school/license",
        "GET /api/school/license/seats",
        "POST /api/school/license/seats",
        "DELETE /api/school/license/seats/{seatId}",
        "GET /api/school/license/eligible",
        "POST /api/school/license/change-requests",
        "GET /api/platform/schools/{schoolId}/licenses",
        "POST /api/platform/schools/{schoolId}/licenses",
        "GET /api/platform/schools/{schoolId}/licenses/{licenseId}",
        "PATCH /api/platform/schools/{schoolId}/licenses/{licenseId}",
        "POST /api/platform/schools/{schoolId}/licenses/{licenseId}/status",
        "POST /api/platform/schools/{schoolId}/licenses/{licenseId}/extend",
        "GET /api/platform/schools/{schoolId}/licenses/{licenseId}/seats",
        "POST /api/platform/schools/{schoolId}/licenses/{licenseId}/seats",
        "DELETE /api/platform/schools/{schoolId}/licenses/{licenseId}/seats/{seatId}",
        "GET /api/platform/schools/{schoolId}/license-requests",
        "POST /api/platform/schools/{schoolId}/license-requests/{requestId}/resolve",
        // License billing: license:read / license:manage, platform:read / platform:manage.
        "GET /api/school/license/quotes",
        "GET /api/school/license/quotes/{quoteId}",
        "POST /api/school/license/quotes/{quoteId}/accept",
        "GET /api/school/license/invoices",
        "GET /api/school/license/invoices/{invoiceId}",
        "POST /api/school/license/invoices/{invoiceId}/receipts",
        "GET /api/school/license/payments",
        "GET /api/school/license/receipts/{receiptId}/file",
        "GET /api/platform/licenses/price-settings",
        "PUT /api/platform/licenses/price-settings/{currencyCode}",
        "GET /api/platform/licenses/bank-details",
        "PUT /api/platform/licenses/bank-details",
        "POST /api/platform/licenses/quote",
        "GET /api/platform/licenses/invoices",
        "GET /api/platform/licenses/receipts",
        "GET /api/platform/licenses/finance",
        "GET /api/platform/schools/{schoolId}/license-quotes",
        "POST /api/platform/schools/{schoolId}/license-quotes",
        "GET /api/platform/schools/{schoolId}/license-quotes/{quoteId}",
        "PUT /api/platform/schools/{schoolId}/license-quotes/{quoteId}",
        "POST /api/platform/schools/{schoolId}/license-quotes/{quoteId}/send",
        "POST /api/platform/schools/{schoolId}/license-quotes/{quoteId}/accept",
        "POST /api/platform/schools/{schoolId}/license-quotes/{quoteId}/withdraw",
        "GET /api/platform/schools/{schoolId}/license-invoices/{invoiceId}",
        "POST /api/platform/schools/{schoolId}/license-invoices/{invoiceId}/void",
        "POST /api/platform/schools/{schoolId}/license-invoices/{invoiceId}/activate-early",
        "POST /api/platform/schools/{schoolId}/license-invoices/{invoiceId}/payments",
        "POST /api/platform/schools/{schoolId}/license-payments/{paymentId}/void",
        "POST /api/platform/schools/{schoolId}/license-payments/upload-url",
        "GET /api/platform/schools/{schoolId}/license-payments/{paymentId}/receipt-file",
        "POST /api/platform/schools/{schoolId}/license-receipts/{receiptId}/match",
        "GET /api/platform/schools/{schoolId}/license-receipts/{receiptId}/file",
        "DELETE /api/academics/classes/{classId}",
        "DELETE /api/academics/classes/{classId}/enrollments/{studentId}",
        "DELETE /api/academics/assignments/{assignmentId}",
        "DELETE /api/academics/assignments/{assignmentId}/attachments/{attachmentId}",
        "DELETE /api/academics/submissions/{submissionId}/attachments/{attachmentId}",
        "DELETE /api/academics/courses/{courseId}",
        "DELETE /api/academics/exams/{examId}",
        "DELETE /api/academics/grade-levels/{gradeLevelId}",
        "DELETE /api/academics/sections/{sectionId}",
        "DELETE /api/academics/sections/{sectionId}/students/{studentId}",
        "DELETE /api/academics/materials/{materialId}",
        "DELETE /api/academics/slots/{slotId}",
        "DELETE /api/grades/config/gradebooks/{gradebookId}/categories/{categoryId}",
        "DELETE /api/academics/subjects/{subjectId}",
        "DELETE /api/academics/timetable-versions/{versionId}",
        "DELETE /api/academics/years/{yearId}",
        "DELETE /api/account/deletion",
        "DELETE /api/academics/terms/{termId}",
        "DELETE /api/auth/devices/{deviceId}",
        "DELETE /api/auth/devices/{deviceId}/sessions",
        "DELETE /api/auth/providers/{provider}",
        "DELETE /api/auth/sessions/{sessionId}",
        "POST /api/auth/sessions/revoke-others",
        "DELETE /api/students/{studentId}/guardians/{userId}",
        "DELETE /api/evaluations/templates/{templateId}",
        "DELETE /api/evaluations/{evaluationId}/scores/{criteriaTemplateId}",
        "DELETE /api/families/{familyId}",
        "DELETE /api/families/{familyId}/links/{parentUserId}/{studentId}",
        "GET /api/discipline/incidents",
        "GET /api/discipline/incidents/{incidentId}",
        "GET /api/discipline/incidents/{incidentId}/actions",
        "GET /api/finance/fee-structures",
        "GET /api/finance/invoices",
        "GET /api/finance/invoices/{invoiceId}",
        "GET /api/finance/invoices/batches",
        "GET /api/finance/invoices/batches/{batchId}",
        "GET /api/finance/invoices/batches/{batchId}/items",
        "GET /api/finance/expenses",
        "GET /api/finance/expenses/summary",
        "GET /api/finance/expenses/{expenseId}",
        "GET /api/finance/payments",
        "GET /api/finance/payments/{paymentId}",
        "GET /api/finance/online-payments/{paymentId}",
        "GET /api/finance/refunds",
        "GET /api/finance/refunds/{refundId}",
        "GET /api/finance/reports/ar-aging",
        "GET /api/finance/reports/collections-vs-due",
        "GET /api/finance/reports/export/{jobId}",
        "GET /api/finance/reports/family-statement/{familyId}",
        "GET /api/finance/reports/general-ledger",
        "GET /api/finance/reports/joinvoice/{invoiceId}",
        "GET /api/finance/families/{familyId}",
        "GET /api/finance/students/{studentId}/installments",
        "GET /api/academics/assignments",
        "GET /api/academics/assignments/{assignmentId}",
        "GET /api/academics/assignments/{assignmentId}/submissions",
        "GET /api/academics/submissions/{submissionId}",
        "GET /api/academics/classes",
        "GET /api/academics/classes/{classId}",
        "GET /api/academics/classes/{classId}/enrollments",
        "GET /api/academics/rooms",
        "GET /api/academics/courses/{courseId}",
        "GET /api/academics/exams",
        "GET /api/academics/exams/{examId}",
        "GET /api/academics/grade-levels",
        "GET /api/academics/sections",
        "GET /api/academics/sections/{sectionId}",
        "GET /api/academics/sections/{sectionId}/students",
        "GET /api/academics/materials",
        "GET /api/academics/materials/{materialId}",
        "GET /api/academics/slots/{slotId}",
        "GET /api/grades/config/gradebooks/{gradebookId}/categories",
        "GET /api/grades/config/gradebooks/{gradebookId}/scheme",
        "GET /api/grades/config/schemes",
        "GET /api/grades/config/schemes/{schemeId}",
        "GET /api/grades/gradebooks",
        "GET /api/grades/gradebooks/{gradebookId}/entry",
        "GET /api/grades/published/students/{studentId}/terms/{termId}",
        "GET /api/academics/subjects",
        "GET /api/academics/subjects/{subjectId}",
        "GET /api/academics/subjects/{subjectId}/courses",
        "GET /api/academics/timetable-settings",
        "GET /api/academics/timetable-versions",
        "GET /api/academics/timetable-versions/{versionId}",
        "GET /api/academics/timetable-versions/{versionId}/slots",
        "GET /api/academics/years",
        "GET /api/academics/years/{yearId}",
        "GET /api/academics/years/{yearId}/terms",
        "GET /api/academics/terms/{termId}",
        "GET /api/attendance/records/{recordId}/history",
        "GET /api/attendance/reports/export/{jobId}",
        "GET /api/attendance/reports/summary",
        "GET /api/attendance/reports/trends",
        "GET /api/attendance/sessions",
        "GET /api/attendance/sessions/{sessionId}",
        "GET /api/attendance/classes/{classId}/roster",
        "GET /api/attendance/sessions/{sessionId}/records",
        "GET /api/attendance/students/{studentId}/records",
        "GET /api/announcements",
        "GET /api/school-events",
        "POST /api/school-events",
        "PATCH /api/school-events/{eventId}",
        "DELETE /api/school-events/{eventId}",
        // Parent<->teacher messaging (000127). Authenticated, permission-gated, participant-scoped.
        "GET /api/messaging/contacts",
        "GET /api/messaging/conversations",
        "POST /api/messaging/conversations",
        "GET /api/messaging/conversations/{conversationId}",
        "GET /api/messaging/conversations/{conversationId}/messages",
        "POST /api/messaging/conversations/{conversationId}/messages",
        "POST /api/messaging/conversations/{conversationId}/read",
        "GET /api/messaging/conversations/{conversationId}/profile",
        "POST /api/messaging/conversations/{conversationId}/block",
        "DELETE /api/messaging/conversations/{conversationId}/block",
        "POST /api/messaging/conversations/{conversationId}/reports",
        "GET /api/messaging/reports",
        "GET /api/messaging/reports/{reportId}",
        "PATCH /api/messaging/reports/{reportId}",
        // Teacher-initiated threads (000130).
        "GET /api/messaging/teacher-contacts",
        "POST /api/messaging/teacher-conversations",
        "GET /api/audit/logs",
        "GET /api/audit/logs/export/{jobId}",
        "GET /api/auth/devices",
        "GET /api/evaluations",
        "GET /api/evaluations/{evaluationId}",
        "GET /api/evaluations/{evaluationId}/scores",
        "GET /api/evaluations/templates",
        "GET /api/evaluations/templates/{templateId}",
        "GET /api/families",
        "GET /api/families/{familyId}",
        "GET /api/approvals/queue",
        "GET /api/auth/providers",
        "GET /api/auth/sessions",
        "GET /api/imports/students",
        "GET /api/imports/students/template",
        "GET /api/imports/students/{importId}",
        "GET /api/imports/students/{importId}/diff",
        "GET /api/imports/students/mappings",
        "GET /api/invitations",
        "GET /api/invitations/bulk",
        "GET /api/invitations/bulk/{bulkInviteId}",
        "GET /api/invitations/bulk/{bulkInviteId}/recipients",
        // In-app inbox (ST-142). Personal per-recipient notifications, RLS-fenced to the user.
        "GET /api/notifications",
        "GET /api/notifications/unread-count",
        // Notification preferences (ST-143). Self-service on the caller's own rows.
        "GET /api/notification-preferences",
        // Data subject requests (ST-268). Bearer-authenticated, then PRIVACY_DSR_MANAGE-gated.
        "GET /api/privacy/dsr/{requestId}",
        // Studafy platform console. Authenticated *and* gated on platform:read / platform:manage
        // (SUPER_ADMIN only) by middleware/authz.ts -- see modules/platform/routes.ts.
        "GET /api/platform/finance",
        "GET /api/platform/inquiries",
        "PATCH /api/platform/inquiries/{inquiryId}",
        "GET /api/platform/overview",
        "GET /api/platform/plans",
        "PATCH /api/platform/plans/{planId}",
        "PATCH /api/platform/plans/{planId}/prices/{priceId}",
        "GET /api/platform/refund-requests",
        "GET /api/platform/refund-requests/{schoolId}/{requestId}",
        "GET /api/platform/school-applications",
        "GET /api/platform/school-applications/{applicationId}",
        "POST /api/platform/refund-requests/{schoolId}/{requestId}/approve",
        "POST /api/platform/refund-requests/{schoolId}/{requestId}/reject",
        "POST /api/platform/school-applications/{applicationId}/approve",
        "POST /api/platform/school-applications/{applicationId}/reject",
        "GET /api/platform/schools",
        "GET /api/platform/schools/{schoolId}",
        "PUT /api/platform/schools/{schoolId}/feature-flags/{flagName}",
        "GET /api/platform/schools/{schoolId}/members",
        "PATCH /api/platform/schools/{schoolId}/status",
        "GET /api/platform/settings",
        "PATCH /api/platform/settings/{key}",
        "GET /api/platform/users/lookup",
        // Self-service account deletion/export history. Bearer-authenticated only.
        "GET /api/privacy/me/dsr",
        // Parent child comparison reports (ST-177). Bearer-authenticated, then PARENT-role-gated.
        "GET /api/reports/children/comparison",
        "GET /api/reports/children/{studentId}/breakdown",
        "GET /api/reports/children/{studentId}/timetable",
        "PATCH /api/notification-preferences",
        "GET /api/schools/current",
        "POST /api/schools/current/closure",
        "GET /api/schools/current/settings",
        "PATCH /api/schools/current/settings",
        "GET /api/students",
        "GET /api/students/me",
        "GET /api/students/{studentId}",
        "GET /api/students/{studentId}/guardians",
        "GET /api/subscriptions/ai/refund-requests",
        "GET /api/subscriptions/ai/offer",
        "GET /api/subscriptions/ai/store/config",
        "GET /api/subscriptions/current",
        "GET /api/subscriptions/current/invoices",
        "GET /api/subscriptions/current/refund-requests",
        "GET /api/teachers",
        "GET /api/teachers/me",
        "GET /api/teachers/{teacherId}",
        "GET /api/users",
        "GET /api/users/member-summary",
        "GET /api/users/status-counts",
        "GET /api/users/{userId}",
        "GET /api/schools/{schoolId}/provisioning-status",
        "GET /api/search",
        "GET /api/storage/downloads/{contentClass}/{objectId}",
        "PATCH /api/academics/assignments/{assignmentId}",
        "PATCH /api/academics/classes/{classId}",
        "PATCH /api/academics/courses/{courseId}",
        "PATCH /api/academics/exams/{examId}",
        "PATCH /api/academics/grade-levels/{gradeLevelId}",
        "PATCH /api/academics/sections/{sectionId}",
        "PATCH /api/academics/materials/{materialId}",
        "PATCH /api/academics/materials/{materialId}/ai-visible",
        "PATCH /api/academics/slots/{slotId}",
        "PATCH /api/attendance/records/{recordId}",
        "PATCH /api/attendance/sessions/{sessionId}",
        "PATCH /api/grades/config/gradebooks/{gradebookId}/categories/{categoryId}",
        "PATCH /api/grades/gradebooks/{gradebookId}/grades",
        "PATCH /api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/decide",
        "PATCH /api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/submit",
        "PATCH /api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/unlock",
        "POST /api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/revisions",
        "PATCH /api/grades/gradebooks/{gradebookId}/revisions/{revisionId}/withdraw",
        "PATCH /api/academics/subjects/{subjectId}",
        "PATCH /api/academics/timetable-versions/{versionId}",
        "PATCH /api/academics/years/{yearId}",
        "PATCH /api/academics/terms/{termId}",
        "PATCH /api/academics/submissions/{submissionId}/grade",
        "PATCH /api/evaluations/templates/{templateId}",
        "PATCH /api/evaluations/{evaluationId}",
        "PATCH /api/discipline/incidents/{incidentId}",
        "PATCH /api/discipline/incidents/{incidentId}/actions/{actionId}",
        "PATCH /api/finance/fee-structures/{feeStructureId}",
        "PUT /api/finance/fee-structures/{feeStructureId}/students",
        "GET /api/finance/fee-structures/{feeStructureId}/students",
        "PATCH /api/finance/expenses/{expenseId}",
        "PATCH /api/families/{familyId}",
        "PATCH /api/families/{familyId}/links/{parentUserId}/{studentId}",
        "PATCH /api/students/{studentId}",
        "PATCH /api/teachers/{teacherId}",
        "PATCH /api/users/{userId}",
        "PATCH /api/users/{userId}/deactivate",
        "PATCH /api/users/{userId}/role",
        "POST /api/academics/assignments",
        "POST /api/academics/assignments/{assignmentId}/attachments",
        "POST /api/academics/assignments/{assignmentId}/attachments/upload-url",
        "PUT /api/academics/assignments/{assignmentId}/questions",
        "POST /api/academics/assignments/{assignmentId}/submissions",
        "POST /api/academics/submissions/{submissionId}/attachments",
        "POST /api/academics/submissions/{submissionId}/attachments/upload-url",
        "POST /api/academics/classes",
        "POST /api/academics/classes/{classId}/enrollments",
        "POST /api/academics/classes/{classId}/enrollments/transfer",
        "POST /api/academics/exams",
        "POST /api/academics/grade-levels",
        "POST /api/academics/sections",
        "POST /api/academics/sections/{sectionId}/students",
        // Academic grading (000160). Every route is authenticated and permission-gated.
        "DELETE /api/grading/scales/{scaleId}",
        "DELETE /api/grading/subject-configs/{configId}",
        "DELETE /api/grading/teacher-assignments/{assignmentId}",
        "GET /api/grading/certificates",
        "GET /api/grading/certificates/{certificateId}",
        "GET /api/grading/finalizations",
        "GET /api/grading/finalizations/{finalizationId}",
        "GET /api/grading/finalizations/{finalizationId}/certificates/readiness",
        "GET /api/grading/my-assignments",
        "GET /api/grading/sections/{sectionId}/results/preview",
        "GET /api/grading/sections/{sectionId}/subject-enrollments",
        "GET /api/grading/sections/{sectionId}/subjects",
        "GET /api/grading/sections/{sectionId}/subjects/{subjectId}/marks",
        "GET /api/grading/students/{studentId}/certificates",
        "GET /api/grading/students/{studentId}/results",
        "GET /api/grading/subject-configs/{configId}",
        "GET /api/grading/subject-configs/{configId}/impact",
        "GET /api/grading/years/{yearId}/mark-sheets",
        "GET /api/grading/years/{yearId}/overview",
        "GET /api/grading/years/{yearId}/programs",
        "GET /api/grading/years/{yearId}/programs/{gradeLevelId}/subjects",
        "GET /api/grading/years/{yearId}/proposed-assessments",
        "GET /api/grading/years/{yearId}/publish-check",
        "GET /api/grading/years/{yearId}/scales",
        "GET /api/grading/years/{yearId}/teacher-assignments",
        "POST /api/grading/assessments/{assessmentId}/decision",
        "POST /api/grading/certificates/{certificateId}/reissue",
        "POST /api/grading/certificates/{certificateId}/revoke",
        "POST /api/grading/finalizations/{finalizationId}/certificates",
        "POST /api/grading/finalizations/{finalizationId}/corrections",
        "POST /api/grading/mark-sheets/{sheetId}/decision",
        "POST /api/grading/sections/{sectionId}/results/finalize",
        "POST /api/grading/sections/{sectionId}/subjects/{subjectId}/assessments",
        "POST /api/grading/sections/{sectionId}/subjects/{subjectId}/mark-sheets/submit",
        "POST /api/grading/sections/{sectionId}/subjects/{subjectId}/override",
        "POST /api/grading/subject-configs/{configId}/keep",
        "POST /api/grading/subject-configs/{configId}/reset",
        "POST /api/grading/teacher-assignments",
        "POST /api/grading/years/{yearId}/copy",
        "POST /api/grading/years/{yearId}/programs/{gradeLevelId}/subjects",
        "POST /api/grading/years/{yearId}/scales",
        "POST /api/grading/years/{yearId}/status",
        "PUT /api/grading/scales/{scaleId}",
        "PUT /api/grading/sections/{sectionId}/subject-enrollments",
        "PUT /api/grading/sections/{sectionId}/subjects/{subjectId}/marks",
        "PUT /api/grading/subject-configs/{configId}",
        "PUT /api/grading/years/{yearId}/programs/{gradeLevelId}",
        "POST /api/academics/materials/{materialId}/confirm",
        "POST /api/academics/materials/upload",
        "POST /api/academics/subjects",
        "POST /api/grades/config/gradebooks/{gradebookId}/categories",
        "POST /api/grades/config/gradebooks/{gradebookId}/scheme/link",
        "POST /api/grades/config/schemes",
        "POST /api/grades/gradebooks/{gradebookId}/assessments",
        "POST /api/academics/subjects/{subjectId}/courses",
        "POST /api/academics/timetable-versions",
        "POST /api/academics/timetable-versions/{versionId}/approve",
        "POST /api/academics/timetable-versions/{versionId}/publish",
        "POST /api/academics/timetable-versions/{versionId}/reject",
        "POST /api/academics/timetable-versions/{versionId}/slots",
        "POST /api/academics/timetable-versions/{versionId}/submit",
        "POST /api/academics/timetable-versions/copy",
        "POST /api/academics/years",
        "POST /api/academics/years/{yearId}/rollover",
        "POST /api/academics/years/{yearId}/terms",
        "POST /api/admin/subscriptions/sync-prices",
        "POST /api/ai/students/{studentId}/ask",
        "POST /api/ai/students/{studentId}/concepts",
        "POST /api/ai/students/{studentId}/decks",
        "POST /api/ai/students/{studentId}/decks/{deckId}/review",
        "POST /api/ai/students/{studentId}/exams",
        "POST /api/ai/students/{studentId}/exams/{examId}/start",
        "POST /api/ai/students/{studentId}/exams/{examId}/submit",
        "POST /api/ai/students/{studentId}/explain",
        "POST /api/ai/students/{studentId}/generate",
        "POST /api/ai/students/{studentId}/messages/{messageId}/report",
        "POST /api/ai/students/{studentId}/quizzes",
        "POST /api/ai/students/{studentId}/quizzes/{quizId}/grade",
        "POST /api/ai/students/{studentId}/reports",
        "POST /api/ai/students/{studentId}/search",
        "POST /api/ai/students/{studentId}/summarize",
        "POST /api/attendance/records/batch",
        "POST /api/attendance/reports/export",
        "POST /api/attendance/sessions",
        "POST /api/announcements",
        "POST /api/audit/logs/export",
        "POST /api/discipline/incidents",
        "POST /api/evaluations",
        "POST /api/evaluations/templates",
        "POST /api/evaluations/{evaluationId}/share",
        "POST /api/evaluations/{evaluationId}/submit",
        "POST /api/approvals/bulk-decision",
        "POST /api/discipline/incidents/{incidentId}/actions",
        "POST /api/discipline/incidents/{incidentId}/resolve",
        "POST /api/finance/fee-structures",
        "POST /api/finance/fee-schedules/generate",
        "POST /api/finance/invoices/batches",
        "POST /api/finance/expenses",
        "POST /api/finance/expenses/upload-url",
        "POST /api/finance/expenses/{expenseId}/attachments",
        "POST /api/finance/payments",
        "POST /api/finance/online-payments",
        "POST /api/finance/reports/export",
        "POST /api/finance/refunds/initiate",
        "POST /api/finance/refunds/{refundId}/approve",
        "POST /api/finance/refunds/{refundId}/reject",
        "GET /api/finance/scholarships",
        "POST /api/finance/scholarships",
        "PATCH /api/finance/scholarships/{scholarshipId}",
        "GET /api/finance/scholarship-awards",
        "POST /api/finance/scholarship-awards",
        "GET /api/finance/students",
        "POST /api/finance/scholarship-awards/{awardId}/approve",
        "POST /api/finance/scholarship-awards/{awardId}/reject",
        "POST /api/finance/scholarship-awards/{awardId}/revoke",
        "GET /api/finance/sibling-discount",
        "PUT /api/finance/sibling-discount",
        "GET /api/finance/families",
        "GET /api/finance/families/{familyId}/profile",
        "POST /api/finance/families/{familyId}/payments",
        "POST /api/finance/families/{familyId}/reminders",
        "POST /api/finance/families/{familyId}/statements",
        "POST /api/finance/reminders",
        "GET /api/finance/payments/{paymentId}/receipt",
        "POST /api/finance/reconciliation/run",
        "POST /api/auth/devices",
        "POST /api/auth/password/change",
        "POST /api/auth/providers/link/start",
        "POST /api/imports/students/upload",
        "POST /api/imports/students/{importId}/confirm",
        "POST /api/imports/students/mappings",
        "PUT /api/imports/students/{importId}/mapping",
        "PATCH /api/imports/students/mappings/{mappingId}",
        "DELETE /api/imports/students/mappings/{mappingId}",
        "POST /api/invitations/bulk",
        "POST /api/invitations/bulk/{bulkInviteId}/retry",
        "POST /api/invitations",
        "POST /api/families",
        "POST /api/families/{familyId}/links",
        "POST /api/invitations/{id}/regenerate",
        "POST /api/invitations/{id}/revoke",
        // In-app inbox (ST-142). Read-state mutations are self-service on the caller's own rows.
        "POST /api/notifications/{notificationId}/read",
        "POST /api/notifications/read-all",
        // Data subject requests (ST-268). Bearer-authenticated, then PRIVACY_DSR_MANAGE-gated.
        "POST /api/privacy/dsr",
        // Self-service account deletion/export. Bearer-authenticated only.
        "POST /api/privacy/me/dsr",
        // Self-service account deletion and profile. Bearer-authenticated only.
        "POST /api/account/deletion",
        "GET /api/account/profile",
        "POST /api/storage/uploads/confirm",
        "POST /api/storage/uploads/request-upload",
        "POST /api/students",
        "POST /api/students/{studentId}/guardians",
        "POST /api/subscriptions/ai/checkout",
        "POST /api/subscriptions/ai/store/purchases",
        "POST /api/subscriptions/checkout",
        "POST /api/subscriptions/current/cancel",
        "POST /api/subscriptions/current/cancel/reverse",
        "POST /api/subscriptions/ai/refund-requests",
        "POST /api/subscriptions/current/refund-requests",
        "POST /api/subscriptions/portal",
        "POST /api/subscriptions/school/checkout",
        "POST /api/teachers",
        "POST /api/users",
        "POST /api/users/{userId}/password/reset",
        "PUT /api/evaluations/{evaluationId}/scores/{criteriaTemplateId}",
        "POST /api/schools/{schoolId}/provision",
        "PUT /api/academics/timetable-settings",
      ].sort(),
    );
  });
});

describe("the generated artifact", () => {
  // The generated file is gitignored and regenerated in CI. This test writes it if absent (e.g.
  // a fresh checkout) and verifies it matches the current routes.
  test("matches what the routes currently generate", async () => {
    const file = Bun.file(COMMITTED_SPEC);
    const exists = await file.exists();

    if (!exists) {
      await writeFile(COMMITTED_SPEC, `${JSON.stringify(document, null, 2)}\n`);
    }

    const committed = (await file.json()) as Record<string, unknown>;
    const { [BANNER_KEY]: banner, ...spec } = committed;

    expect(banner, "the generator's do-not-edit banner is missing").toBeString();
    expect(spec, "apps/api/openapi.json is stale — run `bun run openapi:generate`").toEqual(
      serialized,
    );
  });

  test("is what the server serves at /openapi.json", async () => {
    const keyStore = new KeyStore(60_000);
    await keyStore.init();
    const app = createApp({
      isReady: () => true,
      tracker: createInflightTracker(),
      logger: createLogger({ destination: () => undefined }),
      redis: createUnusableRedis(),
      database: createUnusableDatabase(),
      keyStore,
      docsEnabled: true,
    });

    const res = await app.request("/openapi.json");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(serialized);
    keyStore.destroy();
  });
});

describe("the reference site", () => {
  const build = (docsEnabled: boolean) =>
    createApp({
      isReady: () => true,
      tracker: createInflightTracker(),
      logger: createLogger({ destination: () => undefined }),
      redis: createUnusableRedis(),
      database: createUnusableDatabase(),
      docsEnabled,
    });

  test("is served when enabled", async () => {
    const res = await build(true).request("/docs");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  // Production passes docsEnabled: false. Scalar's page loads its bundle from a CDN, and the 404
  // here is what keeps production from depending on a third party to render a page it does not need.
  test("is absent when disabled, and 404s through the problem+json handler", async () => {
    const res = await build(false).request("/docs");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
  });

  test("does not serve the document when disabled", async () => {
    expect((await build(false).request("/openapi.json")).status).toBe(404);
  });
});
