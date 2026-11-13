import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { requireChannel } from "../../middleware/channelGuard";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";
import { AUTH_CHANNELS } from "../auth/channels";

import {
  resendInvitationResultSchema,
  signOutResultSchema,
  statusChangeResultSchema,
  supportActionBodySchema,
  supportUserParamSchema,
  supportUserSchema,
  unlockResultSchema,
} from "./user-support-schemas";
import {
  deactivateAccount,
  getSupportUser,
  reactivateAccount,
  resendInvitation,
  signOutEverywhere,
  unlockAccount,
} from "./user-support-service";

import type { Actor } from "./service";
import type { SupportDeps } from "./user-support-service";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

const TAG = "Platform";
const body = {
  required: true,
  content: { "application/json": { schema: supportActionBodySchema } },
} as const;

const getSupportUserRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/users/{userId}",
  tags: [TAG],
  operationId: "getPlatformSupportUser",
  summary: "One account's support panel",
  description:
    "The account's school, roles, status, activation, sign-in methods and lockout, live session " +
    "count, latest invitation, and linked children or parents (names only). Audited as a read in " +
    "the school and in the operator's own school. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  request: { params: supportUserParamSchema },
  responses: standardResponses(
    { 200: { description: "Support panel.", schema: supportUserSchema } },
    [400, 401, 403, 404, 429, 500],
  ),
});

const resendInvitationRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/users/{userId}/invitation/resend",
  tags: [TAG],
  operationId: "resendPlatformSupportInvitation",
  summary: "Re-send an account's invitation",
  description:
    "Reissues the invitation of an account that has not been activated, emailed to the account's " +
    "own address. The token is never returned. 409 for an activated account, one with no email " +
    "(member-ID accounts get a setup code from their school) or a school that is not active. " +
    "Requires a reason, recorded in the school's audit log and the operator's. Refused for " +
    "another SUPER_ADMIN's account. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  request: { params: supportUserParamSchema, body },
  responses: standardResponses(
    { 200: { description: "Invitation re-sent.", schema: resendInvitationResultSchema } },
    [400, 401, 403, 404, 409, 429, 500],
  ),
});

const signOutRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/users/{userId}/sessions/revoke",
  tags: [TAG],
  operationId: "revokePlatformSupportSessions",
  summary: "Sign an account out everywhere",
  description:
    "Ends every session the account has on every device and denylists their access tokens. " +
    "Requires a reason, recorded in the school's audit log and the operator's. Refused for " +
    "another SUPER_ADMIN's account. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  request: { params: supportUserParamSchema, body },
  responses: standardResponses(
    { 200: { description: "Sessions ended.", schema: signOutResultSchema } },
    [400, 401, 403, 404, 429, 500, 503],
  ),
});

const unlockRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/users/{userId}/unlock",
  tags: [TAG],
  operationId: "unlockPlatformSupportAccount",
  summary: "Clear a member account's sign-in lockout",
  description:
    "Clears the lockout and failed-attempt count left by repeated wrong member passwords. The " +
    "password itself is untouched. Idempotent. Requires a reason, recorded in the school's audit " +
    "log and the operator's. Refused for another SUPER_ADMIN's account. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  request: { params: supportUserParamSchema, body },
  responses: standardResponses(
    { 200: { description: "Lockout cleared.", schema: unlockResultSchema } },
    [400, 401, 403, 404, 429, 500],
  ),
});

const deactivateRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/users/{userId}/deactivate",
  tags: [TAG],
  operationId: "deactivatePlatformSupportAccount",
  summary: "Deactivate an account",
  description:
    "As a school admin's deactivation: the account is suspended, its pending invitations revoked " +
    "and every session ended. 409 for the operator's own account or one already deactivated or " +
    "archived. Requires a reason, recorded in the school's audit log and the operator's. Refused " +
    "for another SUPER_ADMIN's account. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  request: { params: supportUserParamSchema, body },
  responses: standardResponses(
    { 200: { description: "Account deactivated.", schema: statusChangeResultSchema } },
    [400, 401, 403, 404, 409, 429, 500, 503],
  ),
});

const reactivateRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/users/{userId}/reactivate",
  tags: [TAG],
  operationId: "reactivatePlatformSupportAccount",
  summary: "Reactivate a deactivated account",
  description:
    "Returns a deactivated account to active, or to invited if it was never activated. 409 for an " +
    "account that is not deactivated. Requires a reason, recorded in the school's audit log and " +
    "the operator's. Refused for another SUPER_ADMIN's account. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  request: { params: supportUserParamSchema, body },
  responses: standardResponses(
    { 200: { description: "Account reactivated.", schema: statusChangeResultSchema } },
    [400, 401, 403, 404, 409, 429, 500],
  ),
});

function actorFrom(c: Context<AppEnv>): Actor {
  const auth = requireAuth(c);
  return { userId: auth.userId, schoolId: auth.schoolId, requestId: c.get("requestId") };
}

/**
 * Per-account support actions in the platform console. Reading the panel requires `platform:read`
 * and every action `platform:manage` (both SUPER_ADMIN-only); web channel only. Each action writes
 * its own audit rows with the reason (see ./user-support-service.ts); `auditAction()` declares them.
 * There is no impersonation ("log in as") route, by design.
 */
export function platformUserSupportRoutes(deps: SupportDeps): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const manage = requirePermission(PERMISSIONS.PLATFORM_MANAGE);

  const web = requireChannel(AUTH_CHANNELS.WEB);
  routes.use("/api/platform/schools/:schoolId/users/:userId", web);
  routes.use(
    "/api/platform/schools/:schoolId/users/:userId",
    requirePermission(PERMISSIONS.PLATFORM_READ),
    auditAction("read", "users"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/users/:userId/invitation/resend",
    web,
    manage,
    auditAction("update", "invitations"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/users/:userId/sessions/revoke",
    web,
    manage,
    auditAction("logout", "refresh_tokens"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/users/:userId/unlock",
    web,
    manage,
    auditAction("update", "member_credentials"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/users/:userId/deactivate",
    web,
    manage,
    auditAction("update", "users"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/users/:userId/reactivate",
    web,
    manage,
    auditAction("update", "users"),
  );

  routes.openapi(getSupportUserRoute, async (c) => {
    const { schoolId, userId } = c.req.valid("param");
    return c.json(await getSupportUser(deps.database, schoolId, userId, actorFrom(c)), 200);
  });

  routes.openapi(resendInvitationRoute, async (c) => {
    const { schoolId, userId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    return c.json(await resendInvitation(deps, schoolId, userId, reason, actorFrom(c)), 200);
  });

  routes.openapi(signOutRoute, async (c) => {
    const { schoolId, userId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    return c.json(await signOutEverywhere(deps, schoolId, userId, reason, actorFrom(c)), 200);
  });

  routes.openapi(unlockRoute, async (c) => {
    const { schoolId, userId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    return c.json(await unlockAccount(deps, schoolId, userId, reason, actorFrom(c)), 200);
  });

  routes.openapi(deactivateRoute, async (c) => {
    const { schoolId, userId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    return c.json(await deactivateAccount(deps, schoolId, userId, reason, actorFrom(c)), 200);
  });

  routes.openapi(reactivateRoute, async (c) => {
    const { schoolId, userId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    return c.json(await reactivateAccount(deps, schoolId, userId, reason, actorFrom(c)), 200);
  });

  return routes;
}
