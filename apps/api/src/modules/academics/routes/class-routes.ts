import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";
import { createClass, deleteClass, getClass, listClasses, updateClass } from "../class-service";
import {
  classIdParamSchema,
  classListSchema,
  classQuerySchema,
  classSchema,
  createClassBodySchema,
  updateClassBodySchema,
} from "../schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listClassesRoute = createRoute({
  method: "get",
  path: "/api/academics/classes",
  tags: ["Academics"],
  operationId: "listClasses",
  summary: "List classes",
  description: "Paginated list of classes for the authenticated school, ordered by code ascending.",
  security: [{ bearerAuth: [] }],
  request: { query: classQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of classes.",
        schema: classListSchema,
      },
    },
    [401, 403, 500],
  ),
});

const createClassRoute = createRoute({
  method: "post",
  path: "/api/academics/classes",
  tags: ["Academics"],
  operationId: "createClass",
  summary: "Create a class",
  description: "Creates a new class (a scheduled delivery of a course).",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createClassBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "The created class.",
        schema: classSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const getClassRoute = createRoute({
  method: "get",
  path: "/api/academics/classes/{classId}",
  tags: ["Academics"],
  operationId: "getClass",
  summary: "Get a class",
  description: "Returns a single class by ID.",
  security: [{ bearerAuth: [] }],
  request: { params: classIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The class.",
        schema: classSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const updateClassRoute = createRoute({
  method: "patch",
  path: "/api/academics/classes/{classId}",
  tags: ["Academics"],
  operationId: "updateClass",
  summary: "Update a class",
  description: "Partially updates a class.",
  security: [{ bearerAuth: [] }],
  request: {
    params: classIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateClassBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The updated class.",
        schema: classSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteClassRoute = createRoute({
  method: "delete",
  path: "/api/academics/classes/{classId}",
  tags: ["Academics"],
  operationId: "deleteClass",
  summary: "Delete a class",
  description:
    "Deletes a class. If the class has enrollments it is cancelled instead. " +
    "Unreferenced classes are hard-deleted.",
  security: [{ bearerAuth: [] }],
  request: { params: classIdParamSchema },
  responses: {
    204: { description: "Class deleted or cancelled.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 500]),
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

export function classRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Audit declarations
  routes.use("/api/academics/classes", auditAction("insert", "classes"));
  routes.use("/api/academics/classes/{classId}", auditAction("update", "classes"));

  routes.openapi(listClassesRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listClasses(tx, auth.schoolId, query),
    );

    return c.json({ classes: rows, total }, 200);
  });

  routes.openapi(createClassRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      createClass(tx, auth.schoolId, body),
    );

    return c.json(row, 201);
  });

  routes.openapi(getClassRoute, async (c) => {
    const auth = requireAuth(c);
    const { classId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getClass(tx, auth.schoolId, classId),
    );

    if (!row) {
      throw new HTTPException(404, { message: "Class not found" });
    }

    return c.json(row, 200);
  });

  routes.openapi(updateClassRoute, async (c) => {
    const auth = requireAuth(c);
    const { classId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateClass(tx, auth.schoolId, classId, body),
    );

    return c.json(row, 200);
  });

  routes.openapi(deleteClassRoute, async (c) => {
    const auth = requireAuth(c);
    const { classId } = c.req.valid("param");

    await withTenantTx(database, tenantFrom(c), (tx) => deleteClass(tx, auth.schoolId, classId));

    return new Response(null, { status: 204 });
  });

  return routes;
}
