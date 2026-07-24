import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

import { auditAction } from "../../../middleware/auditEmitter";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { provisionTenant } from "../provisioning/service";

import {
  resendVerificationBodySchema,
  resendVerificationResponseSchema,
  verifyEmailPathParams,
  verifyEmailResponseSchema,
} from "./schemas";
import { resendVerificationEmail, verifySchoolEmail } from "./service";

import type { Database } from "../../../db";
import type { ErpNextClient } from "../../../erpnext/client";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const verifyEmailRoute = createRoute({
  method: "get",
  path: "/api/schools/verify-email/{token}",
  tags: ["Schools"],
  operationId: "verifySchoolEmail",
  summary: "Verify a school's email address",
  description:
    "Verifies the school contact email using a one-time token. On success the token is consumed, " +
    "email_verified_at is set, and the school status moves from 'registered' to 'active' (trial). " +
    "The school must be active before the admin invitation can be activated. " +
    "Triggers async tenant provisioning (trial subscription, ERPNext bootstrap).",
  security: [],
  request: { params: verifyEmailPathParams },
  responses: standardResponses(
    {
      200: {
        description: "Email verified. The school is now active.",
        schema: verifyEmailResponseSchema,
      },
    },
    [400, 409, 429, 500],
  ),
});

const resendVerificationRoute = createRoute({
  method: "post",
  path: "/api/schools/resend-verification",
  tags: ["Schools"],
  operationId: "resendVerificationEmail",
  summary: "Resend the email verification",
  description:
    "Resends the email verification for a school contact address. Idempotent: the response " +
    "is identical whether the email is registered or not, preventing enumeration. " +
    "Rate-limited to prevent abuse.",
  security: [],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: resendVerificationBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "Request processed. Check your email if the address is registered.",
        schema: resendVerificationResponseSchema,
      },
    },
    [400, 429, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route group factory
// ---------------------------------------------------------------------------

/**
 * Build the email verification route group.
 *
 * Public (no authentication). Requires: database, logger.
 */
export function emailVerificationRoutes(
  db: Database,
  _logger: Logger,
  erpNextClient: ErpNextClient | null,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/schools/verify-email/{token}", auditAction("update", "schools"));
  routes.use("/api/schools/resend-verification", auditAction("update", "schools"));

  routes.openapi(verifyEmailRoute, async (c) => {
    const { token } = c.req.valid("param");
    const log = c.get("log");

    const result = await verifySchoolEmail(db, token, log);

    // Trigger async provisioning after successful verification.
    // Fire-and-forget: provisioning errors are logged but don't fail the
    // verification response. The provisioning status can be polled via
    // the provisioning status endpoint.
    provisionTenant(
      db,
      {
        schoolId: result.schoolId,
        slug: result.slug,
        schoolName: result.schoolName,
        countryId: result.countryId,
        country: "", // Will be resolved from country_id in the service
        defaultCurrencyId: result.defaultCurrencyId,
        currency: "", // Will be resolved from currency_id in the service
        adminUserId: result.adminUserId,
        adminEmail: result.adminEmail,
        tenantContext: { schoolId: result.schoolId, userId: result.adminUserId },
      },
      log,
      erpNextClient,
    ).catch((error) => {
      log.error(
        { school_id: result.schoolId, error: error instanceof Error ? error.message : "unknown" },
        "provisioning failed after email verification",
      );
    });

    return c.json(
      {
        state: "verified" as const,
        school: {
          id: result.schoolId,
          slug: result.slug,
          name: result.schoolName,
        },
      },
      200,
    );
  });

  routes.openapi(resendVerificationRoute, async (c) => {
    const body = c.req.valid("json");
    const log = c.get("log");

    await resendVerificationEmail(db, { email: body.email }, log);

    return c.json(
      {
        message: "If your email is registered and unverified, a verification email has been sent.",
      },
      200,
    );
  });

  return routes;
}
