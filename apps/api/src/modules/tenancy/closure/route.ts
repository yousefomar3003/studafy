import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS, ROLES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { clientIpFrom } from "../../../lib/client-ip";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";

import {
  currentSchoolResponseSchema,
  schoolClosureBodySchema,
  schoolClosureResponseSchema,
} from "./schemas";
import { closeSchool, getCurrentSchool } from "./service";

import type { SchoolClosureDeps } from "./service";
import type { AppEnv } from "../../../middleware/requestId";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getCurrentSchoolRoute = createRoute({
  method: "get",
  path: "/api/schools/current",
  tags: ["Schools"],
  operationId: "getCurrentSchool",
  summary: "Get the caller's school",
  description:
    "Returns the authenticated user's own school: id, display name and lifecycle status. Any " +
    "role, any channel.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The caller's school.", schema: currentSchoolResponseSchema } },
    [401, 403, 404, 429, 500],
  ),
});

const closeSchoolRoute = createRoute({
  method: "post",
  path: "/api/schools/current/closure",
  tags: ["Schools"],
  operationId: "closeCurrentSchool",
  summary: "Close the caller's school",
  description:
    "School administrator (ORG_ADMIN) only, from the mobile app or the web portal. Archives the " +
    "school: every member is signed out immediately and can no longer sign in, and outstanding " +
    "access tokens are rejected with SCHOOL_SUSPENDED. All of the school's data is retained — " +
    "nothing is erased. `confirm_school_name` must match the school's name (trimmed, " +
    "case-insensitive), otherwise 422 SCHOOL_CLOSURE_NAME_MISMATCH. Irreversible from the app.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: schoolClosureBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The school is closed.", schema: schoolClosureResponseSchema } },
    [400, 401, 403, 404, 409, 422, 429, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route group factory
// ---------------------------------------------------------------------------

/**
 * The caller's own school: read it (`GET /api/schools/current`, any authenticated member) and close
 * it (`POST /api/schools/current/closure`, ORG_ADMIN only). See ./service.ts for what closing does.
 */
export function schoolClosureRoutes(deps: SchoolClosureDeps): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  const closurePath = "/api/schools/current/closure";

  // Mobile is where the school admin's "Delete school" lives; web keeps parity. Never a bare API key.
  routes.use(closurePath, requireChannel(AUTH_CHANNELS.MOBILE, AUTH_CHANNELS.WEB));
  routes.use(closurePath, requirePermission(PERMISSIONS.ORGANIZATION_CLOSE));
  routes.use(closurePath, auditAction("update", "schools"));

  routes.openapi(getCurrentSchoolRoute, async (c) => {
    const auth = requireAuth(c);
    const school = await getCurrentSchool(deps.database, auth.schoolId);
    return c.json(
      {
        id: school.id,
        name: school.name,
        status: school.status as "registered" | "pending" | "active" | "suspended" | "archived",
      },
      200,
    );
  });

  routes.openapi(closeSchoolRoute, async (c) => {
    const auth = requireAuth(c);

    // The permission above is also held by SUPER_ADMIN, who holds every permission. Closing a
    // school is its own administrator's decision; the platform archives schools from its console.
    if (!auth.roles.includes(ROLES.ORG_ADMIN)) {
      throw new CodedHttpException(
        403,
        ERROR_CODES.AUTHZ_FORBIDDEN,
        "Only the school administrator can close the school.",
      );
    }

    const body = c.req.valid("json");
    const result = await closeSchool(deps, {
      schoolId: auth.schoolId,
      userId: auth.userId,
      confirmSchoolName: body.confirm_school_name,
      reason: body.reason || undefined,
      requestId: c.get("requestId"),
      log: c.get("log"),
      userAgent: c.req.header("User-Agent") ?? null,
      clientIp: clientIpFrom(c),
    });

    return c.json(
      {
        school_id: result.schoolId,
        status: result.status,
        closed_at: result.closedAt.toISOString(),
      },
      200,
    );
  });

  return routes;
}
