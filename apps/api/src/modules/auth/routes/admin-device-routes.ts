import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import { adminRevokeUserSessions, REVOCATION_REASONS } from "../services/revocation-service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { JtiDenylist } from "../denylist";
import type { Context } from "hono";

/**
 * Administrative device revocation (ST-072).
 *
 * The first routes in this application that act on a user other than the caller, and everything
 * unusual about them follows from that.
 *
 * They are the first consumers of requirePermission (middleware/authz.ts). Until now the only
 * authorization in the app was the `/api/*` prefix boundary, which proves a caller is *someone* and
 * says nothing about what they may do — adequate while every route operated on the caller's own
 * rows, and not adequate here.
 *
 * They are also the first consumers of the SECURITY DEFINER maintenance path 000029 left open.
 * The RESTRICTIVE refresh_tokens_owner policy makes another user's sessions unreachable from
 * studafy_app, so the revocation runs through app.admin_revoke_user_sessions — see
 * services/revocation-service.ts and migration 000030's header for why that is sound rather than a
 * hole in the tenant fence.
 *
 * CROSS-TENANT TARGETS ANSWER 200 WITH ZERO, NOT 404. An administrator in school A naming a user in
 * school B gets the same empty result as one naming a uuid that exists nowhere, because
 * app.admin_revoke_user_sessions scopes every statement to current_setting('app.school_id'). This is
 * deliberate and is the same non-enumerable convention the self-service routes use: distinguishing
 * the two would hand any org admin an oracle for probing which user ids exist in other tenants,
 * which is precisely the cross-tenant ID harvesting NFR-05 exists to prevent.
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const adminRevocationSchema = z
  .object({
    revoked: z.number().int().openapi({ description: "Refresh tokens revoked." }),
    denylisted: z.number().int().openapi({ description: "Access tokens denylisted." }),
  })
  .openapi("AdminRevocationResult");

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const revokeAllAudit = auditAction("logout", "refresh_tokens");

const revokeAllDevicesRoute = createRoute({
  method: "delete",
  path: "/api/admin/users/{userId}/devices",
  tags: ["Admin"],
  operationId: "adminRevokeAllDevices",
  summary: "Force a global logout for a user",
  description:
    "Revokes every live token family the named user holds, on every device, and denylists the " +
    "access tokens they minted. Use for a compromised account. Answers 200 with `revoked: 0` when " +
    "the user has no live sessions, does not exist, or belongs to another tenant.",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ userId: z.uuid() }) },
  responses: standardResponses(
    { 200: { description: "How much was torn down.", schema: adminRevocationSchema } },
    [400, 401, 403, 429, 500],
  ),
});

const revokeOneAudit = auditAction("logout", "refresh_tokens");

const revokeOneDeviceRoute = createRoute({
  method: "delete",
  path: "/api/admin/users/{userId}/devices/{deviceId}",
  tags: ["Admin"],
  operationId: "adminRevokeDevice",
  summary: "Revoke one of a user's devices",
  description:
    "Terminates every session on the named device and deregisters it, leaving the user's other " +
    "devices signed in. Use when one device is lost rather than when an account is compromised.",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ userId: z.uuid(), deviceId: z.uuid() }) },
  responses: standardResponses(
    { 200: { description: "How much was torn down.", schema: adminRevocationSchema } },
    [400, 401, 403, 429, 500],
  ),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function adminDeviceRoutes(
  database: Database,
  denylist: JtiDenylist | null,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Channel guard: administrative mutations are restricted to web sessions. Mobile and API
  // tokens are rejected regardless of role — the threat model is the token surface, not the role.
  // Runs before the permission guard for early rejection.
  const channelGuard = requireChannel(AUTH_CHANNELS.WEB);
  routes.use("/api/admin/users/:userId/devices", channelGuard);
  routes.use("/api/admin/users/:userId/devices/:deviceId", channelGuard);

  // USER_SUSPEND rather than a new permission constant. Terminating every credential a user holds is
  // operationally indistinguishable from suspending them — both end the account's ability to act —
  // and the matrix in @studafy/constants grants it to exactly the roles that should have this reach.
  // Minting a SESSION_REVOKE permission would widen a shared package for a distinction no role
  // definition currently draws.
  const guard = requirePermission(PERMISSIONS.USER_SUSPEND);
  routes.use("/api/admin/users/:userId/devices", guard);
  routes.use("/api/admin/users/:userId/devices/:deviceId", guard);

  routes.use("/api/admin/users/:userId/devices", revokeAllAudit);
  routes.use("/api/admin/users/:userId/devices/:deviceId", revokeOneAudit);

  routes.openapi(revokeAllDevicesRoute, async (c) => {
    const { userId } = c.req.valid("param");
    return c.json(await revokeFor(c, userId, null), 200);
  });

  routes.openapi(revokeOneDeviceRoute, async (c) => {
    const { userId, deviceId } = c.req.valid("param");
    return c.json(await revokeFor(c, userId, deviceId), 200);
  });

  /**
   * Tear down a target user's sessions on the calling administrator's behalf.
   *
   * The tenant context is the *administrator's*, never the target's. That is what makes the audit
   * row name the right actor — middleware/auditEmitter.ts reads actor_id from the app.user_id GUC —
   * and it is why the revocation has to go through the SECURITY DEFINER function rather than simply
   * opening the transaction as the victim, which would have been the easy way past the RLS policy
   * and would have filed every forced logout under the wrong name.
   */
  async function revokeFor(
    c: Context<AppEnv>,
    targetUserId: string,
    targetDeviceId: string | null,
  ): Promise<{ revoked: number; denylisted: number }> {
    const auth = requireAuth(c);

    const result = await adminRevokeUserSessions({
      database,
      denylist,
      tenant: { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") },
      targetUserId,
      targetDeviceId,
      reason:
        targetDeviceId === null
          ? REVOCATION_REASONS.ADMIN_REVOKE_ALL_DEVICES
          : REVOCATION_REASONS.ADMIN_REVOKE_DEVICE,
      log: c.get("log"),
      userAgent: c.req.header("User-Agent") ?? null,
      clientIp: clientIpFrom(c),
    });

    c.get("log").info(
      {
        event: "admin_session_revocation",
        target_user_id: targetUserId,
        target_device_id: targetDeviceId,
        revoked_token_count: result.revokedTokens,
        denylisted_jti_count: result.denylistedJtis,
      },
      "administrator revoked sessions for another user",
    );

    return { revoked: result.revokedTokens, denylisted: result.denylistedJtis };
  }

  return routes;
}

/**
 * The client address, or null.
 *
 * Null rather than a placeholder when the address cannot be determined: the column is `inet` and
 * PostgreSQL rejects a non-address value for the whole statement. Same guard, for the same reason,
 * as clientIpFrom in session-routes.ts and toInetOrNull in lib/security/securityEventSink.ts.
 */
function clientIpFrom(c: Context<AppEnv>): string | null {
  const forwarded = c.req.header("X-Forwarded-For");
  if (forwarded === undefined) return null;

  const first = forwarded.split(",")[0]?.trim();
  return first !== undefined && first.length > 0 ? first : null;
}
