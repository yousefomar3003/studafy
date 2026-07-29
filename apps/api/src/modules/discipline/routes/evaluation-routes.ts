import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission, requirePermissionIn } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import {
  evaluationListSchema,
  evaluationSchema,
  evaluationWithScoresSchema,
  evaluationCriteriaTemplateSchema,
  evaluationScoreSchema,
  evaluationTemplateListSchema,
  evaluationScoreListSchema,
  createEvaluationBodySchema,
  updateEvaluationBodySchema,
  createCriteriaTemplateBodySchema,
  updateCriteriaTemplateBodySchema,
  upsertScoreBodySchema,
  evaluationQuerySchema,
  evaluationTemplateQuerySchema,
  evaluationIdParamSchema,
  templateIdParamSchema,
  scoreParamSchema,
} from "../evaluation-schemas";
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  listEvaluations,
  getEvaluation,
  createEvaluation,
  updateEvaluation,
  submitEvaluation,
  shareEvaluationWithTeacher,
  getEvaluationScores,
  upsertScore,
  deleteScore,
} from "../evaluation-service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";

function tenantFrom(c: Context<AppEnv>): {
  schoolId: string;
  userId: string;
  requestId?: string;
} {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

// ---------------------------------------------------------------------------
// Route configs
// ---------------------------------------------------------------------------

const listTemplatesRoute = createRoute({
  method: "get",
  path: "/api/evaluations/templates",
  tags: ["Evaluations"],
  operationId: "listEvaluationTemplates",
  summary: "List criteria templates",
  description: "Paginated list of evaluation criteria templates.",
  security: [{ bearerAuth: [] }],
  request: { query: evaluationTemplateQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of criteria templates.",
        schema: evaluationTemplateListSchema,
      },
    },
    [401, 403, 500],
  ),
});

const createTemplateRoute = createRoute({
  method: "post",
  path: "/api/evaluations/templates",
  tags: ["Evaluations"],
  operationId: "createEvaluationTemplate",
  summary: "Create a criteria template",
  description: "Creates a new evaluation criteria template. Principal-only.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createCriteriaTemplateBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "The created criteria template.",
        schema: evaluationCriteriaTemplateSchema,
      },
    },
    [400, 401, 403, 500],
  ),
});

const getTemplateRoute = createRoute({
  method: "get",
  path: "/api/evaluations/templates/{templateId}",
  tags: ["Evaluations"],
  operationId: "getEvaluationTemplate",
  summary: "Get a criteria template",
  description: "Returns a single evaluation criteria template by ID.",
  security: [{ bearerAuth: [] }],
  request: { params: templateIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The criteria template.",
        schema: evaluationCriteriaTemplateSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const updateTemplateRoute = createRoute({
  method: "patch",
  path: "/api/evaluations/templates/{templateId}",
  tags: ["Evaluations"],
  operationId: "updateEvaluationTemplate",
  summary: "Update a criteria template",
  description: "Updates an evaluation criteria template. Principal-only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: templateIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateCriteriaTemplateBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The updated criteria template.",
        schema: evaluationCriteriaTemplateSchema,
      },
    },
    [400, 401, 403, 404, 500],
  ),
});

const deleteTemplateRoute = createRoute({
  method: "delete",
  path: "/api/evaluations/templates/{templateId}",
  tags: ["Evaluations"],
  operationId: "deleteEvaluationTemplate",
  summary: "Deactivate a criteria template",
  description: "Soft-deletes (deactivates) a criteria template. Principal-only.",
  security: [{ bearerAuth: [] }],
  request: { params: templateIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "Template deactivated.",
        schema: z.null().openapi("EmptyResponse"),
      },
    },
    [401, 403, 404, 500],
  ),
});

const listEvaluationsRoute = createRoute({
  method: "get",
  path: "/api/evaluations",
  tags: ["Evaluations"],
  operationId: "listEvaluations",
  summary: "List teacher evaluations",
  description:
    "Paginated list of teacher evaluations. Principals see all; " +
    "teachers see only evaluations shared with them.",
  security: [{ bearerAuth: [] }],
  request: { query: evaluationQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of evaluations.",
        schema: evaluationListSchema,
      },
    },
    [401, 403, 500],
  ),
});

const createEvaluationRoute = createRoute({
  method: "post",
  path: "/api/evaluations",
  tags: ["Evaluations"],
  operationId: "createEvaluation",
  summary: "Create a teacher evaluation",
  description: "Creates a new teacher evaluation in draft status. Principal-only.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createEvaluationBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "The created evaluation.",
        schema: evaluationSchema,
      },
    },
    [400, 401, 403, 404, 500],
  ),
});

const getEvaluationRoute = createRoute({
  method: "get",
  path: "/api/evaluations/{evaluationId}",
  tags: ["Evaluations"],
  operationId: "getEvaluation",
  summary: "Get a teacher evaluation",
  description:
    "Returns a single teacher evaluation by ID. " +
    "Teachers can only see evaluations shared with them.",
  security: [{ bearerAuth: [] }],
  request: { params: evaluationIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The teacher evaluation with scores.",
        schema: evaluationWithScoresSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const updateEvaluationRoute = createRoute({
  method: "patch",
  path: "/api/evaluations/{evaluationId}",
  tags: ["Evaluations"],
  operationId: "updateEvaluation",
  summary: "Update a teacher evaluation",
  description: "Updates evaluation fields. Principal-only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: evaluationIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateEvaluationBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The updated evaluation.",
        schema: evaluationSchema,
      },
    },
    [400, 401, 403, 404, 500],
  ),
});

const submitEvaluationRoute = createRoute({
  method: "post",
  path: "/api/evaluations/{evaluationId}/submit",
  tags: ["Evaluations"],
  operationId: "submitEvaluation",
  summary: "Submit a teacher evaluation",
  description: "Transitions evaluation from draft to submitted. Principal-only.",
  security: [{ bearerAuth: [] }],
  request: { params: evaluationIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The submitted evaluation.",
        schema: evaluationSchema,
      },
    },
    [401, 403, 404, 409, 500],
  ),
});

const shareEvaluationRoute = createRoute({
  method: "post",
  path: "/api/evaluations/{evaluationId}/share",
  tags: ["Evaluations"],
  operationId: "shareEvaluation",
  summary: "Share evaluation with teacher",
  description:
    "Marks the evaluation as shared so the teacher can view it. " +
    "Idempotent: returns 409 if already shared. Principal-only.",
  security: [{ bearerAuth: [] }],
  request: { params: evaluationIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The shared evaluation.",
        schema: evaluationSchema,
      },
    },
    [401, 403, 404, 409, 500],
  ),
});

const listScoresRoute = createRoute({
  method: "get",
  path: "/api/evaluations/{evaluationId}/scores",
  tags: ["Evaluations"],
  operationId: "listEvaluationScores",
  summary: "List evaluation scores",
  description:
    "Returns all criteria scores for an evaluation. " +
    "Teachers can only see scores for evaluations shared with them.",
  security: [{ bearerAuth: [] }],
  request: { params: evaluationIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The evaluation scores.",
        schema: evaluationScoreListSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const upsertScoreRoute = createRoute({
  method: "put",
  path: "/api/evaluations/{evaluationId}/scores/{criteriaTemplateId}",
  tags: ["Evaluations"],
  operationId: "upsertEvaluationScore",
  summary: "Create or update a score",
  description: "Upserts a score for a criteria template on an evaluation. " + "Principal-only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: scoreParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: upsertScoreBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The created or updated score.",
        schema: evaluationScoreSchema,
      },
    },
    [400, 401, 403, 404, 500],
  ),
});

const deleteScoreRoute = createRoute({
  method: "delete",
  path: "/api/evaluations/{evaluationId}/scores/{criteriaTemplateId}",
  tags: ["Evaluations"],
  operationId: "deleteEvaluationScore",
  summary: "Delete a score",
  description: "Deletes a score entry from an evaluation. Principal-only.",
  security: [{ bearerAuth: [] }],
  request: { params: scoreParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "Score deleted.",
        schema: z.null().openapi("EmptyResponse"),
      },
    },
    [401, 403, 404, 500],
  ),
});

// ---------------------------------------------------------------------------
// Routes factory
// ---------------------------------------------------------------------------

export function evaluationRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Audit middleware
  routes.use("/api/evaluations/templates", auditAction("insert", "evaluation_criteria_templates"));
  routes.use(
    "/api/evaluations/templates/{templateId}",
    auditAction("update", "evaluation_criteria_templates"),
  );
  routes.use("/api/evaluations", auditAction("insert", "teacher_evaluations"));
  routes.use("/api/evaluations/{evaluationId}", auditAction("update", "teacher_evaluations"));
  routes.use(
    "/api/evaluations/{evaluationId}/submit",
    auditAction("update", "teacher_evaluations"),
  );
  routes.use("/api/evaluations/{evaluationId}/share", auditAction("update", "teacher_evaluations"));
  routes.use(
    "/api/evaluations/{evaluationId}/scores/{criteriaTemplateId}",
    auditAction("insert", "evaluation_scores"),
  );

  // Template read — any authenticated user with READ perm
  routes.use("/api/evaluations/templates", requirePermission(PERMISSIONS.EVALUATION_TEMPLATE_READ));
  routes.use(
    "/api/evaluations/templates/{templateId}",
    requirePermission(PERMISSIONS.EVALUATION_TEMPLATE_READ),
  );

  // Evaluation read — principal and teacher (with different visibility)
  routes.use("/api/evaluations", requirePermission(PERMISSIONS.EVALUATION_READ));
  routes.use("/api/evaluations/{evaluationId}", requirePermission(PERMISSIONS.EVALUATION_READ));
  routes.use(
    "/api/evaluations/{evaluationId}/scores",
    requirePermission(PERMISSIONS.EVALUATION_SCORE_READ),
  );

  // -- Templates --

  routes.openapi(listTemplatesRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listTemplates(tx, auth.schoolId, query),
    );

    return c.json({ templates: rows, total }, 200);
  });

  routes.openapi(createTemplateRoute, async (c) => {
    const auth = requireAuth(c);
    requirePermissionIn(c, PERMISSIONS.EVALUATION_TEMPLATE_CREATE);
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      createTemplate(tx, auth.schoolId, body),
    );

    return c.json(row, 201);
  });

  routes.openapi(getTemplateRoute, async (c) => {
    const auth = requireAuth(c);
    const { templateId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getTemplate(tx, auth.schoolId, templateId),
    );

    if (!row) {
      throw new HTTPException(404, { message: "Evaluation criteria template not found" });
    }

    return c.json(row, 200);
  });

  routes.openapi(updateTemplateRoute, async (c) => {
    const auth = requireAuth(c);
    requirePermissionIn(c, PERMISSIONS.EVALUATION_TEMPLATE_UPDATE);
    const { templateId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateTemplate(tx, auth.schoolId, templateId, body),
    );

    return c.json(row, 200);
  });

  routes.openapi(deleteTemplateRoute, async (c) => {
    const auth = requireAuth(c);
    requirePermissionIn(c, PERMISSIONS.EVALUATION_TEMPLATE_DELETE);
    const { templateId } = c.req.valid("param");

    await withTenantTx(database, tenantFrom(c), (tx) =>
      deleteTemplate(tx, auth.schoolId, templateId),
    );

    return c.json(null, 200);
  });

  // -- Evaluations --

  routes.openapi(listEvaluationsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");
    const isTeacher = auth.roles.includes("INSTRUCTOR");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listEvaluations(tx, auth.schoolId, auth.userId, isTeacher, query),
    );

    return c.json({ evaluations: rows, total }, 200);
  });

  routes.openapi(createEvaluationRoute, async (c) => {
    const auth = requireAuth(c);
    requirePermissionIn(c, PERMISSIONS.EVALUATION_CREATE);
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      createEvaluation(tx, auth.schoolId, auth.userId, body),
    );

    return c.json(row, 201);
  });

  routes.openapi(getEvaluationRoute, async (c) => {
    const auth = requireAuth(c);
    const { evaluationId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getEvaluation(tx, auth.schoolId, evaluationId),
    );

    if (!row) {
      throw new HTTPException(404, { message: "Teacher evaluation not found" });
    }

    return c.json(row, 200);
  });

  routes.openapi(updateEvaluationRoute, async (c) => {
    const auth = requireAuth(c);
    requirePermissionIn(c, PERMISSIONS.EVALUATION_UPDATE);
    const { evaluationId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateEvaluation(tx, auth.schoolId, evaluationId, body),
    );

    return c.json(row, 200);
  });

  routes.openapi(submitEvaluationRoute, async (c) => {
    const auth = requireAuth(c);
    requirePermissionIn(c, PERMISSIONS.EVALUATION_SUBMIT);
    const { evaluationId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      submitEvaluation(tx, auth.schoolId, evaluationId),
    );

    return c.json(row, 200);
  });

  routes.openapi(shareEvaluationRoute, async (c) => {
    const auth = requireAuth(c);
    requirePermissionIn(c, PERMISSIONS.EVALUATION_SHARE);
    const { evaluationId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      shareEvaluationWithTeacher(tx, auth.schoolId, evaluationId),
    );

    return c.json(row, 200);
  });

  // -- Scores --

  routes.openapi(listScoresRoute, async (c) => {
    const auth = requireAuth(c);
    const { evaluationId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getEvaluation(tx, auth.schoolId, evaluationId),
    );

    if (!row) {
      throw new HTTPException(404, { message: "Teacher evaluation not found" });
    }

    const scores = await withTenantTx(database, tenantFrom(c), (tx) =>
      getEvaluationScores(tx, auth.schoolId, evaluationId),
    );

    return c.json({ scores }, 200);
  });

  routes.openapi(upsertScoreRoute, async (c) => {
    const auth = requireAuth(c);
    requirePermissionIn(c, PERMISSIONS.EVALUATION_SCORE_CREATE);
    const { evaluationId, criteriaTemplateId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      upsertScore(tx, auth.schoolId, evaluationId, criteriaTemplateId, body),
    );

    return c.json(row, 200);
  });

  routes.openapi(deleteScoreRoute, async (c) => {
    const auth = requireAuth(c);
    requirePermissionIn(c, PERMISSIONS.EVALUATION_SCORE_DELETE);
    const { evaluationId, criteriaTemplateId } = c.req.valid("param");

    await withTenantTx(database, tenantFrom(c), (tx) =>
      deleteScore(tx, auth.schoolId, evaluationId, criteriaTemplateId),
    );

    return c.json(null, 200);
  });

  return routes;
}
