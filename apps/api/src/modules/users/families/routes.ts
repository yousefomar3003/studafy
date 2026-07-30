import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { hasPermission, requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";

import {
  createFamilyBodySchema,
  createFamilyLinkBodySchema,
  familyDetailSchema,
  familyIdParamSchema,
  familyLinkParamSchema,
  familyLinkSchema,
  familyListQuerySchema,
  familyListSchema,
  familySchema,
  updateFamilyBodySchema,
  updateFamilyLinkBodySchema,
} from "./schemas";
import {
  createFamily,
  createFamilyLink,
  deleteFamily,
  deleteFamilyLink,
  getFamily,
  listFamilies,
  updateFamily,
  updateFamilyLink,
  type FamilyLinkRow,
  type FamilyRow,
} from "./service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { Context, MiddlewareHandler } from "hono";

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function onlyMethods(
  methods: readonly string[],
  middleware: MiddlewareHandler<AppEnv>,
): MiddlewareHandler<AppEnv> {
  return (c, next) => (methods.includes(c.req.method) ? middleware(c, next) : next());
}

function familyResponse<T extends FamilyRow | FamilyLinkRow>(row: T) {
  return {
    ...row,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function canReadFamilies(roles: ReturnType<typeof requireAuth>["roles"]): boolean {
  return roles.includes("PARENT") || hasPermission(roles, PERMISSIONS.PARENT_LINK);
}

const listRoute = createRoute({
  method: "get",
  path: "/api/families",
  tags: ["Families"],
  operationId: "listFamilies",
  security: [{ bearerAuth: [] }],
  request: { query: familyListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Visible households.", schema: familyListSchema } },
    [400, 401, 403, 500],
  ),
});
const createRouteDef = createRoute({
  method: "post",
  path: "/api/families",
  tags: ["Families"],
  operationId: "createFamily",
  security: [{ bearerAuth: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: createFamilyBodySchema } } },
  },
  responses: standardResponses(
    { 201: { description: "Created household.", schema: familySchema } },
    [400, 401, 403, 404, 500],
  ),
});
const getRoute = createRoute({
  method: "get",
  path: "/api/families/{familyId}",
  tags: ["Families"],
  operationId: "getFamily",
  security: [{ bearerAuth: [] }],
  request: { params: familyIdParamSchema },
  responses: standardResponses(
    { 200: { description: "Household and guardian links.", schema: familyDetailSchema } },
    [401, 403, 404, 500],
  ),
});
const updateRouteDef = createRoute({
  method: "patch",
  path: "/api/families/{familyId}",
  tags: ["Families"],
  operationId: "updateFamily",
  security: [{ bearerAuth: [] }],
  request: {
    params: familyIdParamSchema,
    body: { required: true, content: { "application/json": { schema: updateFamilyBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "Updated household.", schema: familySchema } },
    [400, 401, 403, 404, 500],
  ),
});
const deleteRouteDef = createRoute({
  method: "delete",
  path: "/api/families/{familyId}",
  tags: ["Families"],
  operationId: "deleteFamily",
  security: [{ bearerAuth: [] }],
  request: { params: familyIdParamSchema },
  responses: {
    204: { description: "Household deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 409, 500]),
  },
});
const createLinkRoute = createRoute({
  method: "post",
  path: "/api/families/{familyId}/links",
  tags: ["Families"],
  operationId: "createFamilyLink",
  security: [{ bearerAuth: [] }],
  request: {
    params: familyIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: createFamilyLinkBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "Created household guardian link.", schema: familyLinkSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});
const updateLinkRoute = createRoute({
  method: "patch",
  path: "/api/families/{familyId}/links/{parentUserId}/{studentId}",
  tags: ["Families"],
  operationId: "updateFamilyLink",
  security: [{ bearerAuth: [] }],
  request: {
    params: familyLinkParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateFamilyLinkBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "Updated household guardian link.", schema: familyLinkSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});
const deleteLinkRoute = createRoute({
  method: "delete",
  path: "/api/families/{familyId}/links/{parentUserId}/{studentId}",
  tags: ["Families"],
  operationId: "deleteFamilyLink",
  security: [{ bearerAuth: [] }],
  request: { params: familyLinkParamSchema },
  responses: {
    204: { description: "Household guardian link deleted.", headers: requestIdHeaders },
    ...standardResponses({}, [401, 403, 404, 500]),
  },
});

export function familyRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/families", onlyMethods(["POST"], auditAction("insert", "families")));
  routes.use("/api/families", onlyMethods(["POST"], requirePermission(PERMISSIONS.PARENT_LINK)));
  routes.use("/api/families/{familyId}", onlyMethods(["PATCH"], auditAction("update", "families")));
  routes.use(
    "/api/families/{familyId}",
    onlyMethods(["DELETE"], auditAction("delete", "families")),
  );
  routes.use(
    "/api/families/{familyId}",
    onlyMethods(["PATCH"], requirePermission(PERMISSIONS.PARENT_LINK)),
  );
  routes.use(
    "/api/families/{familyId}",
    onlyMethods(["DELETE"], requirePermission(PERMISSIONS.PARENT_UNLINK)),
  );
  routes.use(
    "/api/families/{familyId}/links",
    onlyMethods(["POST"], auditAction("insert", "parent_child_links")),
  );
  routes.use(
    "/api/families/{familyId}/links",
    onlyMethods(["POST"], requirePermission(PERMISSIONS.PARENT_LINK)),
  );
  routes.use(
    "/api/families/{familyId}/links/{parentUserId}/{studentId}",
    onlyMethods(["PATCH"], auditAction("update", "parent_child_links")),
  );
  routes.use(
    "/api/families/{familyId}/links/{parentUserId}/{studentId}",
    onlyMethods(["DELETE"], auditAction("delete", "parent_child_links")),
  );
  routes.use(
    "/api/families/{familyId}/links/{parentUserId}/{studentId}",
    onlyMethods(["PATCH"], requirePermission(PERMISSIONS.PARENT_LINK)),
  );
  routes.use(
    "/api/families/{familyId}/links/{parentUserId}/{studentId}",
    onlyMethods(["DELETE"], requirePermission(PERMISSIONS.PARENT_UNLINK)),
  );

  routes.openapi(listRoute, async (c) => {
    const auth = requireAuth(c);
    if (!canReadFamilies(auth.roles)) {
      throw new HTTPException(403, { message: "Insufficient permissions for this operation" });
    }
    const query = c.req.valid("query");
    const canManage = hasPermission(auth.roles, PERMISSIONS.PARENT_LINK);
    const result = await withTenantTx(database, tenantFrom(c), (tx) =>
      listFamilies(tx, auth.schoolId, auth.userId, canManage, query),
    );
    return c.json({ families: result.rows.map(familyResponse), total: result.total }, 200);
  });
  routes.openapi(createRouteDef, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const family = await withTenantTx(database, tenantFrom(c), (tx) =>
      createFamily(tx, auth.schoolId, body.display_name, body.primary_parent_user_id),
    );
    return c.json(familyResponse(family), 201);
  });
  routes.openapi(getRoute, async (c) => {
    const auth = requireAuth(c);
    if (!canReadFamilies(auth.roles)) {
      throw new HTTPException(403, { message: "Insufficient permissions for this operation" });
    }
    const { familyId } = c.req.valid("param");
    const canManage = hasPermission(auth.roles, PERMISSIONS.PARENT_LINK);
    const family = await withTenantTx(database, tenantFrom(c), (tx) =>
      getFamily(tx, auth.schoolId, familyId, auth.userId, canManage),
    );
    if (!family) throw new HTTPException(404, { message: "Family not found" });
    return c.json(
      {
        ...familyResponse(family),
        links: family.links.map(familyResponse),
      },
      200,
    );
  });
  routes.openapi(updateRouteDef, async (c) => {
    const auth = requireAuth(c);
    const { familyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const family = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateFamily(tx, auth.schoolId, familyId, {
        displayName: body.display_name,
        primaryParentUserId: body.primary_parent_user_id,
      }),
    );
    return c.json(familyResponse(family), 200);
  });
  routes.openapi(deleteRouteDef, async (c) => {
    const auth = requireAuth(c);
    const { familyId } = c.req.valid("param");
    await withTenantTx(database, tenantFrom(c), (tx) => deleteFamily(tx, auth.schoolId, familyId));
    return c.body(null, 204);
  });
  routes.openapi(createLinkRoute, async (c) => {
    const auth = requireAuth(c);
    const { familyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const link = await withTenantTx(database, tenantFrom(c), (tx) =>
      createFamilyLink(
        tx,
        auth.schoolId,
        familyId,
        body.parent_user_id,
        body.student_id,
        body.relationship,
      ),
    );
    return c.json(familyResponse(link), 201);
  });
  routes.openapi(updateLinkRoute, async (c) => {
    const auth = requireAuth(c);
    const params = c.req.valid("param");
    const body = c.req.valid("json");
    const link = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateFamilyLink(tx, auth.schoolId, params.familyId, params.parentUserId, params.studentId, {
        targetFamilyId: body.target_family_id,
        relationship: body.relationship,
      }),
    );
    return c.json(familyResponse(link), 200);
  });
  routes.openapi(deleteLinkRoute, async (c) => {
    const auth = requireAuth(c);
    const params = c.req.valid("param");
    await withTenantTx(database, tenantFrom(c), (tx) =>
      deleteFamilyLink(tx, auth.schoolId, params.familyId, params.parentUserId, params.studentId),
    );
    return c.body(null, 204);
  });

  return routes;
}
