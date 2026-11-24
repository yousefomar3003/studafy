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
  createLearningOutcome,
  deleteLearningOutcome,
  getSectionOutcomeAchievements,
  importLearningOutcomes,
  listLearningOutcomes,
  saveSectionOutcomeAchievements,
  updateLearningOutcome,
} from "./outcome-service";
import {
  learningOutcomeBodySchema,
  learningOutcomeImportBodySchema,
  learningOutcomeImportResultSchema,
  learningOutcomeListQuerySchema,
  learningOutcomeListSchema,
  learningOutcomeSchema,
  learningOutcomeUpdateBodySchema,
  outcomeAchievementsBodySchema,
  outcomeIdParamSchema,
  planningSettingsBodySchema,
  planningSettingsSchema,
  sectionOutcomeAchievementsSchema,
  sectionSubjectParamSchema,
  termQuerySchema,
} from "./schemas";
import { getPlanningSettings, updatePlanningSettings } from "./settings-service";

import type { Database } from "../../db/client";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

const TAGS = ["Learning outcomes"];
const security = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

const getSettingsRoute = createRoute({
  method: "get",
  path: "/api/grading/planning-settings",
  tags: TAGS,
  operationId: "getPlanningSettings",
  summary: "The school's outcome achievement scale and plan settings",
  security,
  responses: standardResponses(
    { 200: { description: "Settings.", schema: planningSettingsSchema } },
    [401, 403, 500],
  ),
});

const updateSettingsRoute = createRoute({
  method: "put",
  path: "/api/grading/planning-settings",
  tags: TAGS,
  operationId: "updatePlanningSettings",
  summary: "Change the outcome achievement scale and plan settings",
  description:
    "Omitted fields keep their value. Replacing the scale renumbers it 1..n; 409 CONFLICT_STATE_MISMATCH when students already hold a level the new scale drops.",
  security,
  request: { body: json(planningSettingsBodySchema) },
  responses: standardResponses(
    { 200: { description: "Settings.", schema: planningSettingsSchema } },
    [400, 401, 403, 409, 500],
  ),
});

const listRoute = createRoute({
  method: "get",
  path: "/api/grading/learning-outcomes",
  tags: TAGS,
  operationId: "listLearningOutcomes",
  summary: "The learning outcomes catalogue",
  description: "By subject, grade level and order. Archived outcomes only with include_archived.",
  security,
  request: { query: learningOutcomeListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Outcomes.", schema: learningOutcomeListSchema } },
    [401, 403, 500],
  ),
});

const createOutcomeRoute = createRoute({
  method: "post",
  path: "/api/grading/learning-outcomes",
  tags: TAGS,
  operationId: "createLearningOutcome",
  summary: "Add a learning outcome",
  description: "409 LEARNING_OUTCOME_DUPLICATE when the code is taken for the subject and grade.",
  security,
  request: { body: json(learningOutcomeBodySchema) },
  responses: standardResponses(
    { 201: { description: "Outcome.", schema: learningOutcomeSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const updateOutcomeRoute = createRoute({
  method: "patch",
  path: "/api/grading/learning-outcomes/{outcomeId}",
  tags: TAGS,
  operationId: "updateLearningOutcome",
  summary: "Change or archive a learning outcome",
  security,
  request: { params: outcomeIdParamSchema, body: json(learningOutcomeUpdateBodySchema) },
  responses: standardResponses(
    { 200: { description: "Outcome.", schema: learningOutcomeSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteOutcomeRoute = createRoute({
  method: "delete",
  path: "/api/grading/learning-outcomes/{outcomeId}",
  tags: TAGS,
  operationId: "deleteLearningOutcome",
  summary: "Delete an unused learning outcome",
  description:
    "409 LEARNING_OUTCOME_IN_USE once achievement or a plan uses it: archive it instead.",
  security,
  request: { params: outcomeIdParamSchema },
  responses: {
    204: { description: "Deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 409, 500]),
  },
});

const importRoute = createRoute({
  method: "post",
  path: "/api/grading/learning-outcomes/import",
  tags: TAGS,
  operationId: "importLearningOutcomes",
  summary: "Import learning outcomes from CSV",
  description:
    "Adds new outcomes and updates existing ones (same subject, grade and code). All or nothing: when any row has an error, nothing is written and every error is listed with its line.",
  security,
  request: { body: json(learningOutcomeImportBodySchema) },
  responses: standardResponses(
    { 200: { description: "Import report.", schema: learningOutcomeImportResultSchema } },
    [400, 401, 403, 500],
  ),
});

const getAchievementsRoute = createRoute({
  method: "get",
  path: "/api/grading/sections/{sectionId}/subjects/{subjectId}/outcome-achievements",
  tags: TAGS,
  operationId: "getSectionOutcomeAchievements",
  summary: "A section's learning outcome achievement in one subject and period",
  description:
    "For a teacher of the subject in the section, its coordinator (read-only) or leadership: the grade's outcomes, the school's scale, and each student's levels.",
  security,
  request: { params: sectionSubjectParamSchema, query: termQuerySchema },
  responses: standardResponses(
    { 200: { description: "Achievement.", schema: sectionOutcomeAchievementsSchema } },
    [401, 403, 404, 500],
  ),
});

const saveAchievementsRoute = createRoute({
  method: "put",
  path: "/api/grading/sections/{sectionId}/subjects/{subjectId}/outcome-achievements",
  tags: TAGS,
  operationId: "saveSectionOutcomeAchievements",
  summary: "Record learning outcome achievement",
  description:
    "A teacher of the subject in the section, or leadership. Locked once the period is finalized (409 RESULTS_ALREADY_FINALIZED) or the year is not active.",
  security,
  request: { params: sectionSubjectParamSchema, body: json(outcomeAchievementsBodySchema) },
  responses: standardResponses(
    { 200: { description: "Achievement.", schema: sectionOutcomeAchievementsSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

/** Learning outcomes and their achievement (000267). */
export function learningOutcomeRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const read = requirePermission(PERMISSIONS.ACADEMIC_CONFIG_READ);
  const manage = requirePermission(PERMISSIONS.ACADEMIC_CONFIG_MANAGE);

  routes.use(
    "/api/grading/planning-settings",
    onlyMethods(["GET"], read),
    onlyMethods(["PUT"], manage),
    auditAction("update", "academic_planning_settings"),
  );
  routes.use(
    "/api/grading/learning-outcomes",
    onlyMethods(["GET"], read),
    onlyMethods(["POST"], manage),
    auditAction("insert", "learning_outcomes"),
  );
  routes.use(
    "/api/grading/learning-outcomes/import",
    manage,
    auditAction("insert", "learning_outcomes"),
  );
  routes.use(
    "/api/grading/learning-outcomes/:outcomeId",
    manage,
    onlyMethods(["PATCH"], auditAction("update", "learning_outcomes")),
    onlyMethods(["DELETE"], auditAction("delete", "learning_outcomes")),
  );
  routes.use(
    "/api/grading/sections/:sectionId/subjects/:subjectId/outcome-achievements",
    onlyMethods(["GET"], requirePermission(PERMISSIONS.GRADE_READ)),
    onlyMethods(["PUT"], requirePermission(PERMISSIONS.GRADE_UPDATE)),
    auditAction("update", "student_outcome_achievements"),
  );

  routes.openapi(getSettingsRoute, async (c) => {
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) => getPlanningSettings(tx, tenant.schoolId)),
      200,
    );
  });

  routes.openapi(updateSettingsRoute, async (c) => {
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        updatePlanningSettings(tx, tenant.schoolId, body),
      ),
      200,
    );
  });

  routes.openapi(listRoute, async (c) => {
    const query = c.req.valid("query");
    const tenant = tenantFrom(c);
    const outcomes = await withTenantTx(database, tenant, (tx) =>
      listLearningOutcomes(tx, tenant.schoolId, {
        subjectId: query.subject_id,
        gradeLevelId: query.grade_level_id,
        includeArchived: query.include_archived === "true",
      }),
    );
    return c.json({ outcomes }, 200);
  });

  routes.openapi(createOutcomeRoute, async (c) => {
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        createLearningOutcome(tx, tenant.schoolId, body),
      ),
      201,
    );
  });

  routes.openapi(importRoute, async (c) => {
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        importLearningOutcomes(tx, tenant.schoolId, {
          csv: body.csv,
          dry_run: body.dry_run ?? false,
        }),
      ),
      200,
    );
  });

  routes.openapi(updateOutcomeRoute, async (c) => {
    const { outcomeId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        updateLearningOutcome(tx, tenant.schoolId, outcomeId, body),
      ),
      200,
    );
  });

  routes.openapi(deleteOutcomeRoute, async (c) => {
    const { outcomeId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    await withTenantTx(database, tenant, (tx) =>
      deleteLearningOutcome(tx, tenant.schoolId, outcomeId),
    );
    return c.body(null, 204);
  });

  routes.openapi(getAchievementsRoute, async (c) => {
    const { sectionId, subjectId } = c.req.valid("param");
    const { term_id } = c.req.valid("query");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        getSectionOutcomeAchievements(tx, tenant.schoolId, sectionId, subjectId, term_id ?? null),
      ),
      200,
    );
  });

  routes.openapi(saveAchievementsRoute, async (c) => {
    const { sectionId, subjectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, async (tx) => {
        await saveSectionOutcomeAchievements(
          tx,
          tenant.schoolId,
          tenant.userId,
          sectionId,
          subjectId,
          body.term_id,
          body.achievements,
        );
        return getSectionOutcomeAchievements(
          tx,
          tenant.schoolId,
          sectionId,
          subjectId,
          body.term_id,
        );
      }),
      200,
    );
  });

  return routes;
}
