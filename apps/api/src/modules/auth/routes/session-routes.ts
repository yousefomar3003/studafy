import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { clearRefreshCookie, deliverTokenPair, readPresentedToken } from "../delivery";
import { REVOCATION_REASONS, revokeAndDenylist } from "../services/revocation-service";
import {
  deregisterDevice,
  listActiveSessions,
  listUserDevices,
  resolveFamilyByToken,
  rotateRefreshToken,
} from "../services/session-service";

import type { Database } from "../../../db/client";
import type { SecurityEventSink } from "../../../lib/security/securityEventSink";
import type { AppEnv } from "../../../middleware/requestId";
import type { JtiDenylist } from "../denylist";
import type { RevocationReason, RevocationScope } from "../services/revocation-service";
import type { SessionTokenConfig } from "../services/session-service";
import type { Context } from "hono";

/**
 * Session lifecycle endpoints (ST-071).
 *
 * Two of these are unauthenticated and three are not, and the split is not arbitrary. `/refresh` and
 * `/logout` are reached *because* the access token is gone or expired — requiring one would make
 * them unreachable exactly when they are needed — so the refresh token is the credential and they
 * are listed in DEFAULT_PUBLIC_PATHS in middleware/jwtAuth.ts. Everything else here manages sessions
 * from a position of established identity and sits behind the normal /api/* authentication boundary.
 *
 * That distinction is why `security: []` appears on the first two route definitions: it tells the
 * generated OpenAPI document the truth about what a client needs to call them, rather than
 * inheriting a global security requirement that does not apply.
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const tokenResponseSchema = z
  .object({
    access_token: z
      .string()
      .openapi({ description: "RS256 JWT. Send as `Authorization: Bearer`." }),
    token_type: z.literal("Bearer"),
    expires_in: z.number().int().openapi({ description: "Access-token lifetime in seconds." }),
    session_id: z.uuid().openapi({ description: "Identifies this session in the session list." }),
    refresh_token: z
      .string()
      .optional()
      .openapi({
        description:
          "The next refresh token. Present only for `mobile` and `api` sessions. Web sessions " +
          "receive it as an HttpOnly, Secure, SameSite=Strict cookie instead and never see it here.",
      }),
  })
  .openapi("TokenPair");

const refreshRequestSchema = z
  .object({
    refresh_token: z.string().min(1).optional().openapi({
      description:
        "The current refresh token. Omit for web sessions, which send it automatically as a cookie.",
    }),
  })
  .openapi("RefreshRequest");

const sessionSchema = z
  .object({
    id: z.uuid(),
    device_id: z.uuid().nullable(),
    device_name: z.string().nullable(),
    channel: z.enum(["web", "mobile", "api"]),
    user_agent: z.string().nullable(),
    ip_address: z.string().nullable(),
    issued_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
  })
  .openapi("Session");

const sessionListSchema = z.object({ sessions: z.array(sessionSchema) }).openapi("SessionList");

const logoutResponseSchema = z.object({ ended: z.literal(true) }).openapi("LogoutResult");

const revocationSchema = z
  .object({
    revoked: z.number().int().openapi({ description: "Tokens revoked." }),
    denylisted: z
      .number()
      .int()
      .openapi({
        description:
          "Access tokens written to the denylist. Never exceeds `revoked`; sessions predating the " +
          "access-token tracking added in ST-072 have no identifier to deny.",
      }),
  })
  .openapi("RevocationResult");

const deviceSchema = z
  .object({
    id: z.uuid(),
    platform: z.string(),
    last_seen: z.iso.datetime(),
    created_at: z.iso.datetime(),
    active_session_count: z
      .number()
      .int()
      .openapi({ description: "Live sessions currently bound to this device." }),
  })
  .openapi("Device");

const deviceListSchema = z.object({ devices: z.array(deviceSchema) }).openapi("DeviceList");

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

/**
 * Audit declarations sit immediately above the route each one covers.
 *
 * They are named constants rather than inline arguments at the `routes.use(...)` calls below because
 * the mount point spells a path in Hono's `:param` form while the route definition spells it in
 * OpenAPI's `{param}` form — keeping the declaration next to the definition means the two spellings
 * are never read apart, which is how one of them ends up wrong. tests/audit-coverage.test.ts anchors
 * on the OpenAPI path string within a fixed window, so this placement is also what it verifies.
 *
 * `login` for refresh, not `logout`: a rotation mints a new access token, which is the same
 * authorization event a login produces. `app.audit_action` has no finer-grained label, and adding
 * one is a schema change this ticket does not need.
 */
const refreshAudit = auditAction("login", "refresh_tokens");

const refreshRoute = createRoute({
  method: "post",
  path: "/api/auth/refresh",
  tags: ["Auth"],
  operationId: "refreshSession",
  summary: "Rotate a refresh token",
  description:
    "Consumes the presented refresh token and issues a replacement pair. The presented token is " +
    "invalidated unconditionally — a token is valid exactly once. Re-presenting an already-rotated " +
    "token is treated as theft: the entire token family is revoked and the session ends.",
  security: [],
  request: {
    body: {
      required: false,
      content: { "application/json": { schema: refreshRequestSchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "A new token pair.", schema: tokenResponseSchema } },
    [400, 401, 429, 500],
  ),
});

const logoutAudit = auditAction("logout", "refresh_tokens");

const logoutRoute = createRoute({
  method: "post",
  path: "/api/auth/logout",
  tags: ["Auth"],
  operationId: "logout",
  summary: "End the current session",
  description:
    "Revokes the token family the presented refresh token belongs to and clears the refresh " +
    "cookie. Always answers 200, whether or not the token was valid, was already revoked, or was " +
    "absent entirely — reporting otherwise would let a caller probe for live sessions.",
  security: [],
  request: {
    body: {
      required: false,
      content: { "application/json": { schema: refreshRequestSchema } },
    },
  },
  responses: standardResponses(
    // A 200 with a constant body rather than a 204. The response is uniform by design, so there is
    // nothing to omit, and a body keeps every route in this app answering in the same shape.
    { 200: { description: "The session is ended.", schema: logoutResponseSchema } },
    [400, 429, 500],
  ),
});

const listSessionsRoute = createRoute({
  method: "get",
  path: "/api/auth/sessions",
  tags: ["Auth"],
  operationId: "listSessions",
  summary: "List active sessions",
  description:
    "Every live session for the authenticated user, one entry per session rather than per token — " +
    "a long-lived session has rotated many times and each rotation left a row behind.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The caller's active sessions.", schema: sessionListSchema } },
    [401, 429, 500],
  ),
});

const revokeSessionAudit = auditAction("logout", "refresh_tokens");

const revokeSessionRoute = createRoute({
  method: "delete",
  path: "/api/auth/sessions/{sessionId}",
  tags: ["Auth"],
  operationId: "revokeSession",
  summary: "Terminate one session",
  description:
    "Revokes the whole token family behind the named session. Answers 200 with `revoked: 0` when " +
    "the session does not exist or belongs to someone else — the two are indistinguishable by " +
    "design, so a caller cannot enumerate other users' session ids.",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ sessionId: z.uuid() }) },
  responses: standardResponses(
    { 200: { description: "How many tokens were revoked.", schema: revocationSchema } },
    [400, 401, 429, 500],
  ),
});

const revokeDeviceAudit = auditAction("logout", "refresh_tokens");

const revokeDeviceRoute = createRoute({
  method: "delete",
  path: "/api/auth/devices/{deviceId}/sessions",
  tags: ["Auth"],
  operationId: "revokeDeviceSessions",
  summary: "Terminate every session on a device",
  description:
    "Revokes all live sessions bound to the named device, leaving the device registered. Use " +
    "`DELETE /api/auth/devices/{deviceId}` instead to also deregister the device itself.",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ deviceId: z.uuid() }) },
  responses: standardResponses(
    { 200: { description: "How many tokens were revoked.", schema: revocationSchema } },
    [400, 401, 429, 500],
  ),
});

const listDevicesRoute = createRoute({
  method: "get",
  path: "/api/auth/devices",
  tags: ["Auth"],
  operationId: "listDevices",
  summary: "List registered devices",
  description:
    "Every device registered to the authenticated user that has not been revoked, with the number " +
    "of live sessions on each. Distinct from `/api/auth/sessions`, which lists logins rather than " +
    "the hardware they happened on — one device may carry several sessions.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The caller's registered devices.", schema: deviceListSchema } },
    [401, 429, 500],
  ),
});

const revokeDeviceEntirelyAudit = auditAction("logout", "refresh_tokens");

const revokeDeviceEntirelyRoute = createRoute({
  method: "delete",
  path: "/api/auth/devices/{deviceId}",
  tags: ["Auth"],
  operationId: "revokeDevice",
  summary: "Revoke a device entirely",
  description:
    "Terminates every session on the device and deregisters it, so it stops receiving push " +
    "notifications as well as losing its logins. Answers 200 with `revoked: 0` when the device " +
    "does not exist or belongs to someone else — the two are indistinguishable by design.",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ deviceId: z.uuid() }) },
  responses: standardResponses(
    { 200: { description: "How many tokens were revoked.", schema: revocationSchema } },
    [400, 401, 429, 500],
  ),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * @param denylist Redis-backed access-token denylist, or null when Redis is unconfigured. Threaded
 *   in rather than constructed here so it is the *same* instance jwtAuth.ts checks against — two
 *   clients over one Redis would work, but sharing makes the write-side and read-side of the
 *   revocation boundary provably the same keyspace.
 */
export function sessionRoutes(
  database: Database,
  config: SessionTokenConfig,
  denylist: JtiDenylist | null,
  eventSink?: SecurityEventSink | null,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  /** Shared teardown for the three authenticated revocation routes. */
  const revokeForCaller = async (
    c: Context<AppEnv>,
    scope: RevocationScope,
    reason: RevocationReason,
  ): Promise<{ revoked: number; denylisted: number }> => {
    const auth = requireAuth(c);
    const result = await revokeAndDenylist({
      database,
      denylist,
      tenant: tenantFrom(c),
      targetUserId: auth.userId,
      scope,
      reason,
      log: c.get("log"),
      userAgent: c.req.header("User-Agent") ?? null,
      clientIp: clientIpFrom(c),
    });

    return { revoked: result.revokedTokens, denylisted: result.denylistedJtis };
  };

  // Mount the audit declarations defined alongside each route above. The revocation paths write
  // their own app.audit_logs rows from inside the service transaction — revocation and its audit
  // record have to be atomic — so these carry the declaration half of that contract into the request
  // context, which is what tests/audit-coverage.test.ts gates on.
  routes.use("/api/auth/refresh", refreshAudit);
  routes.use("/api/auth/logout", logoutAudit);
  routes.use("/api/auth/sessions/:sessionId", revokeSessionAudit);
  routes.use("/api/auth/devices/:deviceId/sessions", revokeDeviceAudit);
  routes.use("/api/auth/devices/:deviceId", revokeDeviceEntirelyAudit);

  routes.openapi(refreshRoute, async (c) => {
    const presented = readPresentedToken(c, c.req.valid("json"));
    if (presented === undefined) {
      // A 400, not a 401: nothing was presented to authenticate, so this is a malformed request
      // rather than a rejected credential. Answering 401 would send a client with a missing cookie
      // into a refresh loop against an endpoint that will never accept it. Thrown rather than
      // returned so it goes through errorHandlerMiddleware and gets the same problem+json envelope
      // and request_id correlation as every other failure.
      throw new HTTPException(400, { message: "No refresh token was presented" });
    }

    const issued = await rotateRefreshToken(database, config, {
      presentedToken: presented,
      requestId: c.get("requestId"),
      device: deviceContextFrom(c),
      log: c.get("log"),
      eventSink,
    });

    return c.json(deliverTokenPair(c, issued), 200);
  });

  routes.openapi(logoutRoute, async (c) => {
    const presented = readPresentedToken(c, c.req.valid("json"));
    const requestId = c.get("requestId");

    if (presented !== undefined) {
      // Resolved first, then revoked. This route is unauthenticated — it is listed in
      // DEFAULT_PUBLIC_PATHS precisely because it is reached when the access token is already gone —
      // so there is no auth context to take a tenant from, and the presented token is the only thing
      // that can supply one.
      const family = await resolveFamilyByToken(database, presented, requestId);

      if (family !== undefined) {
        // The jtis come from the revoked rows rather than from an Authorization header. That is not
        // just convenient: a client logging out after its access token expired sends no bearer at
        // all, and one logging out from a different tab may send a token from a different session.
        // The family's own rows are the authoritative record of what this session minted.
        await revokeAndDenylist({
          database,
          denylist,
          tenant: { schoolId: family.schoolId, userId: family.userId, requestId },
          targetUserId: family.userId,
          scope: { kind: "family", familyId: family.familyId },
          reason: REVOCATION_REASONS.LOGOUT_SINGLE,
          log: c.get("log"),
          userAgent: family.userAgent,
          clientIp: family.ipAddress,
        });
      }
    }

    // Cleared unconditionally, including when no token was presented. A stale cookie the server
    // cannot resolve is exactly the case where the browser most needs to be told to drop it.
    clearRefreshCookie(c);
    return c.json({ ended: true as const }, 200);
  });

  routes.openapi(listSessionsRoute, async (c) => {
    const auth = requireAuth(c);

    const sessions = await withTenantTx(database, tenantFrom(c), (tx) =>
      listActiveSessions(tx, auth.userId),
    );

    return c.json(
      {
        sessions: sessions.map((session) => ({
          id: session.id,
          device_id: session.deviceId,
          device_name: session.deviceName,
          channel: session.channel,
          user_agent: session.userAgent,
          ip_address: session.ipAddress,
          issued_at: session.issuedAt.toISOString(),
          expires_at: session.expiresAt.toISOString(),
        })),
      },
      200,
    );
  });

  routes.openapi(listDevicesRoute, async (c) => {
    const auth = requireAuth(c);

    const devices = await withTenantTx(database, tenantFrom(c), (tx) =>
      listUserDevices(tx, auth.userId),
    );

    return c.json(
      {
        devices: devices.map((device) => ({
          id: device.id,
          platform: device.platform,
          last_seen: device.lastSeen.toISOString(),
          created_at: device.createdAt.toISOString(),
          active_session_count: device.activeSessionCount,
        })),
      },
      200,
    );
  });

  routes.openapi(revokeSessionRoute, async (c) => {
    const { sessionId } = c.req.valid("param");

    return c.json(
      await revokeForCaller(c, { kind: "session", sessionId }, REVOCATION_REASONS.REVOKE_SESSION),
      200,
    );
  });

  routes.openapi(revokeDeviceRoute, async (c) => {
    const { deviceId } = c.req.valid("param");

    return c.json(
      await revokeForCaller(c, { kind: "device", deviceId }, REVOCATION_REASONS.REVOKE_DEVICE),
      200,
    );
  });

  routes.openapi(revokeDeviceEntirelyRoute, async (c) => {
    const { deviceId } = c.req.valid("param");
    const auth = requireAuth(c);

    const result = await revokeForCaller(
      c,
      { kind: "device", deviceId },
      REVOCATION_REASONS.REVOKE_DEVICE,
    );

    // Deregistration is separate from session teardown and runs after it. The order matters on
    // failure: sessions revoked but the device still registered is a device that receives push and
    // cannot log in, whereas the reverse is a device that is silent but still authenticated. The
    // first is recoverable by retrying; the second is the security hole.
    await withTenantTx(database, tenantFrom(c), (tx) =>
      deregisterDevice(tx, auth.userId, deviceId),
    );

    return c.json(result, 200);
  });

  return routes;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tenant context for an authenticated request.
 *
 * `userId` is always supplied, and that is mandatory rather than tidy: the restrictive
 * `refresh_tokens_owner` policy calls `app.current_user_id()`, which raises 42704 when the
 * `app.user_id` GUC is unset. A tenant transaction opened without it would fail on the first
 * statement touching this table.
 */
function tenantFrom(c: Context<AppEnv>): {
  schoolId: string;
  userId: string;
  requestId?: string;
} {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

/**
 * Device metadata observed on this request.
 *
 * Only the observational fields. `deviceId` is deliberately absent: it is carried forward from the
 * session being rotated, so that a rotation cannot move a session onto a different device.
 */
function deviceContextFrom(c: Context<AppEnv>): {
  userAgent: string | null;
  ipAddress: string | null;
} {
  return {
    userAgent: c.req.header("User-Agent") ?? null,
    ipAddress: clientIpFrom(c),
  };
}

/**
 * The client address, or null.
 *
 * Null rather than a placeholder string when the address cannot be determined: the column is `inet`,
 * and PostgreSQL rejects a non-address value for the whole statement. The security event sink hit
 * the same edge (see toInetOrNull in lib/security/securityEventSink.ts) — this is the same guard for
 * the same reason.
 */
function clientIpFrom(c: Context<AppEnv>): string | null {
  const forwarded = c.req.header("X-Forwarded-For");
  if (forwarded === undefined) return null;

  const first = forwarded.split(",")[0]?.trim();
  return first !== undefined && first.length > 0 ? first : null;
}
