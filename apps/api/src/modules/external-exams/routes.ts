import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../db/tenant-tx";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { onlyMethods } from "../../middleware/only-methods";
import { openApiValidationHook } from "../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../openapi/responses";

import {
  externalExamBodySchema,
  externalExamFromPresetBodySchema,
  externalExamIdParamSchema,
  externalExamListQuerySchema,
  externalExamListSchema,
  externalExamPresetListSchema,
  externalExamResultIdParamSchema,
  externalExamResultListSchema,
  externalExamResultSchema,
  externalExamSchema,
  externalExamStudentParamSchema,
  recordExternalExamResultBodySchema,
  updateExternalExamResultBodySchema,
} from "./schemas";
import {
  createExternalExam,
  createExternalExamFromPreset,
  deleteExternalExamResult,
  listExternalExamPresets,
  listExternalExams,
  listStudentExternalExamResults,
  recordExternalExamResult,
  setExternalExamArchived,
  updateExternalExam,
  updateExternalExamResult,
} from "./service";

import type { Database } from "../../db/client";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

/**
 * External exams and test scores (000255). School leadership (academicConfig:manage) manages the
 * catalogue and records results; teaching staff (academicConfig:read) read the catalogue; anyone
 * with grade:read reads a student's results when they may read the student (leadership, the
 * student's teachers, the student, linked parents) -- checked in the service and by RLS.
 */

const TAGS = ["External exams"];
const security = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

const listPresetsRoute = createRoute({
  method: "get",
  path: "/api/grading/external-exam-presets",
  tags: TAGS,
  operationId: "listExternalExamPresets",
  summary: "Built-in external exams a school can add",
  description:
    "SAT, PSAT, ACT, AP, IELTS, TOEFL iBT, IGCSE, A Level and IB DP final results, Jordan's " +
    "Tawjihi, Egypt's Thanaweya Amma and a US state assessment. `note` says which defaults to check.",
  security,
  responses: standardResponses(
    { 200: { description: "Presets.", schema: externalExamPresetListSchema } },
    [401, 403, 500],
  ),
});

const listExamsRoute = createRoute({
  method: "get",
  path: "/api/grading/external-exams",
  tags: TAGS,
  operationId: "listExternalExams",
  summary: "The school's external exam catalogue",
  description: "Active exams by name, then archived ones when include_archived is true.",
  security,
  request: { query: externalExamListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Exams.", schema: externalExamListSchema } },
    [400, 401, 403, 500],
  ),
});

const createExamRoute = createRoute({
  method: "post",
  path: "/api/grading/external-exams",
  tags: TAGS,
  operationId: "createExternalExam",
  summary: "Add a custom external exam",
  description: "409 CONFLICT_DUPLICATE_ENTRY when the code is already used in the school.",
  security,
  request: { body: json(externalExamBodySchema) },
  responses: standardResponses(
    { 201: { description: "The new exam.", schema: externalExamSchema } },
    [400, 401, 403, 409, 500],
  ),
});

const createFromPresetRoute = createRoute({
  method: "post",
  path: "/api/grading/external-exams/from-preset",
  tags: TAGS,
  operationId: "createExternalExamFromPreset",
  summary: "Add a built-in external exam to the catalogue",
  description:
    "Copies the preset; the copy is the school's own and can be edited. 409 when its code is used.",
  security,
  request: { body: json(externalExamFromPresetBodySchema) },
  responses: standardResponses(
    { 201: { description: "The new exam.", schema: externalExamSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const updateExamRoute = createRoute({
  method: "put",
  path: "/api/grading/external-exams/{examId}",
  tags: TAGS,
  operationId: "updateExternalExam",
  summary: "Replace an external exam's definition",
  description:
    "Components with an id are updated, new ones added, missing ones removed. Once results are " +
    "recorded, the total, the per-subject setting and how a scored component is scored are locked " +
    "(409), and a scored component cannot be removed.",
  security,
  request: { params: externalExamIdParamSchema, body: json(externalExamBodySchema) },
  responses: standardResponses(
    { 200: { description: "The exam.", schema: externalExamSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const archiveExamRoute = createRoute({
  method: "post",
  path: "/api/grading/external-exams/{examId}/archive",
  tags: TAGS,
  operationId: "archiveExternalExam",
  summary: "Archive an external exam",
  description: "No new results can be recorded; existing results stay.",
  security,
  request: { params: externalExamIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The exam.", schema: externalExamSchema } },
    [401, 403, 404, 500],
  ),
});

const restoreExamRoute = createRoute({
  method: "post",
  path: "/api/grading/external-exams/{examId}/restore",
  tags: TAGS,
  operationId: "restoreExternalExam",
  summary: "Restore an archived external exam",
  security,
  request: { params: externalExamIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The exam.", schema: externalExamSchema } },
    [401, 403, 404, 500],
  ),
});

const listResultsRoute = createRoute({
  method: "get",
  path: "/api/grading/students/{studentId}/external-exam-results",
  tags: TAGS,
  operationId: "listStudentExternalExamResults",
  summary: "A student's external exam results and test scores",
  description:
    "Newest sitting first. School leadership, the student's teachers, the student, or a linked parent.",
  security,
  request: { params: externalExamStudentParamSchema },
  responses: standardResponses(
    { 200: { description: "Results.", schema: externalExamResultListSchema } },
    [401, 403, 404, 500],
  ),
});

const recordResultRoute = createRoute({
  method: "post",
  path: "/api/grading/students/{studentId}/external-exam-results",
  tags: TAGS,
  operationId: "recordExternalExamResult",
  summary: "Record a student's external exam result",
  description:
    "Each score is checked against its component (range, step, allowed grades); the total is " +
    "worked out from the scores. 409 when the exam is archived.",
  security,
  request: {
    params: externalExamStudentParamSchema,
    body: json(recordExternalExamResultBodySchema),
  },
  responses: standardResponses(
    { 201: { description: "The recorded result.", schema: externalExamResultSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const updateResultRoute = createRoute({
  method: "put",
  path: "/api/grading/external-exam-results/{resultId}",
  tags: TAGS,
  operationId: "updateExternalExamResult",
  summary: "Replace a recorded result's subject, date, note and scores",
  security,
  request: {
    params: externalExamResultIdParamSchema,
    body: json(updateExternalExamResultBodySchema),
  },
  responses: standardResponses(
    { 200: { description: "The result.", schema: externalExamResultSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const deleteResultRoute = createRoute({
  method: "delete",
  path: "/api/grading/external-exam-results/{resultId}",
  tags: TAGS,
  operationId: "deleteExternalExamResult",
  summary: "Delete a recorded result",
  description: "Transcripts already issued keep the copy they were issued with.",
  security,
  request: { params: externalExamResultIdParamSchema },
  responses: {
    204: { description: "Deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 500]),
  },
});

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

export function externalExamRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  const readCatalogue = requirePermission(PERMISSIONS.ACADEMIC_CONFIG_READ);
  const manage = requirePermission(PERMISSIONS.ACADEMIC_CONFIG_MANAGE);
  const readGrades = requirePermission(PERMISSIONS.GRADE_READ);

  routes.use("/api/grading/external-exam-presets", readCatalogue);
  routes.use(
    "/api/grading/external-exams",
    onlyMethods(["GET"], readCatalogue),
    onlyMethods(["POST"], manage),
    auditAction("insert", "external_exams"),
  );
  routes.use(
    "/api/grading/external-exams/from-preset",
    manage,
    auditAction("insert", "external_exams"),
  );
  routes.use(
    "/api/grading/external-exams/:examId",
    manage,
    auditAction("update", "external_exams"),
  );
  routes.use(
    "/api/grading/external-exams/:examId/archive",
    manage,
    auditAction("update", "external_exams"),
  );
  routes.use(
    "/api/grading/external-exams/:examId/restore",
    manage,
    auditAction("update", "external_exams"),
  );
  // One path, two methods: reading is for anyone who may see the student, recording for leadership.
  routes.on("GET", "/api/grading/students/:studentId/external-exam-results", readGrades);
  routes.on(
    "POST",
    "/api/grading/students/:studentId/external-exam-results",
    manage,
    auditAction("insert", "student_external_exam_results"),
  );
  routes.on(
    "PUT",
    "/api/grading/external-exam-results/:resultId",
    manage,
    auditAction("update", "student_external_exam_results"),
  );
  routes.on(
    "DELETE",
    "/api/grading/external-exam-results/:resultId",
    manage,
    auditAction("delete", "student_external_exam_results"),
  );

  routes.openapi(listPresetsRoute, (c) => c.json({ presets: listExternalExamPresets() }, 200));

  routes.openapi(listExamsRoute, async (c) => {
    const { include_archived } = c.req.valid("query");
    const tenant = tenantFrom(c);
    const exams = await withTenantTx(database, tenant, (tx) =>
      listExternalExams(tx, tenant.schoolId, include_archived),
    );
    return c.json({ exams }, 200);
  });

  routes.openapi(createExamRoute, async (c) => {
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) => createExternalExam(tx, tenant.schoolId, body)),
      201,
    );
  });

  routes.openapi(createFromPresetRoute, async (c) => {
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        createExternalExamFromPreset(tx, tenant.schoolId, body),
      ),
      201,
    );
  });

  routes.openapi(updateExamRoute, async (c) => {
    const { examId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        updateExternalExam(tx, tenant.schoolId, examId, body),
      ),
      200,
    );
  });

  routes.openapi(archiveExamRoute, async (c) => {
    const { examId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        setExternalExamArchived(tx, tenant.schoolId, examId, true),
      ),
      200,
    );
  });

  routes.openapi(restoreExamRoute, async (c) => {
    const { examId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        setExternalExamArchived(tx, tenant.schoolId, examId, false),
      ),
      200,
    );
  });

  routes.openapi(listResultsRoute, async (c) => {
    const { studentId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    const results = await withTenantTx(database, tenant, (tx) =>
      listStudentExternalExamResults(tx, tenant.schoolId, studentId),
    );
    return c.json({ results }, 200);
  });

  routes.openapi(recordResultRoute, async (c) => {
    const { studentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        recordExternalExamResult(tx, tenant.schoolId, tenant.userId, studentId, body),
      ),
      201,
    );
  });

  routes.openapi(updateResultRoute, async (c) => {
    const { resultId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        updateExternalExamResult(tx, tenant.schoolId, resultId, body),
      ),
      200,
    );
  });

  routes.openapi(deleteResultRoute, async (c) => {
    const { resultId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    await withTenantTx(database, tenant, (tx) =>
      deleteExternalExamResult(tx, tenant.schoolId, resultId),
    );
    return c.body(null, 204);
  });

  return routes;
}
