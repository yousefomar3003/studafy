import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";

import {
  createInvitationBodySchema,
  createInvitationResponseSchema,
  invitationIdPathParams,
  invitationListQuerySchema,
  invitationListResponseSchema,
  invitationVerificationPathParams,
  invitationVerificationResponseSchema,
  revokeInvitationResponseSchema,
  regenerateInvitationResponseSchema,
} from "./schemas";
import { createInvitationService, listInvitations } from "./service";
import { throwInvitationVerificationFailure, verifyInvitationToken } from "./verification";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { Role } from "@studafy/constants";

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const createInvitationRoute = createRoute({
  method: "post",
  path: "/api/invitations",
  tags: ["Invitations"],
  operationId: "createInvitation",
  summary: "Create a user invitation",
  description:
    "Issues a new invitation for a given email and role. Returns a one-time-use token that " +
    "must be delivered to the invitee (e.g. via email). The raw token is never persisted " +
    "server-side; only its SHA-256 hash is stored. An `invitation.sent` event is emitted " +
    "into the outbox for downstream email dispatch.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createInvitationBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "Invitation created. The raw token is included in this response only.",
        schema: createInvitationResponseSchema,
      },
    },
    [400, 401, 403, 409, 429, 500],
  ),
});

const revokeInvitationRoute = createRoute({
  method: "post",
  path: "/api/invitations/{id}/revoke",
  tags: ["Invitations"],
  operationId: "revokeInvitation",
  summary: "Revoke a pending invitation",
  description:
    "Immediately invalidates a pending invitation by setting revoked_at. " +
    "The old token stops working on the next acceptance attempt. " +
    "An `invitation.revoked` event is emitted into the outbox.",
  security: [{ bearerAuth: [] }],
  request: {
    params: invitationIdPathParams,
  },
  responses: standardResponses(
    {
      200: {
        description: "Invitation revoked.",
        schema: revokeInvitationResponseSchema,
      },
    },
    [401, 403, 404, 429, 500],
  ),
});

const regenerateInvitationRoute = createRoute({
  method: "post",
  path: "/api/invitations/{id}/regenerate",
  tags: ["Invitations"],
  operationId: "regenerateInvitation",
  summary: "Regenerate a pending invitation",
  description:
    "Atomically revokes the current invitation and issues a new one with a fresh token. " +
    "The old token stops working immediately. The new raw token is included in the response " +
    "and must be delivered to the invitee. " +
    "Both `invitation.revoked` and `invitation.sent` events are emitted.",
  security: [{ bearerAuth: [] }],
  request: {
    params: invitationIdPathParams,
  },
  responses: standardResponses(
    {
      201: {
        description:
          "Old invitation revoked, new invitation created. The raw token is included in this response only.",
        schema: regenerateInvitationResponseSchema,
      },
    },
    [401, 403, 404, 429, 500],
  ),
});

const listInvitationsRoute = createRoute({
  method: "get",
  path: "/api/invitations",
  tags: ["Invitations"],
  operationId: "listInvitations",
  summary: "List invitations",
  description:
    "Paginated, cursor-based list of invitations for the authenticated school. Each row carries a " +
    "lifecycle status (pending, expired, consumed, revoked) derived from " +
    "expires_at/consumed_at/revoked_at — not a stored column. Supports filtering by status, role, " +
    "and a partial email match.",
  security: [{ bearerAuth: [] }],
  request: { query: invitationListQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of invitations.",
        schema: invitationListResponseSchema,
      },
    },
    [400, 401, 403, 429, 500],
  ),
});

const verifyInvitationRoute = createRoute({
  method: "get",
  path: "/api/auth/invitations/{token}/verify",
  tags: ["Invitations"],
  operationId: "verifyInvitation",
  summary: "Verify an invitation token",
  description:
    "Resolves an invitation bearer token without provisioning an account. Valid responses expose " +
    "only an obfuscated email hint and school name; unusable invitations use standardized problem details.",
  security: [],
  request: { params: invitationVerificationPathParams },
  responses: standardResponses(
    {
      200: {
        description: "The invitation is active and can proceed to onboarding.",
        schema: invitationVerificationResponseSchema,
      },
    },
    [400, 409, 429, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route group factory
// ---------------------------------------------------------------------------

/**
 * Build the invitation route group.
 *
 * Requires: database, logger. The caller mounts this under the authenticated prefix so
 * jwtAuthMiddleware has already run by the time the handler fires.
 */
export function invitationRoutes(db: Database, _logger: Logger): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/invitations", auditAction("insert", "invitations"));
  routes.use("/api/invitations/:id/revoke", auditAction("update", "invitations"));
  routes.use("/api/invitations/:id/regenerate", auditAction("update", "invitations"));

  routes.openapi(verifyInvitationRoute, async (c) => {
    const { token } = c.req.valid("param");
    const result = await verifyInvitationToken(db, token);

    if (result.state !== "VALID") {
      throwInvitationVerificationFailure(result);
    }

    return c.json(
      { state: "valid" as const, emailHint: result.emailHint, schoolName: result.schoolName },
      200,
    );
  });

  routes.openapi(listInvitationsRoute, async (c) => {
    const auth = requireAuth(c);

    if (!auth.roles.includes("SUPER_ADMIN") && !auth.roles.includes("ORG_ADMIN")) {
      throw new HTTPException(403, {
        message: "You do not have permission to list invitations",
      });
    }

    const query = c.req.valid("query");

    const { rows, next_cursor } = await withTenantTx(
      db,
      { schoolId: auth.schoolId, userId: auth.userId },
      (tx) =>
        listInvitations(tx, auth.schoolId, {
          limit: query.limit,
          cursor: query.cursor,
          status: query.status,
          role: query.role as Role | undefined,
          search: query.search,
        }),
    );

    return c.json(
      {
        invitations: rows.map((row) => ({
          id: row.id,
          email: row.email,
          role: row.role,
          status: row.status,
          expires_at: row.expiresAt.toISOString(),
          revoked_at: row.revokedAt?.toISOString() ?? null,
          consumed_at: row.consumedAt?.toISOString() ?? null,
          invited_by_user_id: row.invitedByUserId,
          created_at: row.createdAt.toISOString(),
        })),
        next_cursor,
      },
      200,
    );
  });

  routes.openapi(createInvitationRoute, async (c) => {
    const auth = requireAuth(c);
    const log = c.get("log");

    // Authorization: the caller must hold the USER_INVITE permission.
    if (!auth.roles.includes("SUPER_ADMIN") && !auth.roles.includes("ORG_ADMIN")) {
      throw new HTTPException(403, {
        message: "You do not have permission to create invitations",
      });
    }

    const body = c.req.valid("json");

    const result = await withTenantTx(
      db,
      { schoolId: auth.schoolId, userId: auth.userId },
      async (tx) => {
        const service = createInvitationService({
          defaultExpiryDays: 7,
        });

        return service.create(
          tx,
          {
            email: body.email,
            role: body.role,
            expiryDays: body.expiry_days,
            invitedByUserId: auth.userId,
          },
          log,
        );
      },
    );

    return c.json(
      {
        invitation: {
          id: result.invitationId,
          email: result.email,
          role: result.role,
          expires_at: result.expiresAt.toISOString(),
          created_at: new Date().toISOString(),
        },
        token: result.token,
      },
      201,
    );
  });

  routes.openapi(revokeInvitationRoute, async (c) => {
    const auth = requireAuth(c);
    const log = c.get("log");

    if (!auth.roles.includes("SUPER_ADMIN") && !auth.roles.includes("ORG_ADMIN")) {
      throw new HTTPException(403, {
        message: "You do not have permission to revoke invitations",
      });
    }

    const { id } = c.req.valid("param");

    const result = await withTenantTx(
      db,
      { schoolId: auth.schoolId, userId: auth.userId },
      async (tx) => {
        const service = createInvitationService();
        return service.revoke(tx, id, log);
      },
    );

    return c.json(
      {
        id: result.invitationId,
        email: result.email,
        role: result.role,
        revoked_at: result.revokedAt.toISOString(),
      },
      200,
    );
  });

  routes.openapi(regenerateInvitationRoute, async (c) => {
    const auth = requireAuth(c);
    const log = c.get("log");

    if (!auth.roles.includes("SUPER_ADMIN") && !auth.roles.includes("ORG_ADMIN")) {
      throw new HTTPException(403, {
        message: "You do not have permission to regenerate invitations",
      });
    }

    const { id } = c.req.valid("param");

    const result = await withTenantTx(
      db,
      { schoolId: auth.schoolId, userId: auth.userId },
      async (tx) => {
        const service = createInvitationService({ defaultExpiryDays: 7 });
        return service.regenerate(tx, id, log);
      },
    );

    return c.json(
      {
        invitation: {
          id: result.invitationId,
          email: result.email,
          role: result.role,
          expires_at: result.expiresAt.toISOString(),
          created_at: new Date().toISOString(),
        },
        token: result.token,
        revoked_invitation_id: result.revokedInvitationId,
      },
      201,
    );
  });

  return routes;
}
