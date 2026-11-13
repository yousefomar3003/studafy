/**
 * Review-only email/password login route (ST-303).
 *
 *   POST /api/auth/login/review
 *
 * Public (no bearer token): the email and the shared reviewer password are the credential. Only
 * authenticates `review` identities of the school flagged is_review_tenant -- see
 * services/review-login-service.ts. Answers 404 when REVIEW_LOGIN_PASSWORD is not configured, the
 * same inert-by-default posture the Google and Microsoft routes take, so the published contract does
 * not depend on a deployment's environment.
 *
 * Outcomes:
 *   - LOGIN_SUCCESS       → 200 with session tokens
 *   - INVALID_CREDENTIALS → 401 AUTH_INVALID_CREDENTIALS (wrong password, unknown email, or an
 *                           identity outside the review tenant -- deliberately indistinguishable)
 *   - SCHOOL_SUSPENDED    → 403 SCHOOL_SUSPENDED
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { auditAction } from "../../../middleware/auditEmitter";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { deliverTokenPair } from "../delivery";
import { loginReviewUser } from "../services/review-login-service";

import { loginResponseSchema } from "./returning-user-login-routes";

import type { Database } from "../../../db";
import type { AppEnv } from "../../../middleware/requestId";
import type { SessionTokenConfig } from "../services/session-service";

const REVIEW_LOGIN_PATH = "/api/auth/login/review";

const reviewLoginBodySchema = z
  .object({
    email: z.string().trim().email().max(320).openapi({
      description: "A reviewer account email from the App Review / Play App-access notes.",
      example: "admin@review.studafy.test",
    }),
    password: z.string().min(1).max(256).openapi({ description: "The shared reviewer password." }),
    channel: z
      .enum(["web", "mobile", "api"])
      .default("api")
      .openapi({
        description:
          "Session channel. Determines refresh-token delivery: 'web' uses an HttpOnly cookie; " +
          "'mobile' and 'api' return the token in the response body.",
        example: "mobile",
      }),
  })
  .openapi("ReviewLoginRequest");

const reviewLoginRoute = createRoute({
  method: "post",
  path: REVIEW_LOGIN_PATH,
  tags: ["Auth"],
  operationId: "reviewLogin",
  summary: "Log in to the reviewer demo tenant with email and password",
  description:
    "App Store / Play review access. Authenticates one of the reviewer demo tenant's accounts by " +
    "email and the shared reviewer password, without an external OAuth provider. Accounts in any " +
    "other school cannot sign in here. 404 when the deployment has no reviewer password configured.",
  security: [],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: reviewLoginBodySchema } },
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
 * Build the review login route group. `reviewPassword` is env.REVIEW_LOGIN_PASSWORD; undefined keeps
 * the route registered but answering 404.
 */
export function reviewLoginRoutes(
  db: Database,
  config: SessionTokenConfig,
  reviewPassword: string | undefined,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use(REVIEW_LOGIN_PATH, auditAction("login", "refresh_tokens"));

  routes.openapi(reviewLoginRoute, async (c) => {
    if (!reviewPassword) {
      throw new HTTPException(404, { message: "Review login is not configured" });
    }

    const { email, password, channel } = c.req.valid("json");
    const clientIp = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
    const userAgent = c.req.header("user-agent") ?? null;

    const result = await loginReviewUser(db, config, {
      email,
      password,
      expectedPassword: reviewPassword,
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
