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
  createEquivalencyRuleSet,
  deleteEquivalencyRuleSet,
  equivalencyStudentList,
  listEquivalencyRuleSets,
  studentEquivalency,
  updateEquivalencyRuleSet,
} from "./equivalency-service";
import {
  createMultiYearConfig,
  deleteMultiYearConfig,
  listMultiYearConfigs,
  studentMultiYearResults,
  updateMultiYearConfig,
} from "./multi-year-service";
import {
  academicEquivalencyStudentParamSchema,
  equivalencyRuleSetBodySchema,
  equivalencyRuleSetListSchema,
  equivalencyRuleSetSchema,
  equivalencySetIdParamSchema,
  equivalencyStudentListSchema,
  equivalencyStudentsQuerySchema,
  multiYearConfigBodySchema,
  multiYearConfigIdParamSchema,
  multiYearConfigListSchema,
  multiYearConfigSchema,
  studentEquivalencySchema,
  studentMultiYearResultsSchema,
} from "./schemas";

import type { Database } from "../../db/client";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

/**
 * Tawjihi equivalency and multi-year results (000267). School leadership (academicConfig:manage)
 * manages the rule sets and configurations and lists a grade level's estimates; teaching staff
 * (academicConfig:read) read them; anyone with grade:read reads a student's estimate or multi-year
 * result when they may read the student (leadership, the student's teachers, the student, linked
 * parents) -- the student and their parents only for what is shown to them. Row checks are in the
 * services. Every equivalency figure is an estimate under the school's own rules, which the school
 * confirms: never an official Ministry conversion.
 */

const EQUIVALENCY_TAGS = ["Tawjihi equivalency"];
const MULTI_YEAR_TAGS = ["Multi-year results"];
const security = [{ bearerAuth: [] }];
const json = <T>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

const listSetsRoute = createRoute({
  method: "get",
  path: "/api/grading/equivalency-rule-sets",
  tags: EQUIVALENCY_TAGS,
  operationId: "listEquivalencyRuleSets",
  summary: "The school's Tawjihi equivalency rule sets",
  description:
    "Every set, active or not, by name, with its grade levels and weighted parts. The rules are " +
    "the school's own editable estimates, not official Ministry conversions.",
  security,
  responses: standardResponses(
    { 200: { description: "Rule sets.", schema: equivalencyRuleSetListSchema } },
    [401, 403, 500],
  ),
});

const createSetRoute = createRoute({
  method: "post",
  path: "/api/grading/equivalency-rule-sets",
  tags: EQUIVALENCY_TAGS,
  operationId: "createEquivalencyRuleSet",
  summary: "Add a Tawjihi equivalency rule set",
  description:
    "The parts are checked by the grading engine (what each type needs). 409 " +
    "CONFLICT_DUPLICATE_ENTRY when the name is already used in the school.",
  security,
  request: { body: json(equivalencyRuleSetBodySchema) },
  responses: standardResponses(
    { 201: { description: "The new rule set.", schema: equivalencyRuleSetSchema } },
    [400, 401, 403, 409, 500],
  ),
});

const updateSetRoute = createRoute({
  method: "put",
  path: "/api/grading/equivalency-rule-sets/{setId}",
  tags: EQUIVALENCY_TAGS,
  operationId: "updateEquivalencyRuleSet",
  summary: "Replace a Tawjihi equivalency rule set",
  description: "The set's grade levels and parts are replaced with the request's.",
  security,
  request: { params: equivalencySetIdParamSchema, body: json(equivalencyRuleSetBodySchema) },
  responses: standardResponses(
    { 200: { description: "The rule set.", schema: equivalencyRuleSetSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteSetRoute = createRoute({
  method: "delete",
  path: "/api/grading/equivalency-rule-sets/{setId}",
  tags: EQUIVALENCY_TAGS,
  operationId: "deleteEquivalencyRuleSet",
  summary: "Delete a Tawjihi equivalency rule set",
  description: "Nothing is stored per student, so no estimate outlives its set.",
  security,
  request: { params: equivalencySetIdParamSchema },
  responses: {
    204: { description: "Deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 500]),
  },
});

const setStudentsRoute = createRoute({
  method: "get",
  path: "/api/grading/equivalency-rule-sets/{setId}/students",
  tags: EQUIVALENCY_TAGS,
  operationId: "listEquivalencyStudents",
  summary: "A grade level's estimates under a rule set",
  description:
    "Every student placed in the grade level in the academic year, estimated under the set (by " +
    "name), with each part and the missing-data reasons. Estimates the school confirms.",
  security,
  request: { params: equivalencySetIdParamSchema, query: equivalencyStudentsQuerySchema },
  responses: standardResponses(
    { 200: { description: "The estimates.", schema: equivalencyStudentListSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const studentEquivalencyRoute = createRoute({
  method: "get",
  path: "/api/grading/students/{studentId}/equivalency",
  tags: EQUIVALENCY_TAGS,
  operationId: "getStudentEquivalency",
  summary: "A student's estimated Tawjihi-equivalent percentage",
  description:
    "The estimate under every active rule set for the student's grade level, with a step-by-step " +
    "breakdown and missing-data reasons. An estimate the school confirms, not an official " +
    "conversion. School leadership, the student's teachers, the student, or a linked parent; the " +
    "student and parents see only the sets shown to them.",
  security,
  request: { params: academicEquivalencyStudentParamSchema },
  responses: standardResponses(
    { 200: { description: "The estimates.", schema: studentEquivalencySchema } },
    [401, 403, 404, 500],
  ),
});

const listConfigsRoute = createRoute({
  method: "get",
  path: "/api/grading/multi-year-result-configs",
  tags: MULTI_YEAR_TAGS,
  operationId: "listMultiYearResultConfigs",
  summary: "The school's multi-year results",
  description: "Every configuration, active or not, by name, with its weighted grade levels.",
  security,
  responses: standardResponses(
    { 200: { description: "Configurations.", schema: multiYearConfigListSchema } },
    [401, 403, 500],
  ),
});

const createConfigRoute = createRoute({
  method: "post",
  path: "/api/grading/multi-year-result-configs",
  tags: MULTI_YEAR_TAGS,
  operationId: "createMultiYearResultConfig",
  summary: "Add a multi-year result",
  description:
    "2-6 distinct grade levels with relative weights. 409 CONFLICT_DUPLICATE_ENTRY when the name " +
    "is already used in the school.",
  security,
  request: { body: json(multiYearConfigBodySchema) },
  responses: standardResponses(
    { 201: { description: "The new configuration.", schema: multiYearConfigSchema } },
    [400, 401, 403, 409, 500],
  ),
});

const updateConfigRoute = createRoute({
  method: "put",
  path: "/api/grading/multi-year-result-configs/{configId}",
  tags: MULTI_YEAR_TAGS,
  operationId: "updateMultiYearResultConfig",
  summary: "Replace a multi-year result",
  description: "The configuration's grade levels and weights are replaced with the request's.",
  security,
  request: { params: multiYearConfigIdParamSchema, body: json(multiYearConfigBodySchema) },
  responses: standardResponses(
    { 200: { description: "The configuration.", schema: multiYearConfigSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteConfigRoute = createRoute({
  method: "delete",
  path: "/api/grading/multi-year-result-configs/{configId}",
  tags: MULTI_YEAR_TAGS,
  operationId: "deleteMultiYearResultConfig",
  summary: "Delete a multi-year result",
  description: "Nothing is stored per student.",
  security,
  request: { params: multiYearConfigIdParamSchema },
  responses: {
    204: { description: "Deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 500]),
  },
});

const studentMultiYearRoute = createRoute({
  method: "get",
  path: "/api/grading/students/{studentId}/multi-year-results",
  tags: MULTI_YEAR_TAGS,
  operationId: "getStudentMultiYearResults",
  summary: "A student's multi-year results",
  description:
    "The weighted result, per subject and overall, under every active configuration listing the " +
    "student's grade level, from each year's current finalized annual result; pending while a " +
    "year is not finalized. School leadership, the student's teachers, the student, or a linked " +
    "parent; the student and parents see only the configurations shown to them.",
  security,
  request: { params: academicEquivalencyStudentParamSchema },
  responses: standardResponses(
    { 200: { description: "The results.", schema: studentMultiYearResultsSchema } },
    [401, 403, 404, 500],
  ),
});

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

export function academicEquivalencyRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  const readConfig = requirePermission(PERMISSIONS.ACADEMIC_CONFIG_READ);
  const manage = requirePermission(PERMISSIONS.ACADEMIC_CONFIG_MANAGE);
  const readGrades = requirePermission(PERMISSIONS.GRADE_READ);

  routes.use(
    "/api/grading/equivalency-rule-sets",
    onlyMethods(["GET"], readConfig),
    onlyMethods(["POST"], manage),
    auditAction("insert", "equivalency_rule_sets"),
  );
  routes.on(
    "PUT",
    "/api/grading/equivalency-rule-sets/:setId",
    manage,
    auditAction("update", "equivalency_rule_sets"),
  );
  routes.on(
    "DELETE",
    "/api/grading/equivalency-rule-sets/:setId",
    manage,
    auditAction("delete", "equivalency_rule_sets"),
  );
  routes.use("/api/grading/equivalency-rule-sets/:setId/students", manage);
  routes.use("/api/grading/students/:studentId/equivalency", readGrades);

  routes.use(
    "/api/grading/multi-year-result-configs",
    onlyMethods(["GET"], readConfig),
    onlyMethods(["POST"], manage),
    auditAction("insert", "multi_year_result_configs"),
  );
  routes.on(
    "PUT",
    "/api/grading/multi-year-result-configs/:configId",
    manage,
    auditAction("update", "multi_year_result_configs"),
  );
  routes.on(
    "DELETE",
    "/api/grading/multi-year-result-configs/:configId",
    manage,
    auditAction("delete", "multi_year_result_configs"),
  );
  routes.use("/api/grading/students/:studentId/multi-year-results", readGrades);

  routes.openapi(listSetsRoute, async (c) => {
    const tenant = tenantFrom(c);
    const sets = await withTenantTx(database, tenant, (tx) =>
      listEquivalencyRuleSets(tx, tenant.schoolId),
    );
    return c.json({ sets }, 200);
  });

  routes.openapi(createSetRoute, async (c) => {
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        createEquivalencyRuleSet(tx, tenant.schoolId, body),
      ),
      201,
    );
  });

  routes.openapi(updateSetRoute, async (c) => {
    const { setId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        updateEquivalencyRuleSet(tx, tenant.schoolId, setId, body),
      ),
      200,
    );
  });

  routes.openapi(deleteSetRoute, async (c) => {
    const { setId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    await withTenantTx(database, tenant, (tx) =>
      deleteEquivalencyRuleSet(tx, tenant.schoolId, setId),
    );
    return c.body(null, 204);
  });

  routes.openapi(setStudentsRoute, async (c) => {
    const { setId } = c.req.valid("param");
    const { academic_year_id, grade_level_id } = c.req.valid("query");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        equivalencyStudentList(tx, tenant.schoolId, setId, academic_year_id, grade_level_id),
      ),
      200,
    );
  });

  routes.openapi(studentEquivalencyRoute, async (c) => {
    const { studentId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        studentEquivalency(tx, tenant.schoolId, studentId),
      ),
      200,
    );
  });

  routes.openapi(listConfigsRoute, async (c) => {
    const tenant = tenantFrom(c);
    const configs = await withTenantTx(database, tenant, (tx) =>
      listMultiYearConfigs(tx, tenant.schoolId),
    );
    return c.json({ configs }, 200);
  });

  routes.openapi(createConfigRoute, async (c) => {
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        createMultiYearConfig(tx, tenant.schoolId, body),
      ),
      201,
    );
  });

  routes.openapi(updateConfigRoute, async (c) => {
    const { configId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        updateMultiYearConfig(tx, tenant.schoolId, configId, body),
      ),
      200,
    );
  });

  routes.openapi(deleteConfigRoute, async (c) => {
    const { configId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    await withTenantTx(database, tenant, (tx) =>
      deleteMultiYearConfig(tx, tenant.schoolId, configId),
    );
    return c.body(null, 204);
  });

  routes.openapi(studentMultiYearRoute, async (c) => {
    const { studentId } = c.req.valid("param");
    const tenant = tenantFrom(c);
    return c.json(
      await withTenantTx(database, tenant, (tx) =>
        studentMultiYearResults(tx, tenant.schoolId, studentId),
      ),
      200,
    );
  });

  return routes;
}
