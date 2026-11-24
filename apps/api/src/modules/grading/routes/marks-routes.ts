import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";
import {
  addSectionAssessment,
  decideAssessmentRelease,
  decideMarkSheet,
  decideProposedAssessment,
  getMarkSheet,
  listAssessmentReleases,
  listMarkSheets,
  listMyAssignments,
  listProposedAssessments,
  saveMarks,
  submitAssessmentRelease,
  submitMarkSheet,
} from "../marks-service";
import {
  addAssessmentBodySchema,
  addAssessmentResultSchema,
  assessmentIdParamSchema,
  assessmentReleaseListSchema,
  assessmentReleaseQuerySchema,
  assessmentReleaseSchema,
  decideAssessmentBodySchema,
  decideAssessmentReleaseBodySchema,
  decideSheetBodySchema,
  markSheetListSchema,
  markSheetQuerySchema,
  markSheetRowSchema,
  markSheetSchema,
  myAssignmentsQuerySchema,
  myAssignmentsSchema,
  proposedAssessmentListSchema,
  releaseIdParamSchema,
  saveMarksBodySchema,
  saveMarksResultSchema,
  sectionSubjectAssessmentParamSchema,
  sectionSubjectParamSchema,
  sheetIdParamSchema,
  submitSheetBodySchema,
  yearIdParamSchema,
} from "../schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { AssessmentReleaseRow, MarkSheetRow } from "../marks-service";
import type { Context } from "hono";

const TAGS = ["Marks"];
const security = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

const myAssignmentsRoute = createRoute({
  method: "get",
  path: "/api/grading/my-assignments",
  tags: TAGS,
  operationId: "listMyGradingAssignments",
  summary: "The sections and subjects the current teacher grades",
  description:
    "For the given year, or the latest active year. Includes each period's mark sheet status.",
  security,
  request: { query: myAssignmentsQuerySchema },
  responses: standardResponses(
    { 200: { description: "Assignments.", schema: myAssignmentsSchema } },
    [401, 403, 500],
  ),
});

const markSheetRoute = createRoute({
  method: "get",
  path: "/api/grading/sections/{sectionId}/subjects/{subjectId}/marks",
  tags: TAGS,
  operationId: "getMarkSheet",
  summary: "Mark sheet for a section and subject",
  description:
    "The effective grading rules, assessments, roster, recorded marks and the engine's preview per student. Teachers of the section and subject, and school leadership; the subject's coordinator for the section's grade reads it too, read-only (access coordinator, can_edit_marks and can_add_assessments false).",
  security,
  request: { params: sectionSubjectParamSchema },
  responses: standardResponses(
    { 200: { description: "Mark sheet.", schema: markSheetSchema } },
    [401, 403, 404, 500],
  ),
});

const saveMarksRoute = createRoute({
  method: "put",
  path: "/api/grading/sections/{sectionId}/subjects/{subjectId}/marks",
  tags: TAGS,
  operationId: "saveMarks",
  summary: "Record, change or clear marks",
  description:
    "status pending clears a mark. Refused for submitted/approved sheets and for assessments sent for approval on their own or released (MARKS_LOCKED), finalized results, scores outside 0..max, and students who do not take the subject.",
  security,
  request: { params: sectionSubjectParamSchema, body: json(saveMarksBodySchema) },
  responses: standardResponses(
    { 200: { description: "Saved; the refreshed sheet.", schema: saveMarksResultSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const addAssessmentRoute = createRoute({
  method: "post",
  path: "/api/grading/sections/{sectionId}/subjects/{subjectId}/assessments",
  tags: TAGS,
  operationId: "addSectionAssessment",
  summary: "Add an assessment for one section",
  description:
    "Teachers only where the subject allows it; proposed until approved when the subject requires approval.",
  security,
  request: { params: sectionSubjectParamSchema, body: json(addAssessmentBodySchema) },
  responses: standardResponses(
    { 201: { description: "Created.", schema: addAssessmentResultSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const submitSheetRoute = createRoute({
  method: "post",
  path: "/api/grading/sections/{sectionId}/subjects/{subjectId}/mark-sheets/submit",
  tags: TAGS,
  operationId: "submitMarkSheet",
  summary: "Submit a period's marks for approval",
  description:
    "Every enrolled student needs a usable mark on every mandatory assessment of the period (409 RESULTS_INCOMPLETE).",
  security,
  request: { params: sectionSubjectParamSchema, body: json(submitSheetBodySchema) },
  responses: standardResponses(
    { 200: { description: "Sheet.", schema: markSheetRowSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const listSheetsRoute = createRoute({
  method: "get",
  path: "/api/grading/years/{yearId}/mark-sheets",
  tags: TAGS,
  operationId: "listMarkSheets",
  summary: "Mark sheets in a year (the approval queue)",
  description: "Filter by status=submitted for sheets awaiting approval.",
  security,
  request: { params: yearIdParamSchema, query: markSheetQuerySchema },
  responses: standardResponses(
    { 200: { description: "Sheets.", schema: markSheetListSchema } },
    [401, 403, 500],
  ),
});

const decideSheetRoute = createRoute({
  method: "post",
  path: "/api/grading/mark-sheets/{sheetId}/decision",
  tags: TAGS,
  operationId: "decideMarkSheet",
  summary: "Approve, return or reopen a mark sheet",
  description:
    "Approving releases the period's marks to students and parents and notifies them (MARKS_RELEASED). Returning or reopening needs a reason. A sheet inside finalized results cannot be reopened.",
  security,
  request: { params: sheetIdParamSchema, body: json(decideSheetBodySchema) },
  responses: standardResponses(
    { 200: { description: "Sheet.", schema: markSheetRowSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const submitReleaseRoute = createRoute({
  method: "post",
  path: "/api/grading/sections/{sectionId}/subjects/{subjectId}/assessments/{assessmentId}/release",
  tags: TAGS,
  operationId: "submitAssessmentRelease",
  summary: "Send one assessment's marks for approval",
  description:
    "Releases a single assessment before the rest of its period: every enrolled student needs a usable mark for it (409 RESULTS_INCOMPLETE). Always waits for leadership approval (also where the grade's sheets need no approval step); once approved the marks are visible to the student and their parents, who are notified (MARKS_RELEASED, in-app and push). Refused while the period's whole sheet is submitted or approved.",
  security,
  request: { params: sectionSubjectAssessmentParamSchema },
  responses: standardResponses(
    { 200: { description: "Release.", schema: assessmentReleaseSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const listReleasesRoute = createRoute({
  method: "get",
  path: "/api/grading/years/{yearId}/assessment-releases",
  tags: TAGS,
  operationId: "listAssessmentReleases",
  summary: "Single assessments sent for approval in a year (the approval queue)",
  description: "Filter by status=submitted for releases awaiting approval.",
  security,
  request: { params: yearIdParamSchema, query: assessmentReleaseQuerySchema },
  responses: standardResponses(
    { 200: { description: "Releases.", schema: assessmentReleaseListSchema } },
    [401, 403, 500],
  ),
});

const decideReleaseRoute = createRoute({
  method: "post",
  path: "/api/grading/assessment-releases/{releaseId}/decision",
  tags: TAGS,
  operationId: "decideAssessmentRelease",
  summary: "Approve, return or withdraw one assessment's release",
  description:
    "Approving releases the marks to the student and their parents and notifies them. Returning or withdrawing (reopen) needs a reason; withdrawing hides the marks from families again. Refused while the period's whole sheet is approved, and inside finalized results.",
  security,
  request: { params: releaseIdParamSchema, body: json(decideAssessmentReleaseBodySchema) },
  responses: standardResponses(
    { 200: { description: "Release.", schema: assessmentReleaseSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const proposedRoute = createRoute({
  method: "get",
  path: "/api/grading/years/{yearId}/proposed-assessments",
  tags: TAGS,
  operationId: "listProposedAssessments",
  summary: "Teacher-added assessments awaiting approval",
  description: "Approve or reject each with the decision endpoint.",
  security,
  request: { params: yearIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Assessments.", schema: proposedAssessmentListSchema } },
    [401, 403, 500],
  ),
});

const decideAssessmentRoute = createRoute({
  method: "post",
  path: "/api/grading/assessments/{assessmentId}/decision",
  tags: TAGS,
  operationId: "decideProposedAssessment",
  summary: "Approve or reject a teacher-added assessment",
  description: "An approved assessment starts counting in the subject's grade.",
  security,
  request: { params: assessmentIdParamSchema, body: json(decideAssessmentBodySchema) },
  responses: {
    204: { description: "Decided.", headers: requestIdHeaders },
    ...standardResponses({}, [400, 401, 403, 404, 409, 500]),
  },
});

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function sheetJson(sheet: MarkSheetRow) {
  return {
    ...sheet,
    submitted_at: sheet.submitted_at?.toISOString() ?? null,
    decided_at: sheet.decided_at?.toISOString() ?? null,
    updated_at: sheet.updated_at.toISOString(),
  };
}

function releaseJson(release: AssessmentReleaseRow) {
  return {
    ...release,
    submitted_at: release.submitted_at.toISOString(),
    decided_at: release.decided_at?.toISOString() ?? null,
    updated_at: release.updated_at.toISOString(),
  };
}

export function gradingMarksRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Reading and entering marks is gated by role here and by section/subject inside the services
  // (app.teaches_section_subject); reviewing is school leadership's.
  routes.use("/api/grading/my-assignments", requirePermission(PERMISSIONS.ACADEMIC_CONFIG_READ));
  routes.use(
    "/api/grading/sections/:sectionId/subjects/:subjectId/marks",
    requirePermission(PERMISSIONS.GRADE_READ),
  );
  routes.use("/api/grading/sections/:sectionId/subjects/:subjectId/marks", async (c, next) =>
    c.req.method === "PUT" ? requirePermission(PERMISSIONS.GRADE_UPDATE)(c, next) : next(),
  );
  routes.use(
    "/api/grading/sections/:sectionId/subjects/:subjectId/marks",
    auditAction("update", "student_marks"),
  );
  routes.use(
    "/api/grading/sections/:sectionId/subjects/:subjectId/assessments",
    requirePermission(PERMISSIONS.GRADE_UPDATE),
    auditAction("insert", "subject_config_assessments"),
  );
  routes.use(
    "/api/grading/sections/:sectionId/subjects/:subjectId/mark-sheets/submit",
    requirePermission(PERMISSIONS.GRADE_UPDATE),
    auditAction("update", "mark_sheets"),
  );
  routes.use(
    "/api/grading/years/:yearId/mark-sheets",
    requirePermission(PERMISSIONS.APPROVAL_REVIEW),
  );
  routes.use(
    "/api/grading/mark-sheets/:sheetId/decision",
    requirePermission(PERMISSIONS.APPROVAL_REVIEW),
    auditAction("update", "mark_sheets"),
  );
  routes.use(
    "/api/grading/sections/:sectionId/subjects/:subjectId/assessments/:assessmentId/release",
    requirePermission(PERMISSIONS.GRADE_UPDATE),
    auditAction("update", "assessment_mark_releases"),
  );
  routes.use(
    "/api/grading/years/:yearId/assessment-releases",
    requirePermission(PERMISSIONS.APPROVAL_REVIEW),
  );
  routes.use(
    "/api/grading/assessment-releases/:releaseId/decision",
    requirePermission(PERMISSIONS.APPROVAL_REVIEW),
    auditAction("update", "assessment_mark_releases"),
  );
  routes.use(
    "/api/grading/years/:yearId/proposed-assessments",
    requirePermission(PERMISSIONS.APPROVAL_REVIEW),
  );
  routes.use(
    "/api/grading/assessments/:assessmentId/decision",
    requirePermission(PERMISSIONS.ACADEMIC_CONFIG_MANAGE),
    auditAction("update", "subject_config_assessments"),
  );

  routes.openapi(myAssignmentsRoute, async (c) => {
    const { academic_year_id } = c.req.valid("query");
    const tenant = tenantFrom(c);
    const assignments = await withTenantTx(database, tenant, (tx) =>
      listMyAssignments(tx, tenant.schoolId, academic_year_id),
    );
    return c.json({ assignments }, 200);
  });

  routes.openapi(markSheetRoute, async (c) => {
    const { sectionId, subjectId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        getMarkSheet(tx, tenant.schoolId, sectionId, subjectId),
      ),
      200,
    );
  });

  routes.openapi(saveMarksRoute, async (c) => {
    const { sectionId, subjectId } = c.req.valid("param");
    const { entries } = c.req.valid("json");
    const tenant = tenantFrom(c);
    const result = await withTenantTx(database, tenant, async (tx) => {
      const { saved } = await saveMarks(
        tx,
        tenant.schoolId,
        tenant.userId,
        sectionId,
        subjectId,
        entries,
      );
      return { saved, sheet: await getMarkSheet(tx, tenant.schoolId, sectionId, subjectId) };
    });
    return c.json(result, 200);
  });

  routes.openapi(addAssessmentRoute, async (c) => {
    const { sectionId, subjectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    const result = await withTenantTx(database, tenant, (tx) =>
      addSectionAssessment(tx, tenant.schoolId, tenant.userId, sectionId, subjectId, body),
    );
    return c.json(result, 201);
  });

  routes.openapi(submitSheetRoute, async (c) => {
    const { sectionId, subjectId } = c.req.valid("param");
    const { term_id } = c.req.valid("json");
    const tenant = tenantFrom(c);
    const sheet = await withTenantTx(database, tenant, (tx) =>
      submitMarkSheet(tx, tenant.schoolId, tenant.userId, sectionId, subjectId, term_id),
    );
    return c.json(sheetJson(sheet), 200);
  });

  routes.openapi(listSheetsRoute, async (c) => {
    const { yearId } = c.req.valid("param");
    const { status } = c.req.valid("query");
    const tenant = tenantFrom(c);
    const sheets = await withTenantTx(database, tenant, (tx) =>
      listMarkSheets(tx, tenant.schoolId, { yearId, status }),
    );
    return c.json({ sheets: sheets.map((sheet) => ({ ...sheet, ...sheetJson(sheet) })) }, 200);
  });

  routes.openapi(decideSheetRoute, async (c) => {
    const { sheetId } = c.req.valid("param");
    const { action, reason } = c.req.valid("json");
    const tenant = tenantFrom(c);
    const sheet = await withTenantTx(database, tenant, (tx) =>
      decideMarkSheet(tx, tenant.schoolId, tenant.userId, sheetId, action, reason),
    );
    return c.json(sheetJson(sheet), 200);
  });

  routes.openapi(submitReleaseRoute, async (c) => {
    const { sectionId, subjectId, assessmentId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const release = await withTenantTx(database, tenant, (tx) =>
      submitAssessmentRelease(
        tx,
        tenant.schoolId,
        tenant.userId,
        sectionId,
        subjectId,
        assessmentId,
      ),
    );
    return c.json(releaseJson(release), 200);
  });

  routes.openapi(listReleasesRoute, async (c) => {
    const { yearId } = c.req.valid("param");
    const { status } = c.req.valid("query");
    const tenant = tenantFrom(c);
    const releases = await withTenantTx(database, tenant, (tx) =>
      listAssessmentReleases(tx, tenant.schoolId, { yearId, status }),
    );
    return c.json(
      {
        releases: releases.map((release) => ({
          ...release,
          ...releaseJson(release),
          max_marks: Number(release.max_marks),
        })),
      },
      200,
    );
  });

  routes.openapi(decideReleaseRoute, async (c) => {
    const { releaseId } = c.req.valid("param");
    const { action, reason } = c.req.valid("json");
    const tenant = tenantFrom(c);
    const release = await withTenantTx(database, tenant, (tx) =>
      decideAssessmentRelease(tx, tenant.schoolId, tenant.userId, releaseId, action, reason),
    );
    return c.json(releaseJson(release), 200);
  });

  routes.openapi(proposedRoute, async (c) => {
    const { yearId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const assessments = await withTenantTx(database, tenant, (tx) =>
      listProposedAssessments(tx, tenant.schoolId, yearId),
    );
    return c.json({ assessments }, 200);
  });

  routes.openapi(decideAssessmentRoute, async (c) => {
    const { assessmentId } = c.req.valid("param");
    const { action } = c.req.valid("json");
    const tenant = tenantFrom(c);
    await withTenantTx(database, tenant, (tx) =>
      decideProposedAssessment(tx, tenant.schoolId, assessmentId, action),
    );
    return c.body(null, 204);
  });

  return routes;
}
