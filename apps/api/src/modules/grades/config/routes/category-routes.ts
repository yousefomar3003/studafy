import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../../../db/tenant-tx";
import { auditAction } from "../../../../middleware/auditEmitter";
import { requireAuth } from "../../../../middleware/authContext";
import { requirePermission } from "../../../../middleware/authz";
import { openApiValidationHook } from "../../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../../openapi/responses";
import {
  assertCanManageGradebook,
  createCategory,
  deleteCategory,
  getGradebookById,
  listCategories,
  updateCategory,
} from "../gradebook-config-service";
import {
  assessmentCategorySchema,
  categoryIdParamSchema,
  categoryListSchema,
  createCategoryBodySchema,
  gradebookIdParamSchema,
  updateCategoryBodySchema,
} from "../schemas";

import type { Database } from "../../../../db/client";
import type { AppEnv } from "../../../../middleware/requestId";
import type { AssessmentCategoryRow } from "../gradebook-config-service";
import type { AssessmentCategory } from "../schemas";
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

function toCategoryResponse(row: AssessmentCategoryRow): AssessmentCategory {
  return {
    id: row.id,
    gradebook_id: row.gradebook_id,
    name: row.name,
    weight: Number(row.weight),
    description: row.description,
    sort_order: row.sort_order,
    is_active: row.is_active,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listCategoriesRoute = createRoute({
  method: "get",
  path: "/api/grades/config/gradebooks/{gradebookId}/categories",
  tags: ["Gradebook Configuration"],
  operationId: "listAssessmentCategories",
  summary: "List assessment categories",
  description:
    "Returns all assessment categories for a gradebook, ordered by sort_order. " +
    "Includes the total weight sum of all active categories.",
  security: [{ bearerAuth: [] }],
  request: { params: gradebookIdParamSchema },
  responses: standardResponses(
    { 200: { description: "List of assessment categories.", schema: categoryListSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const createCategoryRoute = createRoute({
  method: "post",
  path: "/api/grades/config/gradebooks/{gradebookId}/categories",
  tags: ["Gradebook Configuration"],
  operationId: "createAssessmentCategory",
  summary: "Create an assessment category",
  description:
    "Creates a new weighted assessment category. After insertion, validates that all active " +
    "category weights sum to exactly 100%. Returns 400 (INVALID_GRADEBOOK_WEIGHT_TOTAL) if not.",
  security: [{ bearerAuth: [] }],
  request: {
    params: gradebookIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: createCategoryBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The created category.", schema: assessmentCategorySchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const updateCategoryRoute = createRoute({
  method: "patch",
  path: "/api/grades/config/gradebooks/{gradebookId}/categories/{categoryId}",
  tags: ["Gradebook Configuration"],
  operationId: "updateAssessmentCategory",
  summary: "Update an assessment category",
  description:
    "Partially updates an assessment category. After updating, validates that all active " +
    "category weights sum to exactly 100%. Returns 400 (INVALID_GRADEBOOK_WEIGHT_TOTAL) if not.",
  security: [{ bearerAuth: [] }],
  request: {
    params: gradebookIdParamSchema.merge(categoryIdParamSchema),
    body: {
      required: true,
      content: { "application/json": { schema: updateCategoryBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The updated category.", schema: assessmentCategorySchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteCategoryRoute = createRoute({
  method: "delete",
  path: "/api/grades/config/gradebooks/{gradebookId}/categories/{categoryId}",
  tags: ["Gradebook Configuration"],
  operationId: "deleteAssessmentCategory",
  summary: "Delete an assessment category",
  description:
    "Deletes an assessment category. After deletion, validates that remaining active " +
    "category weights sum to exactly 100%. Returns 400 (INVALID_GRADEBOOK_WEIGHT_TOTAL) if not.",
  security: [{ bearerAuth: [] }],
  request: { params: gradebookIdParamSchema.merge(categoryIdParamSchema) },
  responses: {
    204: { description: "Category deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [400, 401, 403, 404, 500]),
  },
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function categoryRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use(
    "/api/grades/config/gradebooks/{gradebookId}/categories",
    requirePermission(PERMISSIONS.GRADE_READ),
  );
  routes.use(
    "/api/grades/config/gradebooks/{gradebookId}/categories",
    auditAction("insert", "assessment_categories"),
  );
  routes.use(
    "/api/grades/config/gradebooks/{gradebookId}/categories/{categoryId}",
    requirePermission(PERMISSIONS.GRADE_READ),
  );
  routes.use(
    "/api/grades/config/gradebooks/{gradebookId}/categories/{categoryId}",
    auditAction("update", "assessment_categories"),
  );

  // --- List categories ---

  routes.openapi(listCategoriesRoute, async (c) => {
    const auth = requireAuth(c);
    const { gradebookId } = c.req.valid("param");

    const { categories, totalWeight } = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const gradebook = await getGradebookById(tx, auth.schoolId, gradebookId);
      await assertCanManageGradebook(tx, gradebook.class_id);
      return listCategories(tx, auth.schoolId, gradebookId);
    });

    return c.json(
      { categories: categories.map(toCategoryResponse), total_weight: totalWeight },
      200,
    );
  });

  // --- Create category ---

  routes.openapi(createCategoryRoute, async (c) => {
    const auth = requireAuth(c);
    const { gradebookId } = c.req.valid("param");
    const body = c.req.valid("json");

    const category = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const gradebook = await getGradebookById(tx, auth.schoolId, gradebookId);
      await assertCanManageGradebook(tx, gradebook.class_id);
      return createCategory(tx, auth.schoolId, gradebookId, body);
    });

    return c.json(toCategoryResponse(category), 201);
  });

  // --- Update category ---

  routes.openapi(updateCategoryRoute, async (c) => {
    const auth = requireAuth(c);
    const { gradebookId, categoryId } = c.req.valid("param");
    const body = c.req.valid("json");

    const category = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const gradebook = await getGradebookById(tx, auth.schoolId, gradebookId);
      await assertCanManageGradebook(tx, gradebook.class_id);
      return updateCategory(tx, auth.schoolId, gradebookId, categoryId, body);
    });

    return c.json(toCategoryResponse(category), 200);
  });

  // --- Delete category ---

  routes.openapi(deleteCategoryRoute, async (c) => {
    const auth = requireAuth(c);
    const { gradebookId, categoryId } = c.req.valid("param");

    await withTenantTx(database, tenantFrom(c), async (tx) => {
      const gradebook = await getGradebookById(tx, auth.schoolId, gradebookId);
      await assertCanManageGradebook(tx, gradebook.class_id);
      await deleteCategory(tx, auth.schoolId, gradebookId, categoryId);
    });

    return c.body(null, 204);
  });

  return routes;
}
