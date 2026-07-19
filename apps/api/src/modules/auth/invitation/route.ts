import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";

import { createInvitationBodySchema, createInvitationResponseSchema } from "./schemas";
import { createInvitationService } from "./service";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";

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

  return routes;
}
