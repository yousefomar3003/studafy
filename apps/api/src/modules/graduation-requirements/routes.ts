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
  graduationChecklistSchema,
  graduationPreviewQuerySchema,
  graduationPreviewSchema,
  graduationReportQuerySchema,
  graduationReportSchema,
  graduationSetBodySchema,
  graduationSetIdParamSchema,
  graduationSetListSchema,
  graduationSetSchema,
  graduationStudentParamSchema,
} from "./schemas";
import {
  createGraduationSet,
  deleteGraduationSet,
  graduationReport,
  listGraduationSets,
  previewGraduationSet,
  studentGraduationChecklist,
  updateGraduationSet,
} from "./service";

import type { Database } from "../../db/client";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

/**
 * Graduation requirements (000258). School leadership (academicConfig:manage) manages the sets,
 * previews them against a student and reads the "not on track" report; teaching staff
 * (academicConfig:read) read the sets; anyone with grade:read reads a student's checklist when they
 * may read the student (leadership, the student's teachers, the student, linked parents) -- the
 * student and their parents only for sets shown to them. Row checks are in the service.
 */

const TAGS = ["Graduation requirements"];
const security = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

const listSetsRoute = createRoute({
  method: "get",
  path: "/api/grading/graduation-requirement-sets",
  tags: TAGS,
  operationId: "listGraduationRequirementSets",
  summary: "The school's graduation requirement sets",
  description: "Every set, active or not, by name, with its grade levels and rules in order.",
  security,
  responses: standardResponses(
    { 200: { description: "Sets.", schema: graduationSetListSchema } },
    [401, 403, 500],
  ),
});

const createSetRoute = createRoute({
  method: "post",
  path: "/api/grading/graduation-requirement-sets",
  tags: TAGS,
  operationId: "createGraduationRequirementSet",
  summary: "Add a graduation requirement set",
  description:
    "Each rule is checked by the grading engine (what its type needs). 409 " +
    "CONFLICT_DUPLICATE_ENTRY when the name is already used in the school.",
  security,
  request: { body: json(graduationSetBodySchema) },
  responses: standardResponses(
    { 201: { description: "The new set.", schema: graduationSetSchema } },
    [400, 401, 403, 409, 500],
  ),
});

const updateSetRoute = createRoute({
  method: "put",
  path: "/api/grading/graduation-requirement-sets/{setId}",
  tags: TAGS,
  operationId: "updateGraduationRequirementSet",
  summary: "Replace a graduation requirement set",
  description: "The set's grade levels and rules are replaced with the request's.",
  security,
  request: { params: graduationSetIdParamSchema, body: json(graduationSetBodySchema) },
  responses: standardResponses(
    { 200: { description: "The set.", schema: graduationSetSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteSetRoute = createRoute({
  method: "delete",
  path: "/api/grading/graduation-requirement-sets/{setId}",
  tags: TAGS,
  operationId: "deleteGraduationRequirementSet",
  summary: "Delete a graduation requirement set",
  description: "Transcripts already issued keep the outcome they were issued with.",
  security,
  request: { params: graduationSetIdParamSchema },
  responses: {
    204: { description: "Deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 500]),
  },
});

const previewRoute = createRoute({
  method: "get",
  path: "/api/grading/graduation-requirement-sets/{setId}/preview",
  tags: TAGS,
  operationId: "previewGraduationRequirementSet",
  summary: "Check a student against a set",
  description:
    "The set as saved, whether or not it applies to the student (`applies` says). For setting up " +
    "a set.",
  security,
  request: { params: graduationSetIdParamSchema, query: graduationPreviewQuerySchema },
  responses: standardResponses(
    {
      200: { description: "The student's checklist for the set.", schema: graduationPreviewSchema },
    },
    [400, 401, 403, 404, 500],
  ),
});

const reportRoute = createRoute({
  method: "get",
  path: "/api/grading/graduation-requirements/report",
  tags: TAGS,
  operationId: "getGraduationRequirementsReport",
  summary: "Students of a grade level not on track to graduate",
  description:
    "Students placed in the grade level in the academic year with a set not met, or not met yet " +
    "while their year is in progress.",
  security,
  request: { query: graduationReportQuerySchema },
  responses: standardResponses(
    { 200: { description: "The report.", schema: graduationReportSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const checklistRoute = createRoute({
  method: "get",
  path: "/api/grading/students/{studentId}/graduation-requirements",
  tags: TAGS,
  operationId: "getStudentGraduationRequirements",
  summary: "A student's graduation requirements checklist",
  description:
    "Every active set that applies to the student, each rule met, not met (with how far the " +
    "student is from it) or pending. School leadership, the student's teachers, the student, or a " +
    "linked parent; the student and parents see only the sets shown to them.",
  security,
  request: { params: graduationStudentParamSchema },
  responses: standardResponses(
    { 200: { description: "The checklist.", schema: graduationChecklistSchema } },
    [401, 403, 404, 500],
  ),
});

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

export function graduationRequirementRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  const readConfig = requirePermission(PERMISSIONS.ACADEMIC_CONFIG_READ);
  const manage = requirePermission(PERMISSIONS.ACADEMIC_CONFIG_MANAGE);
  const readGrades = requirePermission(PERMISSIONS.GRADE_READ);

  routes.use(
    "/api/grading/graduation-requirement-sets",
    onlyMethods(["GET"], readConfig),
    onlyMethods(["POST"], manage),
    auditAction("insert", "graduation_requirement_sets"),
  );
  routes.on(
    "PUT",
    "/api/grading/graduation-requirement-sets/:setId",
    manage,
    auditAction("update", "graduation_requirement_sets"),
  );
  routes.on(
    "DELETE",
    "/api/grading/graduation-requirement-sets/:setId",
    manage,
    auditAction("delete", "graduation_requirement_sets"),
  );
  routes.use("/api/grading/graduation-requirement-sets/:setId/preview", manage);
  routes.use("/api/grading/graduation-requirements/report", manage);
  routes.use("/api/grading/students/:studentId/graduation-requirements", readGrades);

  routes.openapi(listSetsRoute, async (c) => {
    const tenant = tenantFrom(c);
    const sets = await withTenantTx(database, tenant, (tx) =>
      listGraduationSets(tx, tenant.schoolId),
    );
    return c.json({ sets }, 200);
  });

  routes.openapi(createSetRoute, async (c) => {
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) => createGraduationSet(tx, tenant.schoolId, body)),
      201,
    );
  });

  routes.openapi(updateSetRoute, async (c) => {
    const { setId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        updateGraduationSet(tx, tenant.schoolId, setId, body),
      ),
      200,
    );
  });

  routes.openapi(deleteSetRoute, async (c) => {
    const { setId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    await withTenantTx(database, tenant, (tx) => deleteGraduationSet(tx, tenant.schoolId, setId));
    return c.body(null, 204);
  });

  routes.openapi(previewRoute, async (c) => {
    const { setId } = c.req.valid("param");
    const { student_id } = c.req.valid("query");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        previewGraduationSet(tx, tenant.schoolId, setId, student_id),
      ),
      200,
    );
  });

  routes.openapi(reportRoute, async (c) => {
    const { academic_year_id, grade_level_id } = c.req.valid("query");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        graduationReport(tx, tenant.schoolId, academic_year_id, grade_level_id),
      ),
      200,
    );
  });

  routes.openapi(checklistRoute, async (c) => {
    const { studentId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        studentGraduationChecklist(tx, tenant.schoolId, studentId),
      ),
      200,
    );
  });

  return routes;
}
