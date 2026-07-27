import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { apiProblemOpenApiSchema } from "../../../openapi/components";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";
import {
  copyTimetableBodySchema,
  copyTimetableResponseSchema,
  createTimetableSlotBodySchema,
  createTimetableVersionBodySchema,
  rejectTimetableBodySchema,
  slotIdParamSchema,
  timetableSlotListSchema,
  timetableSlotQuerySchema,
  timetableSlotSchema,
  timetableVersionListSchema,
  timetableVersionQuerySchema,
  timetableVersionSchema,
  updateTimetableSlotBodySchema,
  updateTimetableVersionBodySchema,
  versionIdParamSchema,
} from "../schemas";
import {
  approveTimetableVersion,
  copyTimetableVersion,
  createTimetableSlot,
  createTimetableVersion,
  deleteTimetableSlot,
  deleteTimetableVersion,
  getTimetableSlot,
  getTimetableVersion,
  listTimetableSlots,
  listTimetableVersions,
  rejectTimetableVersion,
  submitTimetableVersion,
  updateTimetableSlot,
  updateTimetableVersion,
} from "../timetable-service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
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

// 409 response with the timetable conflict detail extension, reused by slot create/update.
const conflictResponse = {
  409: {
    description: "Scheduling conflict: a teacher or room is double-booked.",
    headers: requestIdHeaders,
    content: {
      "application/problem+json": {
        schema: apiProblemOpenApiSchema,
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Route definitions — Versions
// ---------------------------------------------------------------------------

const listVersionsRoute = createRoute({
  method: "get",
  path: "/api/academics/timetable-versions",
  tags: ["Timetable"],
  operationId: "listTimetableVersions",
  summary: "List timetable versions",
  description: "Paginated list of timetable versions for a given term.",
  security: [{ bearerAuth: [] }],
  request: { query: timetableVersionQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of timetable versions.",
        schema: timetableVersionListSchema,
      },
    },
    [401, 403, 500],
  ),
});

const createVersionRoute = createRoute({
  method: "post",
  path: "/api/academics/timetable-versions",
  tags: ["Timetable"],
  operationId: "createTimetableVersion",
  summary: "Create a timetable version",
  description: "Creates a new draft timetable version for a term.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createTimetableVersionBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "The created timetable version.",
        schema: timetableVersionSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const getVersionRoute = createRoute({
  method: "get",
  path: "/api/academics/timetable-versions/{versionId}",
  tags: ["Timetable"],
  operationId: "getTimetableVersion",
  summary: "Get a timetable version",
  description: "Returns a single timetable version by ID.",
  security: [{ bearerAuth: [] }],
  request: { params: versionIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The timetable version.",
        schema: timetableVersionSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const updateVersionRoute = createRoute({
  method: "patch",
  path: "/api/academics/timetable-versions/{versionId}",
  tags: ["Timetable"],
  operationId: "updateTimetableVersion",
  summary: "Update a timetable version",
  description: "Updates the name of a draft timetable version.",
  security: [{ bearerAuth: [] }],
  request: {
    params: versionIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateTimetableVersionBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The updated timetable version.",
        schema: timetableVersionSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const deleteVersionRoute = createRoute({
  method: "delete",
  path: "/api/academics/timetable-versions/{versionId}",
  tags: ["Timetable"],
  operationId: "deleteTimetableVersion",
  summary: "Delete a timetable version",
  description:
    "Deletes a draft timetable version. Only draft versions with no slots can be deleted.",
  security: [{ bearerAuth: [] }],
  request: { params: versionIdParamSchema },
  responses: {
    204: { description: "Timetable version deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 409, 500]),
  },
});

const submitVersionRoute = createRoute({
  method: "post",
  path: "/api/academics/timetable-versions/{versionId}/submit",
  tags: ["Timetable"],
  operationId: "submitTimetableVersion",
  summary: "Submit a timetable version for review",
  description: "Transitions a draft version to pending status for admin review.",
  security: [{ bearerAuth: [] }],
  request: { params: versionIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The submitted timetable version.",
        schema: timetableVersionSchema,
      },
    },
    [401, 403, 404, 409, 500],
  ),
});

const approveVersionRoute = createRoute({
  method: "post",
  path: "/api/academics/timetable-versions/{versionId}/approve",
  tags: ["Timetable"],
  operationId: "approveTimetableVersion",
  summary: "Approve a timetable version",
  description: "Approves a pending timetable version, making it the live schedule for the term.",
  security: [{ bearerAuth: [] }],
  request: { params: versionIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The approved timetable version.",
        schema: timetableVersionSchema,
      },
    },
    [401, 403, 404, 409, 500],
  ),
});

const rejectVersionRoute = createRoute({
  method: "post",
  path: "/api/academics/timetable-versions/{versionId}/reject",
  tags: ["Timetable"],
  operationId: "rejectTimetableVersion",
  summary: "Reject a timetable version back to draft",
  description: "Sends a pending version back to draft status with a rejection reason.",
  security: [{ bearerAuth: [] }],
  request: {
    params: versionIdParamSchema,
    body: {
      required: false,
      content: { "application/json": { schema: rejectTimetableBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The rejected timetable version (now draft).",
        schema: timetableVersionSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const copyVersionRoute = createRoute({
  method: "post",
  path: "/api/academics/timetable-versions/copy",
  tags: ["Timetable"],
  operationId: "copyTimetableVersion",
  summary: "Copy timetable from a previous term",
  description:
    "Creates a new draft version by copying slots from a source version. " +
    "Slots whose class does not belong to the target term are skipped.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: copyTimetableBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "The new draft version with copy statistics.",
        schema: copyTimetableResponseSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route definitions — Slots
// ---------------------------------------------------------------------------

const listSlotsRoute = createRoute({
  method: "get",
  path: "/api/academics/timetable-versions/{versionId}/slots",
  tags: ["Timetable"],
  operationId: "listTimetableSlots",
  summary: "List slots in a timetable version",
  description:
    "Paginated list of slots for a given timetable version, ordered by weekday and period.",
  security: [{ bearerAuth: [] }],
  request: {
    params: versionIdParamSchema,
    query: timetableSlotQuerySchema,
  },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of timetable slots.",
        schema: timetableSlotListSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const createSlotRoute = createRoute({
  method: "post",
  path: "/api/academics/timetable-versions/{versionId}/slots",
  tags: ["Timetable"],
  operationId: "createTimetableSlot",
  summary: "Create a timetable slot",
  description:
    "Adds a slot to a draft timetable version. Returns 409 with conflict details " +
    "(who/where/when) if the teacher or room is already booked at that time.",
  security: [{ bearerAuth: [] }],
  request: {
    params: versionIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: createTimetableSlotBodySchema } },
    },
  },
  responses: {
    201: {
      description: "The created timetable slot.",
      headers: requestIdHeaders,
      content: { "application/json": { schema: timetableSlotSchema } },
    },
    ...conflictResponse,
    ...standardResponses({}, [400, 401, 403, 404, 500]),
  },
});

const getSlotRoute = createRoute({
  method: "get",
  path: "/api/academics/slots/{slotId}",
  tags: ["Timetable"],
  operationId: "getTimetableSlot",
  summary: "Get a timetable slot",
  description: "Returns a single timetable slot by ID.",
  security: [{ bearerAuth: [] }],
  request: { params: slotIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The timetable slot.",
        schema: timetableSlotSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const updateSlotRoute = createRoute({
  method: "patch",
  path: "/api/academics/slots/{slotId}",
  tags: ["Timetable"],
  operationId: "updateTimetableSlot",
  summary: "Update a timetable slot",
  description:
    "Partially updates a timetable slot. Returns 409 with conflict details " +
    "(who/where/when) if the teacher or room is already booked at that time.",
  security: [{ bearerAuth: [] }],
  request: {
    params: slotIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateTimetableSlotBodySchema } },
    },
  },
  responses: {
    200: {
      description: "The updated timetable slot.",
      headers: requestIdHeaders,
      content: { "application/json": { schema: timetableSlotSchema } },
    },
    ...conflictResponse,
    ...standardResponses({}, [400, 401, 403, 404, 409, 500]),
  },
});

const deleteSlotRoute = createRoute({
  method: "delete",
  path: "/api/academics/slots/{slotId}",
  tags: ["Timetable"],
  operationId: "deleteTimetableSlot",
  summary: "Delete a timetable slot",
  description: "Deletes a timetable slot from a draft version.",
  security: [{ bearerAuth: [] }],
  request: { params: slotIdParamSchema },
  responses: {
    204: { description: "Timetable slot deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 409, 500]),
  },
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function timetableRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Audit declarations
  routes.use("/api/academics/timetable-versions", auditAction("insert", "timetable_versions"));
  routes.use(
    "/api/academics/timetable-versions/{versionId}",
    auditAction("update", "timetable_versions"),
  );
  routes.use(
    "/api/academics/timetable-versions/{versionId}/slots",
    auditAction("insert", "timetable_slots"),
  );
  routes.use("/api/academics/slots/{slotId}", auditAction("update", "timetable_slots"));
  routes.use(
    "/api/academics/timetable-versions/{versionId}/submit",
    auditAction("update", "timetable_versions"),
  );
  routes.use(
    "/api/academics/timetable-versions/{versionId}/approve",
    auditAction("update", "timetable_versions"),
  );
  routes.use(
    "/api/academics/timetable-versions/{versionId}/reject",
    auditAction("update", "timetable_versions"),
  );
  routes.use("/api/academics/timetable-versions/copy", auditAction("insert", "timetable_versions"));

  // --- Versions ---

  routes.openapi(listVersionsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listTimetableVersions(tx, auth.schoolId, query),
    );

    return c.json({ timetable_versions: rows, total }, 200);
  });

  routes.openapi(createVersionRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      createTimetableVersion(tx, auth.schoolId, body),
    );

    return c.json(row, 201);
  });

  routes.openapi(getVersionRoute, async (c) => {
    const auth = requireAuth(c);
    const { versionId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getTimetableVersion(tx, auth.schoolId, versionId),
    );

    if (!row) {
      throw new HTTPException(404, { message: "Timetable version not found" });
    }

    return c.json(row, 200);
  });

  routes.openapi(updateVersionRoute, async (c) => {
    const auth = requireAuth(c);
    const { versionId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateTimetableVersion(tx, auth.schoolId, versionId, body),
    );

    return c.json(row, 200);
  });

  routes.openapi(deleteVersionRoute, async (c) => {
    const auth = requireAuth(c);
    const { versionId } = c.req.valid("param");

    await withTenantTx(database, tenantFrom(c), (tx) =>
      deleteTimetableVersion(tx, auth.schoolId, versionId),
    );

    return new Response(null, { status: 204 });
  });

  routes.openapi(submitVersionRoute, async (c) => {
    const auth = requireAuth(c);
    const { versionId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      submitTimetableVersion(tx, auth.schoolId, versionId, auth.userId),
    );

    return c.json(row, 200);
  });

  routes.openapi(approveVersionRoute, async (c) => {
    const auth = requireAuth(c);
    const { versionId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      approveTimetableVersion(tx, auth.schoolId, versionId, auth.userId),
    );

    return c.json(row, 200);
  });

  routes.openapi(rejectVersionRoute, async (c) => {
    const auth = requireAuth(c);
    const { versionId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      rejectTimetableVersion(tx, auth.schoolId, versionId, { reason: body?.reason ?? null }),
    );

    return c.json(row, 200);
  });

  routes.openapi(copyVersionRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");

    const result = await withTenantTx(database, tenantFrom(c), (tx) =>
      copyTimetableVersion(tx, auth.schoolId, body),
    );

    return c.json(result, 201);
  });

  // --- Slots ---

  routes.openapi(listSlotsRoute, async (c) => {
    const auth = requireAuth(c);
    const { versionId } = c.req.valid("param");
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listTimetableSlots(tx, auth.schoolId, versionId, query),
    );

    return c.json({ timetable_slots: rows, total }, 200);
  });

  routes.openapi(createSlotRoute, async (c) => {
    const auth = requireAuth(c);
    const { versionId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      createTimetableSlot(tx, auth.schoolId, versionId, body),
    );

    return c.json(row, 201);
  });

  routes.openapi(getSlotRoute, async (c) => {
    const auth = requireAuth(c);
    const { slotId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getTimetableSlot(tx, auth.schoolId, slotId),
    );

    if (!row) {
      throw new HTTPException(404, { message: "Timetable slot not found" });
    }

    return c.json(row, 200);
  });

  routes.openapi(updateSlotRoute, async (c) => {
    const auth = requireAuth(c);
    const { slotId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateTimetableSlot(tx, auth.schoolId, slotId, body),
    );

    return c.json(row, 200);
  });

  routes.openapi(deleteSlotRoute, async (c) => {
    const auth = requireAuth(c);
    const { slotId } = c.req.valid("param");

    await withTenantTx(database, tenantFrom(c), (tx) =>
      deleteTimetableSlot(tx, auth.schoolId, slotId),
    );

    return new Response(null, { status: 204 });
  });

  return routes;
}
