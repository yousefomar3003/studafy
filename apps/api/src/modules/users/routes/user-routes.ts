import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission, requirePermissionIn } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { onlyMethods } from "../../../middleware/only-methods";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import {
  DEFAULT_MEMBER_PASSWORD,
  resetMemberPassword,
} from "../../auth/services/member-password-service";
import {
  adminRevokeUserSessions,
  REVOCATION_REASONS,
} from "../../auth/services/revocation-service";
import { writeAnswers } from "../../records/record-service";
import {
  createUserBodySchema,
  userListQuerySchema,
  userListSchema,
  userIdParamSchema,
  updateUserBodySchema,
  updateUserRoleBodySchema,
  userDeactivateResponseSchema,
  userListItemSchema,
  userMemberSummarySchema,
  userStatusCountsSchema,
  userWithRolesSchema,
} from "../schemas";
import {
  createUser as createUserService,
  deactivateUser,
  getUser,
  getUserMemberSummary,
  getUserStatusCounts,
  listUsers,
  updateUser as updateUserService,
  updateUserRole as updateUserRoleService,
} from "../user-service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { JtiDenylist } from "../../auth/denylist";
import type { Role } from "@studafy/constants";
import type { RecordKeyring } from "@studafy/records";
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

const getUserMemberSummaryRoute = createRoute({
  method: "get",
  path: "/api/users/member-summary",
  tags: ["Users"],
  operationId: "getUserMemberSummary",
  summary: "Get student, teacher and parent counts",
  description:
    "The school's platform number and how many students, teachers and parents it has. Each of " +
    "them holds a member ID: STU, TCH or PAR, then the school number and a sequence.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    {
      200: {
        description: "School number and headcount by role.",
        schema: userMemberSummarySchema,
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
        description: "The user with roles and member IDs.",
        schema: userListItemSchema,
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
    "'invited' status. Fails with 409 if the email already exists in this school. A PARENT can " +
    "be created already linked to `children` in the same transaction; that also needs " +
    "`parent:link`, and any child that cannot be linked fails the whole request.",
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
        description: "The created user with roles and member IDs.",
        schema: userListItemSchema,
      },
    },
    [400, 401, 403, 404, 409, 429, 500],
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

const resetPasswordRoute = createRoute({
  method: "post",
  path: "/api/users/{userId}/password/reset",
  tags: ["Users"],
  operationId: "resetMemberPassword",
  summary: "Reset a member's password",
  description:
    "Returns a student, parent, teacher or attendance officer to the starting password, clears any " +
    "lockout and signs them out everywhere. They must choose a new password at their next sign-in. " +
    "404 for accounts that sign in with Google or Microsoft (no member ID).",
  security: [{ bearerAuth: [] }],
  request: { params: userIdParamSchema },
  responses: standardResponses(
    {
      200: {
        description: "Password reset.",
        schema: z
          .object({
            usernames: z
              .array(z.string())
              .openapi({ description: "The member IDs they sign in with." }),
            default_password: z.string().openapi({ description: "The password to give them." }),
          })
          .openapi("MemberPasswordReset"),
      },
    },
    [401, 403, 404, 429, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function userRoutes(
  database: Database,
  denylist: JtiDenylist | null,
  recordKeyring: RecordKeyring,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // --- Channel guard: mutations restricted to web sessions ---
  const channelGuard = requireChannel(AUTH_CHANNELS.WEB);
  routes.use("/api/users", channelGuard);
  routes.use("/api/users/status-counts", channelGuard);
  routes.use("/api/users/member-summary", channelGuard);
  routes.use("/api/users/:userId", channelGuard);
  routes.use("/api/users/:userId/role", channelGuard);
  routes.use("/api/users/:userId/deactivate", channelGuard);
  routes.use("/api/users/:userId/password/reset", channelGuard);

  // --- Permission guards ---
  routes.use("/api/users", requirePermission(PERMISSIONS.USER_READ));
  routes.use("/api/users", onlyMethods(["POST"], requirePermission(PERMISSIONS.USER_CREATE)));
  routes.use("/api/users/status-counts", requirePermission(PERMISSIONS.USER_READ));
  routes.use("/api/users/member-summary", requirePermission(PERMISSIONS.USER_READ));
  routes.use("/api/users/:userId", requirePermission(PERMISSIONS.USER_READ));
  routes.use(
    "/api/users/:userId",
    onlyMethods(["PATCH"], requirePermission(PERMISSIONS.USER_UPDATE)),
  );
  routes.use("/api/users/:userId/role", requirePermission(PERMISSIONS.ROLE_ASSIGN));
  routes.use("/api/users/:userId/deactivate", requirePermission(PERMISSIONS.USER_SUSPEND));
  routes.use("/api/users/:userId/password/reset", requirePermission(PERMISSIONS.USER_UPDATE));

  // --- Audit declarations ---
  routes.use("/api/users", auditAction("insert", "users"));
  routes.use("/api/users/:userId", auditAction("update", "users"));
  routes.use("/api/users/:userId/role", auditAction("update", "user_roles"));
  routes.use("/api/users/:userId/deactivate", auditAction("update", "users"));
  routes.use("/api/users/:userId/password/reset", auditAction("update", "member_credentials"));

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

  routes.openapi(getUserMemberSummaryRoute, async (c) => {
    const auth = requireAuth(c);

    const summary = await withTenantTx(database, tenantFrom(c), (tx) =>
      getUserMemberSummary(tx, auth.schoolId),
    );

    return c.json({ ...summary, default_password: DEFAULT_MEMBER_PASSWORD }, 200);
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
    // Creating a user and linking them to students are separate powers: user:create alone does
    // not let a caller attach a parent to a child.
    if (body.children?.length) requirePermissionIn(c, PERMISSIONS.PARENT_LINK);
    // Likewise filling in the new parent's record: that is studentRecord:update.
    if (body.records?.length) requirePermissionIn(c, PERMISSIONS.STUDENT_RECORD_UPDATE);

    const row = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const { records, ...account } = body;
      const created = await createUserService(tx, auth.schoolId, {
        ...account,
        role: account.role as Role,
      });
      if (records?.length) {
        await writeAnswers(
          tx,
          auth.schoolId,
          { kind: "parent", id: created.id },
          auth.userId,
          records,
          recordKeyring,
        );
      }
      return created;
    });

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

  routes.openapi(resetPasswordRoute, async (c) => {
    const auth = requireAuth(c);
    const { userId } = c.req.valid("param");
    const tenant = tenantFrom(c);

    const reset = await withTenantTx(database, tenant, (tx) => resetMemberPassword(tx, userId));
    if (!reset) {
      throw new HTTPException(404, { message: "This account has no member ID or password." });
    }

    // Whoever knew the old password is signed out with it.
    await adminRevokeUserSessions({
      database,
      denylist,
      tenant: { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") },
      targetUserId: userId,
      reason: REVOCATION_REASONS.ADMIN_REVOKE_ALL_DEVICES,
      log: c.get("log"),
      userAgent: c.req.header("User-Agent") ?? null,
      clientIp: clientIpFrom(c),
    });

    return c.json({ usernames: reset.usernames, default_password: DEFAULT_MEMBER_PASSWORD }, 200);
  });

  return routes;
}
