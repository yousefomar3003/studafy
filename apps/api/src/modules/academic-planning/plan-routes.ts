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
  createLessonPlan,
  createTermPlan,
  deleteLessonPlan,
  deleteTermPlan,
  getLessonPlan,
  getLessonPlanOptions,
  getPlanCoverage,
  getTermPlan,
  listLessonPlans,
  listPlanReviews,
  listTermPlans,
  reviewLessonPlan,
  reviewTermPlan,
  saveLessonReflection,
  submitLessonPlan,
  submitTermPlan,
  updateLessonPlan,
  updateTermPlan,
} from "./plan-service";
import {
  lessonPlanBodySchema,
  lessonPlanListQuerySchema,
  lessonPlanListSchema,
  lessonPlanOptionsQuerySchema,
  lessonPlanOptionsSchema,
  lessonPlanSchema,
  lessonReflectionBodySchema,
  planCoverageQuerySchema,
  planCoverageSchema,
  planIdParamSchema,
  planReviewBodySchema,
  planReviewsQuerySchema,
  planReviewsSchema,
  sectionSubjectParamSchema,
  termPlanBodySchema,
  termPlanListSchema,
  termPlanSchema,
  termPlanUpdateBodySchema,
} from "./schemas";

import type { Database } from "../../db/client";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

const TAGS = ["Lesson plans"];
const security = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

const deleted = {
  204: { description: "Deleted.", headers: requestIdHeaders },
  ...standardResponses({}, [401, 403, 404, 409, 500]),
};

// ---------------------------------------------------------------------------
// Term plans
// ---------------------------------------------------------------------------

const listTermPlansRoute = createRoute({
  method: "get",
  path: "/api/grading/sections/{sectionId}/subjects/{subjectId}/term-plans",
  tags: TAGS,
  operationId: "listTermPlans",
  summary: "A section's term plans in one subject",
  description: "For its teachers, its coordinator and leadership.",
  security,
  request: { params: sectionSubjectParamSchema },
  responses: standardResponses(
    { 200: { description: "Term plans.", schema: termPlanListSchema } },
    [401, 403, 404, 500],
  ),
});

const createTermPlanRoute = createRoute({
  method: "post",
  path: "/api/grading/sections/{sectionId}/subjects/{subjectId}/term-plans",
  tags: TAGS,
  operationId: "createTermPlan",
  summary: "Start a term plan (draft)",
  description:
    "A teacher of the subject in the section. One plan per term: 409 CONFLICT_DUPLICATE_ENTRY for a second.",
  security,
  request: { params: sectionSubjectParamSchema, body: json(termPlanBodySchema) },
  responses: standardResponses(
    { 201: { description: "Term plan.", schema: termPlanSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const getTermPlanRoute = createRoute({
  method: "get",
  path: "/api/grading/term-plans/{planId}",
  tags: TAGS,
  operationId: "getTermPlan",
  summary: "A term plan with its weeks",
  security,
  request: { params: planIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Term plan.", schema: termPlanSchema } },
    [401, 403, 404, 500],
  ),
});

const updateTermPlanRoute = createRoute({
  method: "put",
  path: "/api/grading/term-plans/{planId}",
  tags: TAGS,
  operationId: "updateTermPlan",
  summary: "Replace a draft or returned term plan's notes and weeks",
  security,
  request: { params: planIdParamSchema, body: json(termPlanUpdateBodySchema) },
  responses: standardResponses(
    { 200: { description: "Term plan.", schema: termPlanSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteTermPlanRoute = createRoute({
  method: "delete",
  path: "/api/grading/term-plans/{planId}",
  tags: TAGS,
  operationId: "deleteTermPlan",
  summary: "Delete a draft term plan",
  security,
  request: { params: planIdParamSchema },
  responses: deleted,
});

const submitTermPlanRoute = createRoute({
  method: "post",
  path: "/api/grading/term-plans/{planId}/submit",
  tags: TAGS,
  operationId: "submitTermPlan",
  summary: "Submit a term plan for review",
  security,
  request: { params: planIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Term plan.", schema: termPlanSchema } },
    [401, 403, 404, 409, 500],
  ),
});

const reviewTermPlanRoute = createRoute({
  method: "post",
  path: "/api/grading/term-plans/{planId}/review",
  tags: TAGS,
  operationId: "reviewTermPlan",
  summary: "Approve a submitted term plan, or return it with a comment",
  description:
    "The subject's coordinator for the section's grade, or leadership; never the plan's author.",
  security,
  request: { params: planIdParamSchema, body: json(planReviewBodySchema) },
  responses: standardResponses(
    { 200: { description: "Term plan.", schema: termPlanSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

// ---------------------------------------------------------------------------
// Lesson plans
// ---------------------------------------------------------------------------

const listLessonPlansRoute = createRoute({
  method: "get",
  path: "/api/grading/sections/{sectionId}/subjects/{subjectId}/lesson-plans",
  tags: TAGS,
  operationId: "listLessonPlans",
  summary: "A section's lesson plans in one subject, newest lesson first",
  security,
  request: { params: sectionSubjectParamSchema, query: lessonPlanListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Lesson plans.", schema: lessonPlanListSchema } },
    [401, 403, 404, 500],
  ),
});

const createLessonPlanRoute = createRoute({
  method: "post",
  path: "/api/grading/sections/{sectionId}/subjects/{subjectId}/lesson-plans",
  tags: TAGS,
  operationId: "createLessonPlan",
  summary: "Write a lesson plan (draft)",
  description:
    "A teacher of the subject in the section. The date must fall in the section's academic year; materials must be the class's uploaded materials.",
  security,
  request: { params: sectionSubjectParamSchema, body: json(lessonPlanBodySchema) },
  responses: standardResponses(
    { 201: { description: "Lesson plan.", schema: lessonPlanSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const lessonOptionsRoute = createRoute({
  method: "get",
  path: "/api/grading/sections/{sectionId}/subjects/{subjectId}/lesson-plan-options",
  tags: TAGS,
  operationId: "getLessonPlanOptions",
  summary: "What a lesson plan picks from",
  description:
    "The live timetable's periods for this section's subject on the date, the class's uploaded materials and the grade's active outcomes.",
  security,
  request: { params: sectionSubjectParamSchema, query: lessonPlanOptionsQuerySchema },
  responses: standardResponses(
    { 200: { description: "Options.", schema: lessonPlanOptionsSchema } },
    [401, 403, 404, 500],
  ),
});

const getLessonPlanRoute = createRoute({
  method: "get",
  path: "/api/grading/lesson-plans/{planId}",
  tags: TAGS,
  operationId: "getLessonPlan",
  summary: "A lesson plan",
  security,
  request: { params: planIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Lesson plan.", schema: lessonPlanSchema } },
    [401, 403, 404, 500],
  ),
});

const updateLessonPlanRoute = createRoute({
  method: "put",
  path: "/api/grading/lesson-plans/{planId}",
  tags: TAGS,
  operationId: "updateLessonPlan",
  summary: "Replace a draft or returned lesson plan",
  security,
  request: { params: planIdParamSchema, body: json(lessonPlanBodySchema) },
  responses: standardResponses(
    { 200: { description: "Lesson plan.", schema: lessonPlanSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteLessonPlanRoute = createRoute({
  method: "delete",
  path: "/api/grading/lesson-plans/{planId}",
  tags: TAGS,
  operationId: "deleteLessonPlan",
  summary: "Delete a draft lesson plan",
  security,
  request: { params: planIdParamSchema },
  responses: deleted,
});

const submitLessonPlanRoute = createRoute({
  method: "post",
  path: "/api/grading/lesson-plans/{planId}/submit",
  tags: TAGS,
  operationId: "submitLessonPlan",
  summary: "Submit a lesson plan for review",
  security,
  request: { params: planIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Lesson plan.", schema: lessonPlanSchema } },
    [401, 403, 404, 409, 500],
  ),
});

const reviewLessonPlanRoute = createRoute({
  method: "post",
  path: "/api/grading/lesson-plans/{planId}/review",
  tags: TAGS,
  operationId: "reviewLessonPlan",
  summary: "Approve a submitted lesson plan, or return it with a comment",
  description:
    "The subject's coordinator for the section's grade, or leadership; never the plan's author.",
  security,
  request: { params: planIdParamSchema, body: json(planReviewBodySchema) },
  responses: standardResponses(
    { 200: { description: "Lesson plan.", schema: lessonPlanSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const reflectionRoute = createRoute({
  method: "put",
  path: "/api/grading/lesson-plans/{planId}/reflection",
  tags: TAGS,
  operationId: "saveLessonReflection",
  summary: "Write the teacher's reflection after the lesson",
  description: "A teacher of the subject in the section, in any status.",
  security,
  request: { params: planIdParamSchema, body: json(lessonReflectionBodySchema) },
  responses: standardResponses(
    { 200: { description: "Lesson plan.", schema: lessonPlanSchema } },
    [400, 401, 403, 404, 500],
  ),
});

// ---------------------------------------------------------------------------
// Review queue and coverage
// ---------------------------------------------------------------------------

const reviewsRoute = createRoute({
  method: "get",
  path: "/api/grading/plan-reviews",
  tags: TAGS,
  operationId: "listPlanReviews",
  summary: "The plans the caller reviews",
  description:
    "Leadership: every section's; a coordinator: their subjects' in the grades they cover; anyone else: none. Default status submitted.",
  security,
  request: { query: planReviewsQuerySchema },
  responses: standardResponses(
    { 200: { description: "Plans.", schema: planReviewsSchema } },
    [401, 403, 404, 500],
  ),
});

const coverageRoute = createRoute({
  method: "get",
  path: "/api/grading/plan-coverage",
  tags: TAGS,
  operationId: "getPlanCoverage",
  summary: "Plan coverage for a term",
  description:
    "Per section and subject taught: the term plan and whether it came in on time, lesson plans by status and timeliness, and the grade's outcomes the submitted plans cover. Leadership sees every section; a coordinator their subjects'.",
  security,
  request: { query: planCoverageQuerySchema },
  responses: standardResponses(
    { 200: { description: "Coverage.", schema: planCoverageSchema } },
    [401, 403, 404, 500],
  ),
});

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

/**
 * Lesson and term plans (000267). Reads and reviews are behind academicConfig:read (teachers,
 * coordinators and leadership hold it) and narrowed per row to the section's teachers, its
 * coordinator and leadership; writing is behind lesson:create / lesson:update / lesson:delete and
 * narrowed to a teacher of the subject in the section.
 */
export function academicPlanRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const read = requirePermission(PERMISSIONS.ACADEMIC_CONFIG_READ);
  const create = requirePermission(PERMISSIONS.LESSON_CREATE);
  const update = requirePermission(PERMISSIONS.LESSON_UPDATE);
  const remove = requirePermission(PERMISSIONS.LESSON_DELETE);

  routes.use(
    "/api/grading/sections/:sectionId/subjects/:subjectId/term-plans",
    onlyMethods(["GET"], read),
    onlyMethods(["POST"], create),
    auditAction("insert", "term_plans"),
  );
  routes.use(
    "/api/grading/term-plans/:planId",
    onlyMethods(["GET"], read),
    onlyMethods(["PUT"], update),
    onlyMethods(["DELETE"], remove),
    onlyMethods(["PUT"], auditAction("update", "term_plans")),
    onlyMethods(["DELETE"], auditAction("delete", "term_plans")),
  );
  routes.use("/api/grading/term-plans/:planId/submit", update, auditAction("update", "term_plans"));
  // Coordinators hold no approval permission: the service checks the coordinator assignment.
  routes.use("/api/grading/term-plans/:planId/review", read, auditAction("update", "term_plans"));
  routes.use(
    "/api/grading/sections/:sectionId/subjects/:subjectId/lesson-plans",
    onlyMethods(["GET"], read),
    onlyMethods(["POST"], create),
    auditAction("insert", "lesson_plans"),
  );
  routes.use(
    "/api/grading/lesson-plans/:planId",
    onlyMethods(["GET"], read),
    onlyMethods(["PUT"], update),
    onlyMethods(["DELETE"], remove),
    onlyMethods(["PUT"], auditAction("update", "lesson_plans")),
    onlyMethods(["DELETE"], auditAction("delete", "lesson_plans")),
  );
  routes.use(
    "/api/grading/lesson-plans/:planId/submit",
    update,
    auditAction("update", "lesson_plans"),
  );
  // Coordinators hold no approval permission: the service checks the coordinator assignment.
  routes.use(
    "/api/grading/lesson-plans/:planId/review",
    read,
    auditAction("update", "lesson_plans"),
  );
  routes.use(
    "/api/grading/lesson-plans/:planId/reflection",
    update,
    auditAction("update", "lesson_plans"),
  );
  routes.use("/api/grading/sections/:sectionId/subjects/:subjectId/lesson-plan-options", read);
  routes.use("/api/grading/plan-reviews", read);
  routes.use("/api/grading/plan-coverage", read);

  routes.openapi(listTermPlansRoute, async (c) => {
    const { sectionId, subjectId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        listTermPlans(tx, tenant.schoolId, sectionId, subjectId),
      ),
      200,
    );
  });

  routes.openapi(createTermPlanRoute, async (c) => {
    const { sectionId, subjectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        createTermPlan(tx, tenant.schoolId, tenant.userId, sectionId, subjectId, body),
      ),
      201,
    );
  });

  routes.openapi(getTermPlanRoute, async (c) => {
    const { planId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        getTermPlan(tx, tenant.schoolId, tenant.userId, planId),
      ),
      200,
    );
  });

  routes.openapi(updateTermPlanRoute, async (c) => {
    const { planId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        updateTermPlan(tx, tenant.schoolId, tenant.userId, planId, body),
      ),
      200,
    );
  });

  routes.openapi(deleteTermPlanRoute, async (c) => {
    const { planId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    await withTenantTx(database, tenant, (tx) => deleteTermPlan(tx, tenant.schoolId, planId));
    return c.body(null, 204);
  });

  routes.openapi(submitTermPlanRoute, async (c) => {
    const { planId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        submitTermPlan(tx, tenant.schoolId, tenant.userId, planId),
      ),
      200,
    );
  });

  routes.openapi(reviewTermPlanRoute, async (c) => {
    const { planId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        reviewTermPlan(tx, tenant.schoolId, tenant.userId, planId, body),
      ),
      200,
    );
  });

  routes.openapi(listLessonPlansRoute, async (c) => {
    const { sectionId, subjectId } = c.req.valid("param");
    const query = c.req.valid("query");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        listLessonPlans(tx, tenant.schoolId, sectionId, subjectId, query),
      ),
      200,
    );
  });

  routes.openapi(createLessonPlanRoute, async (c) => {
    const { sectionId, subjectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        createLessonPlan(tx, tenant.schoolId, tenant.userId, sectionId, subjectId, body),
      ),
      201,
    );
  });

  routes.openapi(lessonOptionsRoute, async (c) => {
    const { sectionId, subjectId } = c.req.valid("param");
    const { date } = c.req.valid("query");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        getLessonPlanOptions(tx, tenant.schoolId, sectionId, subjectId, date),
      ),
      200,
    );
  });

  routes.openapi(getLessonPlanRoute, async (c) => {
    const { planId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        getLessonPlan(tx, tenant.schoolId, tenant.userId, planId),
      ),
      200,
    );
  });

  routes.openapi(updateLessonPlanRoute, async (c) => {
    const { planId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        updateLessonPlan(tx, tenant.schoolId, tenant.userId, planId, body),
      ),
      200,
    );
  });

  routes.openapi(deleteLessonPlanRoute, async (c) => {
    const { planId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    await withTenantTx(database, tenant, (tx) => deleteLessonPlan(tx, tenant.schoolId, planId));
    return c.body(null, 204);
  });

  routes.openapi(submitLessonPlanRoute, async (c) => {
    const { planId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        submitLessonPlan(tx, tenant.schoolId, tenant.userId, planId),
      ),
      200,
    );
  });

  routes.openapi(reviewLessonPlanRoute, async (c) => {
    const { planId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        reviewLessonPlan(tx, tenant.schoolId, tenant.userId, planId, body),
      ),
      200,
    );
  });

  routes.openapi(reflectionRoute, async (c) => {
    const { planId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        saveLessonReflection(tx, tenant.schoolId, tenant.userId, planId, body.reflection),
      ),
      200,
    );
  });

  routes.openapi(reviewsRoute, async (c) => {
    const query = c.req.valid("query");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        listPlanReviews(tx, tenant.schoolId, tenant.userId, {
          yearId: query.academic_year_id,
          status: query.status,
        }),
      ),
      200,
    );
  });

  routes.openapi(coverageRoute, async (c) => {
    const { term_id } = c.req.valid("query");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) => getPlanCoverage(tx, tenant.schoolId, term_id)),
      200,
    );
  });

  return routes;
}
