import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";
import {
  createSubjectBodySchema,
  subjectIdParamSchema,
  subjectListSchema,
  subjectQuerySchema,
  subjectSchema,
  updateSubjectBodySchema,
} from "../schemas";
import {
  createSubject,
  deleteSubject,
  getSubject,
  listSubjects,
  updateSubject,
} from "../subject-service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listSubjectsRoute = createRoute({
  method: "get",
  path: "/api/academics/subjects",
  tags: ["Academics"],
  operationId: "listSubjects",
  summary: "List subjects",
  description:
    "Paginated list of subjects for the authenticated school, ordered by code ascending.",
  security: [{ bearerAuth: [] }],
  request: { query: subjectQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of subjects.",
        schema: subjectListSchema,
      },
    },
    [401, 403, 500],
  ),
});

const createSubjectRoute = createRoute({
  method: "post",
  path: "/api/academics/subjects",
  tags: ["Academics"],
  operationId: "createSubject",
  summary: "Create a subject",
  description: "Creates a new subject in the school catalog.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createSubjectBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "The created subject.",
        schema: subjectSchema,
      },
    },
    [400, 401, 403, 409, 500],
  ),
});

const getSubjectRoute = createRoute({
  method: "get",
  path: "/api/academics/subjects/{subjectId}",
  tags: ["Academics"],
  operationId: "getSubject",
  summary: "Get a subject",
  description: "Returns a single subject by ID.",
  security: [{ bearerAuth: [] }],
  request: { params: subjectIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The subject.",
        schema: subjectSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const updateSubjectRoute = createRoute({
  method: "patch",
  path: "/api/academics/subjects/{subjectId}",
  tags: ["Academics"],
  operationId: "updateSubject",
  summary: "Update a subject",
  description: "Partially updates a subject.",
  security: [{ bearerAuth: [] }],
  request: {
    params: subjectIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateSubjectBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The updated subject.",
        schema: subjectSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteSubjectRoute = createRoute({
  method: "delete",
  path: "/api/academics/subjects/{subjectId}",
  tags: ["Academics"],
  operationId: "deleteSubject",
  summary: "Delete a subject",
  description:
    "Deletes a subject. If the subject has dependent courses it is archived instead. " +
    "Unreferenced subjects are hard-deleted.",
  security: [{ bearerAuth: [] }],
  request: { params: subjectIdParamSchema },
  responses: {
    204: { description: "Subject deleted or archived.", headers: requestIdHeaders },
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

export function subjectRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Audit declarations
  routes.use("/api/academics/subjects", auditAction("insert", "subjects"));
  routes.use("/api/academics/subjects/{subjectId}", auditAction("update", "subjects"));

  routes.openapi(listSubjectsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listSubjects(tx, auth.schoolId, query),
    );

    return c.json({ subjects: rows, total }, 200);
  });

  routes.openapi(createSubjectRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      createSubject(tx, auth.schoolId, body),
    );

    return c.json(row, 201);
  });

  routes.openapi(getSubjectRoute, async (c) => {
    const auth = requireAuth(c);
    const { subjectId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getSubject(tx, auth.schoolId, subjectId),
    );

    if (!row) {
      throw new HTTPException(404, { message: "Subject not found" });
    }

    return c.json(row, 200);
  });

  routes.openapi(updateSubjectRoute, async (c) => {
    const auth = requireAuth(c);
    const { subjectId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateSubject(tx, auth.schoolId, subjectId, body),
    );

    return c.json(row, 200);
  });

  routes.openapi(deleteSubjectRoute, async (c) => {
    const auth = requireAuth(c);
    const { subjectId } = c.req.valid("param");

    await withTenantTx(database, tenantFrom(c), (tx) =>
      deleteSubject(tx, auth.schoolId, subjectId),
    );

    return new Response(null, { status: 204 });
  });

  return routes;
}
