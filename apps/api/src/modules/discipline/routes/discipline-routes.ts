import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission, requirePermissionIn } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import {
  createIncident,
  getIncident,
  listIncidents,
  updateIncident,
  resolveIncident,
  listActions,
  createAction,
  updateAction,
  getParentChildren,
  getParentResolvedIncidents,
  getParentDisciplineVisibility,
} from "../discipline-service";
import {
  disciplineIncidentListSchema,
  disciplineIncidentSchema,
  disciplineActionListSchema,
  disciplineActionSchema,
  createIncidentBodySchema,
  updateIncidentBodySchema,
  resolveIncidentBodySchema,
  createActionBodySchema,
  updateActionBodySchema,
  disciplineIncidentQuerySchema,
  incidentIdParamSchema,
  actionIdParamSchema,
} from "../schemas";

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

const listIncidentsRoute = createRoute({
  method: "get",
  path: "/api/discipline/incidents",
  tags: ["Discipline"],
  operationId: "listDisciplineIncidents",
  summary: "List discipline incidents",
  description:
    "Paginated list of discipline incidents. Teachers see incidents they reported; " +
    "admins see all incidents; parents see only their own child's resolved incidents " +
    "when the school policy allows.",
  security: [{ bearerAuth: [] }],
  request: { query: disciplineIncidentQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of discipline incidents.",
        schema: disciplineIncidentListSchema,
      },
    },
    [401, 403, 500],
  ),
});

const getIncidentRoute = createRoute({
  method: "get",
  path: "/api/discipline/incidents/{incidentId}",
  tags: ["Discipline"],
  operationId: "getDisciplineIncident",
  summary: "Get a discipline incident",
  description: "Returns a single discipline incident by ID.",
  security: [{ bearerAuth: [] }],
  request: { params: incidentIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The discipline incident.",
        schema: disciplineIncidentSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const createIncidentRoute = createRoute({
  method: "post",
  path: "/api/discipline/incidents",
  tags: ["Discipline"],
  operationId: "createDisciplineIncident",
  summary: "Report a discipline incident",
  description: "Reports a new discipline incident. Available to teachers and admins.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createIncidentBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "The created discipline incident.",
        schema: disciplineIncidentSchema,
      },
    },
    [400, 401, 403, 404, 500],
  ),
});

const updateIncidentRoute = createRoute({
  method: "patch",
  path: "/api/discipline/incidents/{incidentId}",
  tags: ["Discipline"],
  operationId: "updateDisciplineIncident",
  summary: "Update a discipline incident",
  description: "Updates severity, status, or description. Admin-only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: incidentIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateIncidentBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The updated discipline incident.",
        schema: disciplineIncidentSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const resolveIncidentRoute = createRoute({
  method: "post",
  path: "/api/discipline/incidents/{incidentId}/resolve",
  tags: ["Discipline"],
  operationId: "resolveDisciplineIncident",
  summary: "Resolve a discipline incident",
  description: "Marks an incident as resolved. Admin-only — teachers cannot resolve incidents.",
  security: [{ bearerAuth: [] }],
  request: {
    params: incidentIdParamSchema,
    body: {
      required: false,
      content: { "application/json": { schema: resolveIncidentBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The resolved discipline incident.",
        schema: disciplineIncidentSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const listActionsRoute = createRoute({
  method: "get",
  path: "/api/discipline/incidents/{incidentId}/actions",
  tags: ["Discipline"],
  operationId: "listDisciplineActions",
  summary: "List discipline actions",
  description: "Paginated list of actions for an incident.",
  security: [{ bearerAuth: [] }],
  request: { params: incidentIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of discipline actions.",
        schema: disciplineActionListSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const createActionRoute = createRoute({
  method: "post",
  path: "/api/discipline/incidents/{incidentId}/actions",
  tags: ["Discipline"],
  operationId: "createDisciplineAction",
  summary: "Create a discipline action",
  description: "Creates a new action for an incident. Admin-only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: incidentIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: createActionBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "The created discipline action.",
        schema: disciplineActionSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

const updateActionRoute = createRoute({
  method: "patch",
  path: "/api/discipline/incidents/{incidentId}/actions/{actionId}",
  tags: ["Discipline"],
  operationId: "updateDisciplineAction",
  summary: "Update a discipline action",
  description: "Updates action status or details. Admin-only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: actionIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateActionBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The updated discipline action.",
        schema: disciplineActionSchema,
      },
    },
    [400, 401, 403, 404, 409, 500],
  ),
});

export function disciplineRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/discipline/incidents", auditAction("insert", "discipline_incidents"));
  routes.use(
    "/api/discipline/incidents/{incidentId}",
    auditAction("update", "discipline_incidents"),
  );
  routes.use(
    "/api/discipline/incidents/{incidentId}/resolve",
    auditAction("update", "discipline_incidents"),
  );
  routes.use(
    "/api/discipline/incidents/{incidentId}/actions",
    auditAction("insert", "discipline_actions"),
  );
  routes.use(
    "/api/discipline/incidents/{incidentId}/actions/{actionId}",
    auditAction("update", "discipline_actions"),
  );

  routes.use("/api/discipline/incidents", requirePermission(PERMISSIONS.DISCIPLINE_INCIDENT_READ));
  routes.use(
    "/api/discipline/incidents/{incidentId}",
    requirePermission(PERMISSIONS.DISCIPLINE_INCIDENT_READ),
  );
  routes.use(
    "/api/discipline/incidents/{incidentId}/actions",
    requirePermission(PERMISSIONS.DISCIPLINE_ACTION_READ),
  );
  routes.use(
    "/api/discipline/incidents/{incidentId}/actions/{actionId}",
    requirePermission(PERMISSIONS.DISCIPLINE_ACTION_READ),
  );

  routes.openapi(listIncidentsRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");
    const isParent = auth.roles.includes("PARENT");

    if (isParent) {
      const visible = await withTenantTx(database, tenantFrom(c), (tx) =>
        getParentDisciplineVisibility(tx, auth.schoolId),
      );
      if (!visible) {
        throw new HTTPException(403, {
          message: "Parent visibility of discipline incidents is disabled for this school",
        });
      }

      const children = await withTenantTx(database, tenantFrom(c), (tx) =>
        getParentChildren(tx, auth.schoolId, auth.userId),
      );

      const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
        getParentResolvedIncidents(tx, auth.schoolId, children, query),
      );

      return c.json({ incidents: rows, total }, 200);
    }

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listIncidents(tx, auth.schoolId, query),
    );

    return c.json({ incidents: rows, total }, 200);
  });

  routes.openapi(getIncidentRoute, async (c) => {
    const auth = requireAuth(c);
    const { incidentId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getIncident(tx, auth.schoolId, incidentId),
    );

    if (!row) {
      throw new HTTPException(404, { message: "Discipline incident not found" });
    }

    return c.json(row, 200);
  });

  routes.openapi(createIncidentRoute, async (c) => {
    const auth = requireAuth(c);
    requirePermissionIn(c, PERMISSIONS.DISCIPLINE_INCIDENT_CREATE);
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      createIncident(tx, auth.schoolId, auth.userId, body),
    );

    return c.json(row, 201);
  });

  routes.openapi(updateIncidentRoute, async (c) => {
    const auth = requireAuth(c);
    requirePermissionIn(c, PERMISSIONS.DISCIPLINE_INCIDENT_UPDATE);
    const { incidentId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateIncident(tx, auth.schoolId, incidentId, body),
    );

    return c.json(row, 200);
  });

  routes.openapi(resolveIncidentRoute, async (c) => {
    const auth = requireAuth(c);
    requirePermissionIn(c, PERMISSIONS.DISCIPLINE_INCIDENT_RESOLVE);
    const { incidentId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      resolveIncident(tx, auth.schoolId, incidentId, body?.resolution_description),
    );

    return c.json(row, 200);
  });

  routes.openapi(listActionsRoute, async (c) => {
    const auth = requireAuth(c);
    const { incidentId } = c.req.valid("param");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listActions(tx, auth.schoolId, incidentId, { limit: 100, offset: 0 }),
    );

    return c.json({ actions: rows, total }, 200);
  });

  routes.openapi(createActionRoute, async (c) => {
    const auth = requireAuth(c);
    requirePermissionIn(c, PERMISSIONS.DISCIPLINE_ACTION_CREATE);
    const { incidentId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      createAction(tx, auth.schoolId, auth.userId, incidentId, body),
    );

    return c.json(row, 201);
  });

  routes.openapi(updateActionRoute, async (c) => {
    const auth = requireAuth(c);
    requirePermissionIn(c, PERMISSIONS.DISCIPLINE_ACTION_UPDATE);
    const { incidentId, actionId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateAction(tx, auth.schoolId, incidentId, actionId, body),
    );

    return c.json(row, 200);
  });

  return routes;
}
