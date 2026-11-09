/**
 * Staging-only QA email/password login route (QA-02).
 *
 *   POST /api/auth/login/qa
 *
 * Public (no bearer token): the email and the shared QA password are the credential. Only
 * authenticates `qa` identities of schools flagged is_qa_tenant -- see services/qa-login-service.ts.
 * Answers 404 when QA_LOGIN_PASSWORD is not configured, which is always the case in production
 * (env.ts refuses to boot otherwise), so the published contract does not depend on a deployment's
 * environment.
 *
 * Outcomes:
 *   - LOGIN_SUCCESS       → 200 with session tokens
 *   - INVALID_CREDENTIALS → 401 AUTH_INVALID_CREDENTIALS (wrong password, unknown email, or an
 *                           identity outside a QA tenant -- deliberately indistinguishable)
 *   - SCHOOL_SUSPENDED    → 403 SCHOOL_SUSPENDED
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { clientIpFrom } from "../../../lib/client-ip";
import { auditAction } from "../../../middleware/auditEmitter";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { deliverTokenPair } from "../delivery";
import { loginQaUser } from "../services/qa-login-service";

import { loginResponseSchema } from "./returning-user-login-routes";

import type { Database } from "../../../db";
import type { AppEnv } from "../../../middleware/requestId";
import type { SessionTokenConfig } from "../services/session-service";

const QA_LOGIN_PATH = "/api/auth/login/qa";

const qaLoginBodySchema = z
  .object({
    email: z.string().trim().email().max(320).openapi({
      description: "A QA account email from docs/runbooks/qa-staging-access.md.",
      example: "admin@qa-a.studafy.test",
    }),
    password: z.string().min(1).max(256).openapi({ description: "The shared QA password." }),
    channel: z
      .enum(["web", "mobile", "api"])
      .default("api")
      .openapi({
        description:
          "Session channel. Determines refresh-token delivery: 'web' uses an HttpOnly cookie; " +
          "'mobile' and 'api' return the token in the response body.",
        example: "api",
      }),
  })
  .openapi("QaLoginRequest");

const qaLoginRoute = createRoute({
  method: "post",
  path: QA_LOGIN_PATH,
  tags: ["Auth"],
  operationId: "qaLogin",
  summary: "Log in to a staging QA tenant with email and password",
  description:
    "Staging QA access. Authenticates one of the QA tenants' accounts by email and the shared QA " +
    "password, without an external OAuth provider. Accounts in any other school cannot sign in " +
    "here. 404 when the deployment has no QA password configured, which is always the case in " +
    "production.",
  security: [],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: qaLoginBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "Login successful. Returns session tokens.",
        schema: loginResponseSchema,
      },
    },
    [400, 401, 403, 404, 429, 500],
  ),
});

/**
 * Build the QA login route group. `qaPassword` is env.QA_LOGIN_PASSWORD; undefined keeps the route
 * registered but answering 404.
 */
export function qaLoginRoutes(
  db: Database,
  config: SessionTokenConfig,
  qaPassword: string | undefined,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use(QA_LOGIN_PATH, auditAction("login", "refresh_tokens"));

  routes.openapi(qaLoginRoute, async (c) => {
    if (!qaPassword) {
      throw new HTTPException(404, { message: "QA login is not configured" });
    }

    const { email, password, channel } = c.req.valid("json");
    const clientIp = clientIpFrom(c);
    const userAgent = c.req.header("user-agent") ?? null;

    const result = await loginQaUser(db, config, {
      email,
      password,
      expectedPassword: qaPassword,
      channel,
      device: { userAgent, ipAddress: clientIp },
      requestId: c.get("requestId"),
      logger: c.get("log"),
      clientIp,
      userAgent,
    });

    switch (result.outcome) {
      case "LOGIN_SUCCESS":
        return c.json(deliverTokenPair(c, result.tokens), 200);

      case "INVALID_CREDENTIALS":
      case "NO_ACCOUNT":
        throw new CodedHttpException(
          401,
          ERROR_CODES.AUTH_INVALID_CREDENTIALS,
          "Invalid email or password.",
        );

      case "SCHOOL_SUSPENDED":
        throw new CodedHttpException(
          403,
          ERROR_CODES.SCHOOL_SUSPENDED,
          "Your school's account has been suspended. Contact your administrator.",
        );
    }
  });

  return routes;
}
