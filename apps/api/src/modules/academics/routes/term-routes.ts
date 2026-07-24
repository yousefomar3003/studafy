import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";
import {
  createTermBodySchema,
  termIdParamSchema,
  termListSchema,
  termQuerySchema,
  termSchema,
  updateTermBodySchema,
  yearIdParamSchema,
} from "../schemas";
import { createTerm, deleteTerm, getTerm, listTerms, updateTerm } from "../term-service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listTermsRoute = createRoute({
  method: "get",
  path: "/api/academics/years/{yearId}/terms",
  tags: ["Academics"],
  operationId: "listTerms",
  summary: "List terms for an academic year",
  description: "Paginated list of terms belonging to the specified academic year.",
  security: [{ bearerAuth: [] }],
  request: {
    params: yearIdParamSchema,
    query: termQuerySchema,
  },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of terms.",
        schema: termListSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const createTermRoute = createRoute({
  method: "post",
  path: "/api/academics/years/{yearId}/terms",
  tags: ["Academics"],
  operationId: "createTerm",
  summary: "Create a term",
  description: "Creates a new term within the specified academic year.",
  security: [{ bearerAuth: [] }],
  request: {
    params: yearIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: createTermBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "The created term.",
        schema: termSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const getTermRoute = createRoute({
  method: "get",
  path: "/api/academics/terms/{termId}",
  tags: ["Academics"],
  operationId: "getTerm",
  summary: "Get a term",
  description: "Returns a single term by ID.",
  security: [{ bearerAuth: [] }],
  request: { params: termIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The term.",
        schema: termSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const updateTermRoute = createRoute({
  method: "patch",
  path: "/api/academics/terms/{termId}",
  tags: ["Academics"],
  operationId: "updateTerm",
  summary: "Update a term",
  description: "Partially updates a term.",
  security: [{ bearerAuth: [] }],
  request: {
    params: termIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateTermBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The updated term.",
        schema: termSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteTermRoute = createRoute({
  method: "delete",
  path: "/api/academics/terms/{termId}",
  tags: ["Academics"],
  operationId: "deleteTerm",
  summary: "Delete a term",
  description:
    "Deletes a term. Only terms in 'planned' status with no dependent classes can be deleted.",
  security: [{ bearerAuth: [] }],
  request: { params: termIdParamSchema },
  responses: {
    204: { description: "Term deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 409, 500]),
  },
});

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

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function termRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Audit declarations
  routes.use("/api/academics/years/{yearId}/terms", auditAction("insert", "terms"));
  routes.use("/api/academics/terms/{termId}", auditAction("update", "terms"));

  routes.openapi(listTermsRoute, async (c) => {
    const auth = requireAuth(c);
    const { yearId } = c.req.valid("param");
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listTerms(tx, auth.schoolId, yearId, query),
    );

    return c.json({ terms: rows, total }, 200);
  });

  routes.openapi(createTermRoute, async (c) => {
    const auth = requireAuth(c);
    const { yearId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      createTerm(tx, auth.schoolId, { ...body, academic_year_id: yearId }),
    );

    return c.json(row, 201);
  });

  routes.openapi(getTermRoute, async (c) => {
    const auth = requireAuth(c);
    const { termId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getTerm(tx, auth.schoolId, termId),
    );

    if (!row) {
      throw new HTTPException(404, { message: "Term not found" });
    }

    return c.json(row, 200);
  });

  routes.openapi(updateTermRoute, async (c) => {
    const auth = requireAuth(c);
    const { termId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateTerm(tx, auth.schoolId, termId, body),
    );

    return c.json(row, 200);
  });

  routes.openapi(deleteTermRoute, async (c) => {
    const auth = requireAuth(c);
    const { termId } = c.req.valid("param");

    await withTenantTx(database, tenantFrom(c), (tx) => deleteTerm(tx, auth.schoolId, termId));

    return new Response(null, { status: 204 });
  });

  return routes;
}
