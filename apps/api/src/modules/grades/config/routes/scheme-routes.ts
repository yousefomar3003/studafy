import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";
import { uuidSchema } from "@studafy/shared-schemas";

import { withTenantTx } from "../../../../db/tenant-tx";
import { auditAction } from "../../../../middleware/auditEmitter";
import { requireAuth } from "../../../../middleware/authContext";
import { requirePermission } from "../../../../middleware/authz";
import { openApiValidationHook } from "../../../../openapi/hook";
import { standardResponses } from "../../../../openapi/responses";
import {
  assertCanManageGradebook,
  createScheme,
  getGradebookConfig,
  getGradebookById,
  getScheme,
  linkScheme,
  listSchemes,
} from "../gradebook-config-service";
import {
  createSchemeBodySchema,
  gradebookConfigSchema,
  gradebookIdParamSchema,
  gradingSchemeSchema,
  schemeIdParamSchema,
  schemeListSchema,
  termIdQuerySchema,
} from "../schemas";

import type { Database } from "../../../../db/client";
import type { AppEnv } from "../../../../middleware/requestId";
import type { GradingSchemeRow, AssessmentCategoryRow } from "../gradebook-config-service";
import type { GradingScheme, GradebookConfig } from "../schemas";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tenantFrom(c: Context<AppEnv>): {
  schoolId: string;
  userId: string;
  requestId?: string;
} {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function toSchemeResponse(row: GradingSchemeRow): GradingScheme {
  return {
    id: row.id,
    term_id: row.term_id,
    version: row.version,
    name: row.name,
    scheme_type: row.scheme_type as GradingScheme["scheme_type"],
    grade_boundaries: row.grade_boundaries as GradingScheme["grade_boundaries"],
    is_inherited: row.is_inherited,
    created_at: row.created_at.toISOString(),
  };
}

function toConfigResponse(
  gradebookId: string,
  categories: AssessmentCategoryRow[],
  totalWeight: number,
  scheme: GradingSchemeRow | null,
): GradebookConfig {
  return {
    gradebook_id: gradebookId,
    categories: categories.map((c) => ({
      id: c.id,
      gradebook_id: c.gradebook_id,
      name: c.name,
      weight: Number(c.weight),
      description: c.description,
      sort_order: c.sort_order,
      is_active: c.is_active,
      created_at: c.created_at.toISOString(),
      updated_at: c.updated_at.toISOString(),
    })),
    total_weight: totalWeight,
    grading_scheme: scheme ? toSchemeResponse(scheme) : null,
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getGradebookConfigRoute = createRoute({
  method: "get",
  path: "/api/grades/config/gradebooks/{gradebookId}/scheme",
  tags: ["Gradebook Configuration"],
  operationId: "getGradebookConfig",
  summary: "Get gradebook configuration",
  description:
    "Returns the full gradebook configuration: assessment categories (with total weight) " +
    "and the linked grading scheme. If no scheme is linked yet, one is auto-inherited from " +
    "the school's default grading settings.",
  security: [{ bearerAuth: [] }],
  request: { params: gradebookIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Full gradebook configuration.", schema: gradebookConfigSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const linkSchemeRoute = createRoute({
  method: "post",
  path: "/api/grades/config/gradebooks/{gradebookId}/scheme/link",
  tags: ["Gradebook Configuration"],
  operationId: "linkGradingScheme",
  summary: "Link a grading scheme to a gradebook",
  description:
    "Associates a specific grading scheme version with a gradebook. " +
    "The scheme must belong to the same academic term as the gradebook's class.",
  security: [{ bearerAuth: [] }],
  request: {
    params: gradebookIdParamSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ scheme_id: uuidSchema }).openapi("LinkSchemeBody"),
        },
      },
    },
  },
  responses: standardResponses(
    { 200: { description: "Scheme linked successfully.", schema: gradingSchemeSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const listSchemesRoute = createRoute({
  method: "get",
  path: "/api/grades/config/schemes",
  tags: ["Gradebook Configuration"],
  operationId: "listGradingSchemes",
  summary: "List grading schemes",
  description:
    "Lists all versions of grading schemes for a given term, ordered by version descending. " +
    "The highest version number is the current scheme.",
  security: [{ bearerAuth: [] }],
  request: { query: termIdQuerySchema },
  responses: standardResponses(
    { 200: { description: "List of grading schemes.", schema: schemeListSchema } },
    [400, 401, 403, 500],
  ),
});

const createSchemeRoute = createRoute({
  method: "post",
  path: "/api/grades/config/schemes",
  tags: ["Gradebook Configuration"],
  operationId: "createGradingScheme",
  summary: "Create a grading scheme",
  description:
    "Creates a new versioned grading scheme for an academic term. " +
    "Each modification creates a new version; prior versions are immutable. " +
    "Returns 400 if the grade boundaries are invalid.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createSchemeBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The created grading scheme.", schema: gradingSchemeSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const getSchemeRoute = createRoute({
  method: "get",
  path: "/api/grades/config/schemes/{schemeId}",
  tags: ["Gradebook Configuration"],
  operationId: "getGradingScheme",
  summary: "Get a grading scheme",
  description: "Returns a specific grading scheme by ID. Answers 404 if not found.",
  security: [{ bearerAuth: [] }],
  request: { params: schemeIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The grading scheme.", schema: gradingSchemeSchema } },
    [401, 403, 404, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function schemeRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Permission gates
  routes.use(
    "/api/grades/config/gradebooks/:gradebookId/scheme",
    requirePermission(PERMISSIONS.GRADE_READ),
  );
  routes.use(
    "/api/grades/config/gradebooks/:gradebookId/scheme/link",
    requirePermission(PERMISSIONS.GRADE_UPDATE),
  );
  routes.use("/api/grades/config/schemes", requirePermission(PERMISSIONS.GRADE_READ));
  routes.use("/api/grades/config/schemes/:schemeId", requirePermission(PERMISSIONS.GRADE_READ));

  // Audit declarations
  routes.use(
    "/api/grades/config/gradebooks/:gradebookId/scheme/link",
    auditAction("update", "gradebooks"),
  );
  routes.use("/api/grades/config/schemes", auditAction("insert", "grading_schemes"));

  // --- Get gradebook config (includes auto-inherit of scheme) ---

  routes.openapi(getGradebookConfigRoute, async (c) => {
    const auth = requireAuth(c);
    const { gradebookId } = c.req.valid("param");

    const config = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const gradebook = await getGradebookById(tx, auth.schoolId, gradebookId);
      await assertCanManageGradebook(tx, gradebook.class_id);
      return getGradebookConfig(tx, auth.schoolId, gradebookId, auth.userId);
    });

    return c.json(
      toConfigResponse(
        config.gradebook_id,
        config.categories,
        config.total_weight,
        config.grading_scheme,
      ),
      200,
    );
  });

  // --- Link scheme to gradebook ---

  routes.openapi(linkSchemeRoute, async (c) => {
    const auth = requireAuth(c);
    const { gradebookId } = c.req.valid("param");
    const { scheme_id } = c.req.valid("json");

    const scheme = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const gradebook = await getGradebookById(tx, auth.schoolId, gradebookId);
      await assertCanManageGradebook(tx, gradebook.class_id);
      await linkScheme(tx, auth.schoolId, gradebookId, scheme_id);
      return getScheme(tx, auth.schoolId, scheme_id);
    });

    return c.json(toSchemeResponse(scheme), 200);
  });

  // --- List schemes ---

  routes.openapi(listSchemesRoute, async (c) => {
    const auth = requireAuth(c);
    const { termId } = c.req.valid("query");

    const schemes = await withTenantTx(database, tenantFrom(c), async (tx) =>
      listSchemes(tx, auth.schoolId, termId),
    );

    return c.json({ schemes: schemes.map(toSchemeResponse) }, 200);
  });

  // --- Create scheme ---

  routes.openapi(createSchemeRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");

    const scheme = await withTenantTx(database, tenantFrom(c), async (tx) =>
      createScheme(tx, auth.schoolId, auth.userId, body),
    );

    return c.json(toSchemeResponse(scheme), 201);
  });

  // --- Get scheme ---

  routes.openapi(getSchemeRoute, async (c) => {
    const auth = requireAuth(c);
    const { schemeId } = c.req.valid("param");

    const scheme = await withTenantTx(database, tenantFrom(c), async (tx) =>
      getScheme(tx, auth.schoolId, schemeId),
    );

    return c.json(toSchemeResponse(scheme), 200);
  });

  return routes;
}
