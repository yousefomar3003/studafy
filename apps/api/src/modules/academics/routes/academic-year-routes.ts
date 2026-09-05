import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";
import {
  createAcademicYear,
  deleteAcademicYear,
  getAcademicYear,
  listAcademicYears,
  updateAcademicYear,
} from "../academic-year-service";
import { rolloverAcademicYear } from "../rollover-service";
import {
  academicYearListSchema,
  academicYearQuerySchema,
  academicYearSchema,
  createAcademicYearBodySchema,
  rolloverResponseSchema,
  updateAcademicYearBodySchema,
  yearIdParamSchema,
} from "../schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listYearsRoute = createRoute({
  method: "get",
  path: "/api/academics/years",
  tags: ["Academics"],
  operationId: "listAcademicYears",
  summary: "List academic years",
  description:
    "Paginated list of academic years for the authenticated school, ordered by start date descending.",
  security: [{ bearerAuth: [] }],
  request: { query: academicYearQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of academic years.",
        schema: academicYearListSchema,
      },
    },
    [401, 403, 500],
  ),
});

const createYearRoute = createRoute({
  method: "post",
  path: "/api/academics/years",
  tags: ["Academics"],
  operationId: "createAcademicYear",
  summary: "Create an academic year",
  description:
    "Creates a new academic year for the school. Fails if the date range overlaps an active year " +
    "or if setting status to active when one already exists.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createAcademicYearBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "The created academic year.",
        schema: academicYearSchema,
      },
    },
    [400, 401, 403, 409, 500],
  ),
});

const getYearRoute = createRoute({
  method: "get",
  path: "/api/academics/years/{yearId}",
  tags: ["Academics"],
  operationId: "getAcademicYear",
  summary: "Get an academic year",
  description: "Returns a single academic year by ID.",
  security: [{ bearerAuth: [] }],
  request: { params: yearIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The academic year.",
        schema: academicYearSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const updateYearRoute = createRoute({
  method: "patch",
  path: "/api/academics/years/{yearId}",
  tags: ["Academics"],
  operationId: "updateAcademicYear",
  summary: "Update an academic year",
  description:
    "Partially updates an academic year. Validates date overlap and active-year constraints when " +
    "relevant fields change.",
  security: [{ bearerAuth: [] }],
  request: {
    params: yearIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateAcademicYearBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The updated academic year.",
        schema: academicYearSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteYearRoute = createRoute({
  method: "delete",
  path: "/api/academics/years/{yearId}",
  tags: ["Academics"],
  operationId: "deleteAcademicYear",
  summary: "Delete an academic year",
  description:
    "Deletes an academic year. Only years in 'planned' status with no dependent terms or classes " +
    "can be deleted.",
  security: [{ bearerAuth: [] }],
  request: { params: yearIdParamSchema },
  responses: {
    204: { description: "Academic year deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 409, 500]),
  },
});

const rolloverYearRoute = createRoute({
  method: "post",
  path: "/api/academics/years/{yearId}/rollover",
  tags: ["Academics"],
  operationId: "rolloverAcademicYear",
  summary: "Roll over to a new academic year",
  description:
    "Transitions the target year to active and closes the prior active year. Archives all active " +
    "enrollments in classes belonging to the prior year. Executes atomically.",
  security: [{ bearerAuth: [] }],
  request: { params: yearIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "Rollover completed.",
        schema: rolloverResponseSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
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

export function academicYearRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Audit declarations
  routes.use("/api/academics/years", auditAction("insert", "academic_years"));
  routes.use("/api/academics/years/:yearId", auditAction("update", "academic_years"));
  routes.use("/api/academics/years/:yearId/rollover", auditAction("update", "academic_years"));

  routes.openapi(listYearsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listAcademicYears(tx, auth.schoolId, query),
    );

    return c.json({ academic_years: rows, total }, 200);
  });

  routes.openapi(createYearRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      createAcademicYear(tx, auth.schoolId, body),
    );

    return c.json(row, 201);
  });

  routes.openapi(getYearRoute, async (c) => {
    const auth = requireAuth(c);
    const { yearId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getAcademicYear(tx, auth.schoolId, yearId),
    );

    if (!row) {
      throw new HTTPException(404, { message: "Academic year not found" });
    }

    return c.json(row, 200);
  });

  routes.openapi(updateYearRoute, async (c) => {
    const auth = requireAuth(c);
    const { yearId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateAcademicYear(tx, auth.schoolId, yearId, body),
    );

    return c.json(row, 200);
  });

  routes.openapi(deleteYearRoute, async (c) => {
    const auth = requireAuth(c);
    const { yearId } = c.req.valid("param");

    await withTenantTx(database, tenantFrom(c), (tx) =>
      deleteAcademicYear(tx, auth.schoolId, yearId),
    );

    return new Response(null, { status: 204 });
  });

  routes.openapi(rolloverYearRoute, async (c) => {
    const tenant = tenantFrom(c);
    const { yearId } = c.req.valid("param");

    const result = await rolloverAcademicYear(database, tenant, yearId);

    return c.json(result, 200);
  });

  return routes;
}
