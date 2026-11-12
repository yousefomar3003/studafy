import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { requireAuth } from "../../../middleware/authContext";
import { hasPermission, requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import { getParent, listParents } from "../parent-service";
import {
  parentIdParamSchema,
  parentListQuerySchema,
  parentListSchema,
  parentSummarySchema,
} from "../schemas";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { ParentRow } from "../parent-service";
import type { ParentSummary } from "../schemas";
import type { Context } from "hono";

/**
 * The parent directory (`GET /api/parents`, `GET /api/parents/{parentUserId}`): each parent's
 * contact details, Studafy ID and children, for the principal's and admin's Parents page.
 *
 * Gated on `user:read` -- admins, principals and finance -- and web only. Not on the record
 * permissions: teachers and parents hold those, and a parent's phone is not theirs to see.
 */

function tenantFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

/** A child's admission number is finance-visible only, as on the student list (projectStudent). */
function project(row: ParentRow, showAdmissionNumbers: boolean): ParentSummary {
  return {
    ...row,
    last_login_at: row.last_login_at ? row.last_login_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    children: row.children.map((child) => ({
      ...child,
      admission_number: showAdmissionNumbers ? child.admission_number : null,
      relationship: child.relationship as ParentSummary["children"][number]["relationship"],
    })),
  } as ParentSummary;
}

const listParentsRoute = createRoute({
  method: "get",
  path: "/api/parents",
  tags: ["Users"],
  operationId: "listParents",
  summary: "List the school's parents",
  description:
    "Every parent account of the school, newest first, with contact details, Studafy ID and " +
    "linked children (each with their class this year). Requires `user:read`.",
  security: [{ bearerAuth: [] }],
  request: { query: parentListQuerySchema },
  responses: standardResponses(
    { 200: { description: "A page of parents.", schema: parentListSchema } },
    [400, 401, 403, 429, 500],
  ),
});

const getParentRoute = createRoute({
  method: "get",
  path: "/api/parents/{parentUserId}",
  tags: ["Users"],
  operationId: "getParent",
  summary: "Get one parent",
  description:
    "One parent's contact details, Studafy ID and linked children. 404 when the user is not a " +
    "parent of this school. Requires `user:read`.",
  security: [{ bearerAuth: [] }],
  request: { params: parentIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The parent.", schema: parentSummarySchema } },
    [400, 401, 403, 404, 429, 500],
  ),
});

export function parentRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // `:parentUserId` is a UUID in each guard, so `/api/parents/{id}/records` (records module, its
  // own permissions) is never caught by these.
  const exact = ["/api/parents", "/api/parents/:parentUserId{[0-9a-fA-F-]{36}}"];
  for (const path of exact) {
    routes.use(path, requireChannel(AUTH_CHANNELS.WEB));
    routes.use(path, requirePermission(PERMISSIONS.USER_READ));
  }

  routes.openapi(listParentsRoute, async (c) => {
    const query = c.req.valid("query");
    const { rows, next_cursor } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listParents(tx, query),
    );
    const billing = hasPermission(requireAuth(c).roles, PERMISSIONS.BILLING_READ);
    return c.json({ parents: rows.map((row) => project(row, billing)), next_cursor }, 200);
  });

  routes.openapi(getParentRoute, async (c) => {
    const { parentUserId } = c.req.valid("param");
    const row = await withTenantTx(database, tenantFrom(c), (tx) => getParent(tx, parentUserId));
    if (!row) throw new HTTPException(404, { message: "Parent not found" });
    return c.json(project(row, hasPermission(requireAuth(c).roles, PERMISSIONS.BILLING_READ)), 200);
  });

  return routes;
}
