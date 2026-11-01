import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { onlyMethods } from "../../../middleware/only-methods";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";
import {
  acknowledgeGradeRevision,
  collectPublishIssues,
  createScale,
  createSectionOverride,
  createSubjectConfig,
  createTeacherAssignment,
  deleteScale,
  deleteSubjectConfig,
  deleteTeacherAssignment,
  getConfigImpact,
  getConfigView,
  listGradeConfigs,
  listPrograms,
  listScales,
  listSectionSubjects,
  listSubjectEnrollments,
  listTeacherAssignments,
  resetSectionOverride,
  setSubjectEnrollment,
  setYearGradingStatus,
  updateScale,
  updateSubjectConfig,
  upsertProgram,
} from "../config-service";
import { copyYearConfiguration } from "../copy-year-service";
import { applyExamStructure, getExamTemplate } from "../exam-structure";
import { getGradingOverview } from "../overview-service";
import {
  assignmentIdParamSchema,
  configIdParamSchema,
  configImpactSchema,
  copyYearBodySchema,
  copyYearSummarySchema,
  createSubjectConfigBodySchema,
  gradingOverviewSchema,
  gradingSectionParamSchema,
  programBodySchema,
  programListSchema,
  programParamSchema,
  programSchema,
  publishCheckSchema,
  saveSubjectConfigResultSchema,
  scaleBodySchema,
  scaleIdParamSchema,
  scaleListSchema,
  scaleSchema,
  sectionOverrideBodySchema,
  sectionSubjectParamSchema,
  sectionSubjectsSchema,
  setYearStatusBodySchema,
  subjectConfigListSchema,
  subjectConfigSchema,
  subjectEnrollmentBodySchema,
  subjectEnrollmentListSchema,
  teacherAssignmentBodySchema,
  teacherAssignmentListSchema,
  teacherAssignmentSchema,
  updateSubjectConfigBodySchema,
  yearIdParamSchema,
  yearStatusResultSchema,
  applyExamStructureResultSchema,
  examTemplateSchema,
} from "../schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";

const TAGS = ["Academic grading"];
const security = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

// ---------------------------------------------------------------------------
// Year: overview, publication, copy
// ---------------------------------------------------------------------------

const overviewRoute = createRoute({
  method: "get",
  path: "/api/grading/years/{yearId}/overview",
  tags: TAGS,
  operationId: "getGradingOverview",
  summary: "Academic grading readiness for a year",
  description:
    "Grades, their subjects and validity, every section's inherited and overridden subjects, missing teachers, incomplete marks, approvals, finalization and certificate readiness.",
  security,
  request: { params: yearIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Overview.", schema: gradingOverviewSchema } },
    [401, 403, 404, 500],
  ),
});

const publishCheckRoute = createRoute({
  method: "get",
  path: "/api/grading/years/{yearId}/publish-check",
  tags: TAGS,
  operationId: "checkGradingPublication",
  summary: "What blocks publishing a year's grading configuration",
  description: "Errors block publication; warnings (missing teachers, outdated overrides) do not.",
  security,
  request: { params: yearIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Issues.", schema: publishCheckSchema } },
    [401, 403, 404, 500],
  ),
});

const examTemplateRoute = createRoute({
  method: "get",
  path: "/api/grading/years/{yearId}/exam-template",
  tags: TAGS,
  operationId: "getGradingExamTemplate",
  summary: "The term structure a new subject starts from",
  description:
    "Built from the school's exam system (School Settings): each term's categories and " +
    "assessments, weighted as the admin set them.",
  security,
  request: { params: yearIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Template.", schema: examTemplateSchema } },
    [401, 403, 404, 500],
  ),
});

const applyExamStructureRoute = createRoute({
  method: "post",
  path: "/api/grading/exam-structure/apply",
  tags: TAGS,
  operationId: "applyGradingExamStructure",
  summary: "Set up the active year's subjects on the school's exam system",
  description:
    "Rebuilds every subject of the active academic year that has no marks yet; subjects with " +
    "marks are reported as skipped and left unchanged.",
  security,
  responses: standardResponses(
    { 200: { description: "What changed.", schema: applyExamStructureResultSchema } },
    [401, 403, 409, 500],
  ),
});

const setStatusRoute = createRoute({
  method: "post",
  path: "/api/grading/years/{yearId}/status",
  tags: TAGS,
  operationId: "setGradingStatus",
  summary: "Publish, unpublish, finalize or archive a year's grading configuration",
  description:
    "draft -> active validates every configuration; active -> draft only before any mark; active -> finalized needs every section's annual results finalized; finalized -> archived.",
  security,
  request: { params: yearIdParamSchema, body: json(setYearStatusBodySchema) },
  responses: standardResponses(
    { 200: { description: "New status.", schema: yearStatusResultSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const copyYearRoute = createRoute({
  method: "post",
  path: "/api/grading/years/{yearId}/copy",
  tags: TAGS,
  operationId: "copyGradingConfiguration",
  summary: "Start a year from a previous year's configuration",
  description:
    "Copies scales, grades, sections, subjects, categories, term weights, assessments, overrides and optionally teacher assignments into a draft year. Never copies marks, results or certificates.",
  security,
  request: { params: yearIdParamSchema, body: json(copyYearBodySchema) },
  responses: standardResponses(
    { 200: { description: "What was copied.", schema: copyYearSummarySchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

const listScalesRoute = createRoute({
  method: "get",
  path: "/api/grading/years/{yearId}/scales",
  tags: TAGS,
  operationId: "listGradeScales",
  summary: "List a year's grading scales",
  description: "Each scale with its bands and any validation issues.",
  security,
  request: { params: yearIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Scales.", schema: scaleListSchema } },
    [401, 403, 404, 500],
  ),
});

const createScaleRoute = createRoute({
  method: "post",
  path: "/api/grading/years/{yearId}/scales",
  tags: TAGS,
  operationId: "createGradeScale",
  summary: "Create a grading scale",
  description: "Bands are lower bounds; one must start at 0, none may share a bound or label.",
  security,
  request: { params: yearIdParamSchema, body: json(scaleBodySchema) },
  responses: standardResponses(
    { 201: { description: "Created scale.", schema: scaleSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const updateScaleRoute = createRoute({
  method: "put",
  path: "/api/grading/scales/{scaleId}",
  tags: TAGS,
  operationId: "updateGradeScale",
  summary: "Replace a grading scale's name and bands",
  description: "Finalized results keep the scale they were finalized with.",
  security,
  request: { params: scaleIdParamSchema, body: json(scaleBodySchema) },
  responses: standardResponses(
    { 200: { description: "Updated scale.", schema: scaleSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteScaleRoute = createRoute({
  method: "delete",
  path: "/api/grading/scales/{scaleId}",
  tags: TAGS,
  operationId: "deleteGradeScale",
  summary: "Delete an unused grading scale",
  description: "409 while a grade or subject uses it.",
  security,
  request: { params: scaleIdParamSchema },
  responses: {
    204: { description: "Deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 409, 500]),
  },
});

// ---------------------------------------------------------------------------
// Grade programs and grade-level subjects
// ---------------------------------------------------------------------------

const listProgramsRoute = createRoute({
  method: "get",
  path: "/api/grading/years/{yearId}/programs",
  tags: TAGS,
  operationId: "listGradePrograms",
  summary: "Grades set up for a year",
  description:
    "Each grade's year policies: default scale, mark approval, promotion rule, average rounding.",
  security,
  request: { params: yearIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Programs.", schema: programListSchema } },
    [401, 403, 404, 500],
  ),
});

const upsertProgramRoute = createRoute({
  method: "put",
  path: "/api/grading/years/{yearId}/programs/{gradeLevelId}",
  tags: TAGS,
  operationId: "upsertGradeProgram",
  summary: "Set up a grade for a year, or change its policies",
  description: "Idempotent per grade and year.",
  security,
  request: { params: programParamSchema, body: json(programBodySchema) },
  responses: standardResponses(
    { 200: { description: "Program.", schema: programSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const listGradeSubjectsRoute = createRoute({
  method: "get",
  path: "/api/grading/years/{yearId}/programs/{gradeLevelId}/subjects",
  tags: TAGS,
  operationId: "listGradeSubjectConfigs",
  summary: "A grade's default subjects and their grading rules",
  description: "Every section of the grade inherits these unless it overrides one.",
  security,
  request: { params: programParamSchema },
  responses: standardResponses(
    { 200: { description: "Configs.", schema: subjectConfigListSchema } },
    [401, 403, 404, 500],
  ),
});

const createGradeSubjectRoute = createRoute({
  method: "post",
  path: "/api/grading/years/{yearId}/programs/{gradeLevelId}/subjects",
  tags: TAGS,
  operationId: "createSubjectConfig",
  summary: "Add a subject to a grade (or to one section only)",
  description:
    "With section_id null the subject becomes a grade default inherited by every section. A draft year accepts an unfinished configuration (issues are returned); an active year rejects invalid ones.",
  security,
  request: { params: programParamSchema, body: json(createSubjectConfigBodySchema) },
  responses: standardResponses(
    { 201: { description: "Created.", schema: saveSubjectConfigResultSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

// ---------------------------------------------------------------------------
// Subject configs
// ---------------------------------------------------------------------------

const getConfigRoute = createRoute({
  method: "get",
  path: "/api/grading/subject-configs/{configId}",
  tags: TAGS,
  operationId: "getSubjectConfig",
  summary: "A subject configuration with its validation",
  description: "Categories, assessments, term weights, weight totals and every validation issue.",
  security,
  request: { params: configIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Config.", schema: subjectConfigSchema } },
    [401, 403, 404, 500],
  ),
});

const updateConfigRoute = createRoute({
  method: "put",
  path: "/api/grading/subject-configs/{configId}",
  tags: TAGS,
  operationId: "updateSubjectConfig",
  summary: "Replace a subject configuration",
  description:
    "Assessments named by id keep their marks. When recorded marks would be recalculated the change needs confirm_impact (409 ACADEMIC_CONFIG_IMPACT_UNCONFIRMED otherwise). Section overrides and finalized results are never changed by editing a grade default.",
  security,
  request: { params: configIdParamSchema, body: json(updateSubjectConfigBodySchema) },
  responses: standardResponses(
    { 200: { description: "Saved.", schema: saveSubjectConfigResultSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteConfigRoute = createRoute({
  method: "delete",
  path: "/api/grading/subject-configs/{configId}",
  tags: TAGS,
  operationId: "deleteSubjectConfig",
  summary: "Remove a subject from a grade or section",
  description: "409 SUBJECT_CONFIG_IN_USE while marks, results or section overrides depend on it.",
  security,
  request: { params: configIdParamSchema },
  responses: {
    204: { description: "Removed.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 409, 500]),
  },
});

const impactRoute = createRoute({
  method: "get",
  path: "/api/grading/subject-configs/{configId}/impact",
  tags: TAGS,
  operationId: "getSubjectConfigImpact",
  summary: "Which sections a change to this configuration affects",
  description:
    "Inheriting sections (affected), overriding sections (not affected, maybe outdated) and finalized sections (protected).",
  security,
  request: { params: configIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Impact.", schema: configImpactSchema } },
    [401, 403, 404, 500],
  ),
});

const resetOverrideRoute = createRoute({
  method: "post",
  path: "/api/grading/subject-configs/{configId}/reset",
  tags: TAGS,
  operationId: "resetSectionOverride",
  summary: "Accept the grade default again",
  description:
    "Deletes the section's override so it inherits. 409 SECTION_OVERRIDE_HAS_MARKS once it has marks.",
  security,
  request: { params: configIdParamSchema },
  responses: {
    204: { description: "Reset.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 409, 500]),
  },
});

const keepOverrideRoute = createRoute({
  method: "post",
  path: "/api/grading/subject-configs/{configId}/keep",
  tags: TAGS,
  operationId: "keepSectionOverride",
  summary: "Keep a section override after its grade default changed",
  description:
    "Records that the latest grade default revision was reviewed and rejected for this section.",
  security,
  request: { params: configIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Override.", schema: subjectConfigSchema } },
    [401, 403, 404, 409, 500],
  ),
});

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const sectionSubjectsRoute = createRoute({
  method: "get",
  path: "/api/grading/sections/{sectionId}/subjects",
  tags: TAGS,
  operationId: "listSectionGradingSubjects",
  summary: "A section's subjects and where each comes from",
  description: "inherited (grade default), override, section_only or excluded, with teachers.",
  security,
  request: { params: gradingSectionParamSchema },
  responses: standardResponses(
    { 200: { description: "Subjects.", schema: sectionSubjectsSchema } },
    [401, 403, 404, 500],
  ),
});

const overrideRoute = createRoute({
  method: "post",
  path: "/api/grading/sections/{sectionId}/subjects/{subjectId}/override",
  tags: TAGS,
  operationId: "createSectionOverride",
  summary: "Customize or exclude an inherited subject for one section",
  description:
    "customize copies the grade default (existing marks move with it); exclude drops the subject.",
  security,
  request: { params: sectionSubjectParamSchema, body: json(sectionOverrideBodySchema) },
  responses: standardResponses(
    { 201: { description: "Override.", schema: saveSubjectConfigResultSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const listEnrollmentsRoute = createRoute({
  method: "get",
  path: "/api/grading/sections/{sectionId}/subject-enrollments",
  tags: TAGS,
  operationId: "listSubjectEnrollments",
  summary: "Elective choices and exemptions in a section",
  description:
    "Optional and elective subjects are taken only by enrolled students; exemptions carry a reason.",
  security,
  request: { params: gradingSectionParamSchema },
  responses: standardResponses(
    { 200: { description: "Choices.", schema: subjectEnrollmentListSchema } },
    [401, 403, 404, 500],
  ),
});

const setEnrollmentRoute = createRoute({
  method: "put",
  path: "/api/grading/sections/{sectionId}/subject-enrollments",
  tags: TAGS,
  operationId: "setSubjectEnrollment",
  summary: "Enroll a student in a subject, exempt them, or clear the choice",
  description: "status none removes the row.",
  security,
  request: { params: gradingSectionParamSchema, body: json(subjectEnrollmentBodySchema) },
  responses: {
    204: { description: "Saved.", headers: requestIdHeaders },
    ...standardResponses({}, [400, 401, 403, 404, 409, 500]),
  },
});

// ---------------------------------------------------------------------------
// Teacher assignments
// ---------------------------------------------------------------------------

const listAssignmentsRoute = createRoute({
  method: "get",
  path: "/api/grading/years/{yearId}/teacher-assignments",
  tags: TAGS,
  operationId: "listTeacherAssignments",
  summary: "Teachers assigned to subjects and sections",
  description: "Explicit assignments. Teachers of a section's classes also grade them without one.",
  security,
  request: { params: yearIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Assignments.", schema: teacherAssignmentListSchema } },
    [401, 403, 404, 500],
  ),
});

const createAssignmentRoute = createRoute({
  method: "post",
  path: "/api/grading/teacher-assignments",
  tags: TAGS,
  operationId: "createTeacherAssignment",
  summary: "Assign a teacher to a subject in a section",
  description: "409 TEACHER_ASSIGNMENT_DUPLICATE for a repeat.",
  security,
  request: { body: json(teacherAssignmentBodySchema) },
  responses: standardResponses(
    { 201: { description: "Assignment.", schema: teacherAssignmentSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteAssignmentRoute = createRoute({
  method: "delete",
  path: "/api/grading/teacher-assignments/{assignmentId}",
  tags: TAGS,
  operationId: "deleteTeacherAssignment",
  summary: "Remove a teacher assignment",
  description: "Marks the teacher entered stay.",
  security,
  request: { params: assignmentIdParamSchema },
  responses: {
    204: { description: "Removed.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 500]),
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function gradingConfigRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Teaching staff read the rules they grade by; leadership changes them.
  const read = requirePermission(PERMISSIONS.ACADEMIC_CONFIG_READ);
  const manage = requirePermission(PERMISSIONS.ACADEMIC_CONFIG_MANAGE);

  routes.use("/api/grading/years/:yearId/overview", read);
  routes.use("/api/grading/years/:yearId/publish-check", read);
  routes.use("/api/grading/years/:yearId/exam-template", read);
  routes.use("/api/grading/exam-structure/apply", manage, auditAction("update", "subject_configs"));
  routes.use("/api/grading/years/:yearId/status", manage, auditAction("update", "academic_years"));
  routes.use("/api/grading/years/:yearId/copy", manage, auditAction("insert", "subject_configs"));
  routes.use(
    "/api/grading/years/:yearId/scales",
    onlyMethods(["GET"], read),
    onlyMethods(["POST"], manage),
    auditAction("insert", "grade_scales"),
  );
  routes.use("/api/grading/scales/:scaleId", manage, auditAction("update", "grade_scales"));
  routes.use("/api/grading/years/:yearId/programs", read);
  routes.use(
    "/api/grading/years/:yearId/programs/:gradeLevelId",
    manage,
    auditAction("update", "grade_programs"),
  );
  routes.use(
    "/api/grading/years/:yearId/programs/:gradeLevelId/subjects",
    onlyMethods(["GET"], read),
    onlyMethods(["POST"], manage),
    auditAction("insert", "subject_configs"),
  );
  routes.use(
    "/api/grading/subject-configs/:configId",
    onlyMethods(["GET"], read),
    onlyMethods(["PUT", "DELETE"], manage),
    auditAction("update", "subject_configs"),
  );
  routes.use("/api/grading/subject-configs/:configId/impact", read);
  routes.use(
    "/api/grading/subject-configs/:configId/reset",
    manage,
    auditAction("delete", "subject_configs"),
  );
  routes.use(
    "/api/grading/subject-configs/:configId/keep",
    manage,
    auditAction("update", "subject_configs"),
  );
  routes.use("/api/grading/sections/:sectionId/subjects", read);
  routes.use(
    "/api/grading/sections/:sectionId/subjects/:subjectId/override",
    manage,
    auditAction("insert", "subject_configs"),
  );
  routes.use(
    "/api/grading/sections/:sectionId/subject-enrollments",
    onlyMethods(["GET"], read),
    onlyMethods(["PUT"], manage),
    auditAction("update", "student_subject_enrollments"),
  );
  routes.use("/api/grading/years/:yearId/teacher-assignments", read);
  routes.use(
    "/api/grading/teacher-assignments",
    manage,
    auditAction("insert", "section_subject_teachers"),
  );
  routes.use(
    "/api/grading/teacher-assignments/:assignmentId",
    manage,
    auditAction("delete", "section_subject_teachers"),
  );

  routes.openapi(overviewRoute, async (c) => {
    const { yearId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) => getGradingOverview(tx, tenant.schoolId, yearId)),
      200,
    );
  });

  routes.openapi(publishCheckRoute, async (c) => {
    const { yearId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const issues = await withTenantTx(database, tenant, (tx) =>
      collectPublishIssues(tx, tenant.schoolId, yearId),
    );
    return c.json({ ready: !issues.some((issue) => issue.severity === "error"), issues }, 200);
  });

  routes.openapi(examTemplateRoute, async (c) => {
    const { yearId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) => getExamTemplate(tx, tenant.schoolId, yearId)),
      200,
    );
  });

  routes.openapi(applyExamStructureRoute, async (c) => {
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        applyExamStructure(tx, tenant.schoolId, tenant.userId),
      ),
      200,
    );
  });

  routes.openapi(setStatusRoute, async (c) => {
    const { yearId } = c.req.valid("param");
    const { status } = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        setYearGradingStatus(tx, tenant.schoolId, yearId, status),
      ),
      200,
    );
  });

  routes.openapi(copyYearRoute, async (c) => {
    const { yearId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    const summary = await withTenantTx(database, tenant, (tx) =>
      copyYearConfiguration(tx, tenant.schoolId, body.source_year_id, yearId, {
        includeTeacherAssignments: body.include_teacher_assignments,
      }),
    );
    return c.json(summary, 200);
  });

  routes.openapi(listScalesRoute, async (c) => {
    const { yearId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      {
        scales: await withTenantTx(database, tenant, (tx) =>
          listScales(tx, tenant.schoolId, yearId),
        ),
      },
      200,
    );
  });

  routes.openapi(createScaleRoute, async (c) => {
    const { yearId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) => createScale(tx, tenant.schoolId, yearId, body)),
      201,
    );
  });

  routes.openapi(updateScaleRoute, async (c) => {
    const { scaleId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) => updateScale(tx, tenant.schoolId, scaleId, body)),
      200,
    );
  });

  routes.openapi(deleteScaleRoute, async (c) => {
    const { scaleId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    await withTenantTx(database, tenant, (tx) => deleteScale(tx, tenant.schoolId, scaleId));
    return c.body(null, 204);
  });

  routes.openapi(listProgramsRoute, async (c) => {
    const { yearId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const programs = await withTenantTx(database, tenant, (tx) =>
      listPrograms(tx, tenant.schoolId, yearId),
    );
    return c.json(
      { programs: programs.map((p) => ({ ...p, updated_at: p.updated_at.toISOString() })) },
      200,
    );
  });

  routes.openapi(upsertProgramRoute, async (c) => {
    const { yearId, gradeLevelId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    const program = await withTenantTx(database, tenant, (tx) =>
      upsertProgram(tx, tenant.schoolId, yearId, gradeLevelId, body),
    );
    return c.json({ ...program, updated_at: program.updated_at.toISOString() }, 200);
  });

  routes.openapi(listGradeSubjectsRoute, async (c) => {
    const { yearId, gradeLevelId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const configs = await withTenantTx(database, tenant, (tx) =>
      listGradeConfigs(tx, tenant.schoolId, yearId, gradeLevelId),
    );
    return c.json({ configs }, 200);
  });

  routes.openapi(createGradeSubjectRoute, async (c) => {
    const { yearId, gradeLevelId } = c.req.valid("param");
    const { subject_id, section_id, ...input } = c.req.valid("json");
    const tenant = tenantFrom(c);
    const result = await withTenantTx(database, tenant, (tx) =>
      createSubjectConfig(
        tx,
        tenant.schoolId,
        tenant.userId,
        { yearId, gradeLevelId, sectionId: section_id, subjectId: subject_id },
        input,
      ),
    );
    return c.json(result, 201);
  });

  routes.openapi(getConfigRoute, async (c) => {
    const { configId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) => getConfigView(tx, tenant.schoolId, configId)),
      200,
    );
  });

  routes.openapi(updateConfigRoute, async (c) => {
    const { configId } = c.req.valid("param");
    const { confirm_impact, expected_updated_at, ...input } = c.req.valid("json");
    const tenant = tenantFrom(c);
    const result = await withTenantTx(database, tenant, (tx) =>
      updateSubjectConfig(tx, tenant.schoolId, tenant.userId, configId, input, {
        confirmImpact: confirm_impact,
        expectedUpdatedAt: expected_updated_at,
      }),
    );
    return c.json(result, 200);
  });

  routes.openapi(deleteConfigRoute, async (c) => {
    const { configId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    await withTenantTx(database, tenant, (tx) =>
      deleteSubjectConfig(tx, tenant.schoolId, configId),
    );
    return c.body(null, 204);
  });

  routes.openapi(impactRoute, async (c) => {
    const { configId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) => getConfigImpact(tx, tenant.schoolId, configId)),
      200,
    );
  });

  routes.openapi(resetOverrideRoute, async (c) => {
    const { configId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    await withTenantTx(database, tenant, (tx) =>
      resetSectionOverride(tx, tenant.schoolId, configId),
    );
    return c.body(null, 204);
  });

  routes.openapi(keepOverrideRoute, async (c) => {
    const { configId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        acknowledgeGradeRevision(tx, tenant.schoolId, configId),
      ),
      200,
    );
  });

  routes.openapi(sectionSubjectsRoute, async (c) => {
    const { sectionId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const { section, subjects } = await withTenantTx(database, tenant, (tx) =>
      listSectionSubjects(tx, tenant.schoolId, sectionId),
    );
    return c.json(
      {
        section: {
          id: section.id,
          name: section.name,
          academic_year_id: section.academic_year_id,
          grade_level_id: section.grade_level_id,
          grade_level_name: section.grade_level_name,
        },
        subjects,
      },
      200,
    );
  });

  routes.openapi(overrideRoute, async (c) => {
    const { sectionId, subjectId } = c.req.valid("param");
    const { mode } = c.req.valid("json");
    const tenant = tenantFrom(c);
    const result = await withTenantTx(database, tenant, (tx) =>
      createSectionOverride(tx, tenant.schoolId, tenant.userId, sectionId, subjectId, mode),
    );
    return c.json(result, 201);
  });

  routes.openapi(listEnrollmentsRoute, async (c) => {
    const { sectionId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const enrollments = await withTenantTx(database, tenant, (tx) =>
      listSubjectEnrollments(tx, tenant.schoolId, sectionId),
    );
    return c.json({ enrollments }, 200);
  });

  routes.openapi(setEnrollmentRoute, async (c) => {
    const { sectionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    await withTenantTx(database, tenant, (tx) =>
      setSubjectEnrollment(tx, tenant.schoolId, sectionId, body),
    );
    return c.body(null, 204);
  });

  routes.openapi(listAssignmentsRoute, async (c) => {
    const { yearId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const assignments = await withTenantTx(database, tenant, (tx) =>
      listTeacherAssignments(tx, tenant.schoolId, yearId),
    );
    return c.json({ assignments }, 200);
  });

  routes.openapi(createAssignmentRoute, async (c) => {
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        createTeacherAssignment(tx, tenant.schoolId, body),
      ),
      201,
    );
  });

  routes.openapi(deleteAssignmentRoute, async (c) => {
    const { assignmentId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    await withTenantTx(database, tenant, (tx) =>
      deleteTeacherAssignment(tx, tenant.schoolId, assignmentId),
    );
    return c.body(null, 204);
  });

  return routes;
}
