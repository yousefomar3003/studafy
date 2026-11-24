import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../db/tenant-tx";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { hasPermission, requirePermission } from "../../middleware/authz";
import { onlyMethods } from "../../middleware/only-methods";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";

import {
  addRemedialNoteBodySchema,
  createRemedialPlanBodySchema,
  remedialPlanDetailSchema,
  remedialPlanIdParamSchema,
  remedialPlanListQuerySchema,
  remedialPlanListSchema,
  remedialSectionSubjectParamSchema,
  remedialSettingsSchema,
  remedialStudentParamSchema,
  sectionRemedialPlansSchema,
  sectionRemedialQuerySchema,
  studentRemedialPlansSchema,
  updateRemedialPlanBodySchema,
} from "./schemas";
import {
  addRemedialPlanNote,
  createRemedialPlan,
  getRemedialPlan,
  getRemedialSettings,
  getSectionRemedialPlans,
  getStudentRemedialPlans,
  listRemedialPlans,
  updateRemedialPlan,
  updateRemedialSettings,
} from "./service";

import type { Database } from "../../db/client";
import type { AppEnv } from "../../middleware/requestId";
import type { Context, MiddlewareHandler } from "hono";

/**
 * Remedial plans (000269). Reads need grade:read; RLS and the service decide which plans. Writes:
 * teachers hold grade:update, principals result:finalize (as for predicted grades); the service
 * then checks who teaches, coordinates or leads. The school's sharing setting is
 * academicConfig:manage.
 */

const TAGS = ["Remedial plans"];
const security = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

const listRoute = createRoute({
  method: "get",
  path: "/api/grading/remedial-plans",
  tags: TAGS,
  operationId: "listRemedialPlans",
  summary: "Remedial plans the caller follows",
  description:
    "A year's plans (default: the latest active or finalized year) by grade level, section, subject, status or overdue review: every plan for school leadership, a teacher's own sections' subjects, a coordinator's subjects. Counts are per status over the whole year. At most 500 plans; truncated says when more matched.",
  security,
  request: { query: remedialPlanListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Plans.", schema: remedialPlanListSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const createPlanRoute = createRoute({
  method: "post",
  path: "/api/grading/remedial-plans",
  tags: TAGS,
  operationId: "createRemedialPlan",
  summary: "Open a remedial plan for a student",
  description:
    "The section's teacher of the subject or school leadership, for a student taking the subject there. The student's current percentage and the pass percentage are recorded with it. 409 REMEDIAL_PLAN_DUPLICATE when the student already has an open or in-progress plan in the subject for the period; 409 ACADEMIC_CONFIG_LOCKED once the year is finalized or archived. Audited.",
  security,
  request: { body: json(createRemedialPlanBodySchema) },
  responses: standardResponses(
    { 201: { description: "The new plan.", schema: remedialPlanDetailSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const getPlanRoute = createRoute({
  method: "get",
  path: "/api/grading/remedial-plans/{planId}",
  tags: TAGS,
  operationId: "getRemedialPlan",
  summary: "A remedial plan with its reviews and timeline",
  description:
    "Its teachers, the subject's coordinator and leadership; the student and linked parents only when the plan is shared and the school allows it, without internal notes. 404 for anyone else.",
  security,
  request: { params: remedialPlanIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The plan.", schema: remedialPlanDetailSchema } },
    [401, 403, 404, 500],
  ),
});

const updatePlanRoute = createRoute({
  method: "patch",
  path: "/api/grading/remedial-plans/{planId}",
  tags: TAGS,
  operationId: "updateRemedialPlan",
  summary: "Change a remedial plan",
  description:
    "Its teacher or leadership, while the plan is open or in progress and the year open. Omitted fields are unchanged; review_dates replaces the dates (dates kept stay done). Status moves forward only (open -> in_progress -> achieved or closed) and is recorded on the timeline. 409 REMEDIAL_PLAN_CLOSED for an achieved or closed plan. Audited.",
  security,
  request: { params: remedialPlanIdParamSchema, body: json(updateRemedialPlanBodySchema) },
  responses: standardResponses(
    { 200: { description: "The plan.", schema: remedialPlanDetailSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const addNoteRoute = createRoute({
  method: "post",
  path: "/api/grading/remedial-plans/{planId}/notes",
  tags: TAGS,
  operationId: "addRemedialPlanNote",
  summary: "Add a progress or follow-up note to a remedial plan",
  description:
    "Its teacher, the subject's coordinator or leadership. Completes every review due by today. An internal note is never shown to the student or parents. Audited.",
  security,
  request: { params: remedialPlanIdParamSchema, body: json(addRemedialNoteBodySchema) },
  responses: standardResponses(
    { 201: { description: "The plan.", schema: remedialPlanDetailSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const sectionRoute = createRoute({
  method: "get",
  path: "/api/grading/sections/{sectionId}/subjects/{subjectId}/remedial-plans",
  tags: TAGS,
  operationId: "getSectionRemedialPlans",
  summary: "A section's subject: remedial plans and suggestions",
  description:
    "The subject's teachers in the section, its coordinator and leadership: every plan this year, the students taking the subject, and the students below the pass percentage on their current marks for the term (term_id) or the year.",
  security,
  request: { params: remedialSectionSubjectParamSchema, query: sectionRemedialQuerySchema },
  responses: standardResponses(
    { 200: { description: "Plans and suggestions.", schema: sectionRemedialPlansSchema } },
    [401, 403, 404, 500],
  ),
});

const studentRoute = createRoute({
  method: "get",
  path: "/api/grading/students/{studentId}/remedial-plans",
  tags: TAGS,
  operationId: "getStudentRemedialPlans",
  summary: "A student's remedial plans",
  description:
    "Leadership, the student's teachers and coordinators see the plans they follow. The student and linked parents see the shared plans while the school allows sharing, never an internal note.",
  security,
  request: { params: remedialStudentParamSchema },
  responses: standardResponses(
    { 200: { description: "Plans, active first.", schema: studentRemedialPlansSchema } },
    [401, 403, 404, 500],
  ),
});

const getSettingsRoute = createRoute({
  method: "get",
  path: "/api/grading/remedial-plan-settings",
  tags: TAGS,
  operationId: "getRemedialPlanSettings",
  summary: "The school's remedial plan settings",
  description: "Whether teachers may share plans with the student and linked parents.",
  security,
  responses: standardResponses(
    { 200: { description: "Settings.", schema: remedialSettingsSchema } },
    [401, 403, 500],
  ),
});

const putSettingsRoute = createRoute({
  method: "put",
  path: "/api/grading/remedial-plan-settings",
  tags: TAGS,
  operationId: "updateRemedialPlanSettings",
  summary: "Change the school's remedial plan settings",
  description:
    "School leadership (academicConfig:manage). Turning sharing off hides every plan from students and parents at once; each plan keeps its own choice for when it is turned back on. Audited.",
  security,
  request: { body: json(remedialSettingsSchema) },
  responses: standardResponses(
    { 200: { description: "Settings.", schema: remedialSettingsSchema } },
    [400, 401, 403, 500],
  ),
});

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

/** Teachers write with grade:update; principals, who hold result:finalize instead, with that. */
const requirePlanWriter: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = requireAuth(c);
  if (
    !hasPermission(auth.roles, PERMISSIONS.GRADE_UPDATE) &&
    !hasPermission(auth.roles, PERMISSIONS.RESULT_FINALIZE)
  ) {
    throw new HTTPException(403, { message: "Insufficient permissions for this operation" });
  }
  await next();
};

export function remedialPlanRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const readGrades = requirePermission(PERMISSIONS.GRADE_READ);

  routes.use(
    "/api/grading/remedial-plans",
    readGrades,
    onlyMethods(["POST"], requirePlanWriter),
    auditAction("insert", "remedial_plans"),
  );
  routes.use(
    "/api/grading/remedial-plans/:planId",
    readGrades,
    onlyMethods(["PATCH"], requirePlanWriter),
    auditAction("update", "remedial_plans"),
  );
  routes.use(
    "/api/grading/remedial-plans/:planId/notes",
    readGrades,
    requirePlanWriter,
    auditAction("insert", "remedial_plan_notes"),
  );
  routes.use("/api/grading/sections/:sectionId/subjects/:subjectId/remedial-plans", readGrades);
  routes.use("/api/grading/students/:studentId/remedial-plans", readGrades);
  routes.use(
    "/api/grading/remedial-plan-settings",
    onlyMethods(["GET"], requirePermission(PERMISSIONS.ACADEMIC_CONFIG_READ)),
    onlyMethods(["PUT"], requirePermission(PERMISSIONS.ACADEMIC_CONFIG_MANAGE)),
    auditAction("update", "school_settings"),
  );

  routes.openapi(listRoute, async (c) => {
    const query = c.req.valid("query");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        listRemedialPlans(tx, tenant.schoolId, {
          ...query,
          overdue: query.overdue === undefined ? undefined : query.overdue === "true",
        }),
      ),
      200,
    );
  });

  routes.openapi(createPlanRoute, async (c) => {
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        createRemedialPlan(tx, tenant.schoolId, tenant.userId, body),
      ),
      201,
    );
  });

  routes.openapi(getPlanRoute, async (c) => {
    const { planId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) => getRemedialPlan(tx, tenant.schoolId, planId)),
      200,
    );
  });

  routes.openapi(updatePlanRoute, async (c) => {
    const { planId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        updateRemedialPlan(tx, tenant.schoolId, tenant.userId, planId, body),
      ),
      200,
    );
  });

  routes.openapi(addNoteRoute, async (c) => {
    const { planId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        addRemedialPlanNote(tx, tenant.schoolId, tenant.userId, planId, body),
      ),
      201,
    );
  });

  routes.openapi(sectionRoute, async (c) => {
    const { sectionId, subjectId } = c.req.valid("param");
    const { term_id } = c.req.valid("query");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        getSectionRemedialPlans(tx, tenant.schoolId, sectionId, subjectId, term_id ?? null),
      ),
      200,
    );
  });

  routes.openapi(studentRoute, async (c) => {
    const { studentId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        getStudentRemedialPlans(tx, tenant.schoolId, studentId),
      ),
      200,
    );
  });

  routes.openapi(getSettingsRoute, async (c) => {
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) => getRemedialSettings(tx, tenant.schoolId)),
      200,
    );
  });

  routes.openapi(putSettingsRoute, async (c) => {
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        updateRemedialSettings(tx, tenant.schoolId, body),
      ),
      200,
    );
  });

  return routes;
}
