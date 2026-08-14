import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import {
  createUserBodySchema,
  userListQuerySchema,
  userListSchema,
  userIdParamSchema,
  updateUserBodySchema,
  updateUserRoleBodySchema,
  userDeactivateResponseSchema,
  userStatusCountsSchema,
  userWithRolesSchema,
} from "../schemas";
import {
  createUser as createUserService,
  deactivateUser,
  getUser,
  getUserStatusCounts,
  listUsers,
  updateUser as updateUserService,
  updateUserRole as updateUserRoleService,
} from "../user-service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { JtiDenylist } from "../../auth/denylist";
import type { Role } from "@studafy/constants";
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

function clientIpFrom(c: Context<AppEnv>): string | null {
  const forwarded = c.req.header("X-Forwarded-For");
  if (forwarded === undefined) return null;
  const first = forwarded.split(",")[0]?.trim();
  return first !== undefined && first.length > 0 ? first : null;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listUsersRoute = createRoute({
  method: "get",
  path: "/api/users",
  tags: ["Users"],
  operationId: "listUsers",
  summary: "List school users",
  description:
    "Paginated, cursor-based list of users for the authenticated school. Supports search over " +
    "name and email, filtering by role and status, and date-range filtering.",
  security: [{ bearerAuth: [] }],
  request: { query: userListQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of users with roles.",
        schema: userListSchema,
      },
    },
    [400, 401, 403, 429, 500],
  ),
});

const getUserStatusCountsRoute = createRoute({
  method: "get",
  path: "/api/users/status-counts",
  tags: ["Users"],
  operationId: "getUserStatusCounts",
  summary: "Get user counts by status",
  description:
    "Aggregate counts of users in the school grouped by lifecycle status (invited, active, " +
    "suspended, archived). Powers admin activation-funnel reporting without paging through the " +
    "full user list to total a status.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    {
      200: {
        description: "Counts of users per status.",
        schema: userStatusCountsSchema,
      },
    },
    [401, 403, 429, 500],
  ),
});

const getUserRoute = createRoute({
  method: "get",
  path: "/api/users/{userId}",
  tags: ["Users"],
  operationId: "getUser",
  summary: "Get a user",
  description: "Returns a single user with their assigned roles.",
  security: [{ bearerAuth: [] }],
  request: { params: userIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "The user with roles.",
        schema: userWithRolesSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const createUserRoute = createRoute({
  method: "post",
  path: "/api/users",
  tags: ["Users"],
  operationId: "createUser",
  summary: "Create a user",
  description:
    "Creates a new user in the school with the specified role. The user is created with " +
    "'invited' status. Fails with 409 if the email already exists in this school.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createUserBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "The created user with roles.",
        schema: userWithRolesSchema,
      },
    },
    [400, 401, 403, 409, 429, 500],
  ),
});

const updateUserRoute = createRoute({
  method: "patch",
  path: "/api/users/{userId}",
  tags: ["Users"],
  operationId: "updateUser",
  summary: "Update a user",
  description:
    "Partially updates a user's display name or status. Emits an audit log with the diff.",
  security: [{ bearerAuth: [] }],
  request: {
    params: userIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateUserBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The updated user.",
        schema: userWithRolesSchema,
      },
    },
    [400, 401, 403, 404, 409, 429, 500],
  ),
});

const updateUserRoleRoute = createRoute({
  method: "patch",
  path: "/api/users/{userId}/role",
  tags: ["Users"],
  operationId: "updateUserRole",
  summary: "Update a user's role",
  description:
    "Replaces the user's current role with a new one. The role must be one of the 7 predefined " +
    "platform roles. Emits an audit log with old and new role assignments.",
  security: [{ bearerAuth: [] }],
  request: {
    params: userIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateUserRoleBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "The user with the updated role.",
        schema: userWithRolesSchema,
      },
    },
    [400, 401, 403, 404, 409, 429, 500],
  ),
});

const deactivateUserRoute = createRoute({
  method: "patch",
  path: "/api/users/{userId}/deactivate",
  tags: ["Users"],
  operationId: "deactivateUser",
  summary: "Deactivate a user",
  description:
    "Immediately suspends a user, revokes all active sessions (refresh tokens and access tokens), " +
    "and revokes all pending, unconsumed invitations for that user's email. The user is logged out " +
    "system-wide within seconds.",
  security: [{ bearerAuth: [] }],
  request: { params: userIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "Deactivation result with revocation counts.",
        schema: userDeactivateResponseSchema,
      },
    },
    [401, 403, 404, 429, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function userRoutes(database: Database, denylist: JtiDenylist | null): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // --- Channel guard: mutations restricted to web sessions ---
  const channelGuard = requireChannel(AUTH_CHANNELS.WEB);
  routes.use("/api/users", channelGuard);
  routes.use("/api/users/status-counts", channelGuard);
  routes.use("/api/users/{userId}", channelGuard);
  routes.use("/api/users/{userId}/role", channelGuard);
  routes.use("/api/users/{userId}/deactivate", channelGuard);

  // --- Permission guards ---
  routes.use("/api/users", requirePermission(PERMISSIONS.USER_READ));
  routes.use("/api/users", requirePermission(PERMISSIONS.USER_CREATE));
  routes.use("/api/users/status-counts", requirePermission(PERMISSIONS.USER_READ));
  routes.use("/api/users/{userId}", requirePermission(PERMISSIONS.USER_READ));
  routes.use("/api/users/{userId}", requirePermission(PERMISSIONS.USER_UPDATE));
  routes.use("/api/users/{userId}/role", requirePermission(PERMISSIONS.ROLE_ASSIGN));
  routes.use("/api/users/{userId}/deactivate", requirePermission(PERMISSIONS.USER_SUSPEND));

  // --- Audit declarations ---
  routes.use("/api/users", auditAction("insert", "users"));
  routes.use("/api/users/{userId}", auditAction("update", "users"));
  routes.use("/api/users/{userId}/role", auditAction("update", "user_roles"));
  routes.use("/api/users/{userId}/deactivate", auditAction("update", "users"));

  // --- Handlers ---

  routes.openapi(listUsersRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, next_cursor } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listUsers(tx, auth.schoolId, {
        ...query,
        role: query.role as Role | undefined,
      }),
    );

    return c.json({ users: rows, next_cursor }, 200);
  });

  routes.openapi(getUserStatusCountsRoute, async (c) => {
    const auth = requireAuth(c);

    const counts = await withTenantTx(database, tenantFrom(c), (tx) =>
      getUserStatusCounts(tx, auth.schoolId),
    );

    return c.json(counts, 200);
  });

  routes.openapi(getUserRoute, async (c) => {
    const auth = requireAuth(c);
    const { userId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getUser(tx, auth.schoolId, userId),
    );

    if (!row) {
      throw new HTTPException(404, {
        message: "User not found",
      });
    }

    return c.json(row, 200);
  });

  routes.openapi(createUserRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      createUserService(tx, auth.schoolId, {
        ...body,
        role: body.role as Role,
      }),
    );

    return c.json(row, 201);
  });

  routes.openapi(updateUserRoute, async (c) => {
    const auth = requireAuth(c);
    const { userId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateUserService(tx, auth.schoolId, userId, body),
    );

    return c.json(row, 200);
  });

  routes.openapi(updateUserRoleRoute, async (c) => {
    const auth = requireAuth(c);
    const { userId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      updateUserRoleService(tx, auth.schoolId, userId, {
        role: body.role as Role,
      }),
    );

    return c.json(row, 200);
  });

  routes.openapi(deactivateUserRoute, async (c) => {
    const auth = requireAuth(c);
    const { userId } = c.req.valid("param");

    const result = await deactivateUser({
      database,
      denylist,
      tenant: { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") },
      targetUserId: userId,
      log: c.get("log"),
      userAgent: c.req.header("User-Agent") ?? null,
      clientIp: clientIpFrom(c),
    });

    return c.json(result, 200);
  });

  return routes;
}
