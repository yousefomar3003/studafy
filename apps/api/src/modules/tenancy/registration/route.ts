import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

import { auditAction } from "../../../middleware/auditEmitter";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";

import { registerSchoolBodySchema, registerSchoolResponseSchema } from "./schemas";
import { registerSchool } from "./service";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const registerSchoolRoute = createRoute({
  method: "post",
  path: "/api/schools/register",
  tags: ["Schools"],
  operationId: "registerSchool",
  summary: "Register a new school",
  description:
    "Public self-registration endpoint. Validates the request, verifies the captcha token, " +
    "and atomically creates the school (status=registered), its first ORG_ADMIN user, and an " +
    "activation invitation. Duplicate school email or slug are rejected with clear error codes. " +
    "The raw invitation token is returned exactly once in this response.",
  security: [],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: registerSchoolBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "School registered. The invitation token is included in this response only.",
        schema: registerSchoolResponseSchema,
      },
    },
    [400, 409, 429, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route group factory
// ---------------------------------------------------------------------------

/**
 * Build the registration route group.
 *
 * Public (no authentication). Requires: database, logger. The caller mounts this
 * under the root so jwtAuthMiddleware's public path exemption applies.
 */
export function registerSchoolRoutes(db: Database, logger: Logger): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/schools/register", auditAction("insert", "schools"));

  routes.openapi(registerSchoolRoute, async (c) => {
    const body = c.req.valid("json");
    const clientIp =
      c.req.header("x-forwarded-for")?.split(",").pop()?.trim() ??
      c.req.header("x-real-ip") ??
      undefined;

    const result = await registerSchool(
      db,
      {
        schoolName: body.school_name,
        slug: body.slug,
        email: body.email,
        countryId: body.country_id,
        defaultCurrencyId: body.default_currency_id,
        adminEmail: body.admin_email,
        adminName: body.admin_name,
        captchaToken: body.captcha_token,
        clientIp,
      },
      logger,
      { captchaSecretKey: process.env.TURNSTILE_SECRET_KEY },
    );

    return c.json(
      {
        school: {
          id: result.schoolId,
          slug: result.slug,
          name: result.schoolName,
          status: "registered" as const,
          created_at: new Date().toISOString(),
        },
        admin: {
          id: result.adminUserId,
          email: result.adminEmail,
          role: "ORG_ADMIN" as const,
        },
        invitation: {
          token: result.invitationToken,
          expires_at: result.invitationExpiresAt.toISOString(),
        },
        verification: {
          token: result.verificationToken,
          expires_at: result.verificationExpiresAt.toISOString(),
        },
      },
      201,
    );
  });

  return routes;
}
