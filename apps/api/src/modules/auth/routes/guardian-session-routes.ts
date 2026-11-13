/**
 * "Add <child> to this phone" (000215). See services/guardian-session-service.ts for who may and why.
 *
 *   POST /api/auth/guardian/children/{studentId}/session   bearer (PARENT)
 *
 * Outcomes:
 *   - 200                              the child's own session (mobile channel: refresh token in the body)
 *   - 403 AUTHZ_FORBIDDEN              the caller is not a parent, or the school turned the feature off
 *   - 403 AUTH_ACCOUNT_LOCKED          too many wrong passwords on the child's account
 *   - 403 GUARDIAN_CHILD_UNAVAILABLE   the child's account is not in use (suspended, graduated, ...)
 *   - 403 SCHOOL_SUSPENDED
 *   - 404 RESOURCE_NOT_FOUND           no link between the caller and that student -- the same answer
 *                                      for "not your child" and "no such student", so the route
 *                                      cannot be used to find out which students exist
 *   - 429                              the parent's hourly budget is spent
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import {
  buildGuardianDeviceSigninRateLimitKey,
  GUARDIAN_DEVICE_SIGNIN_BUDGET,
} from "../../../config/rateLimits";
import { clientIpFrom } from "../../../lib/client-ip";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { takeRateLimitToken } from "../../../middleware/rateLimiter";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { issueGuardianChildSession } from "../services/guardian-session-service";
import { LOCKOUT_MINUTES } from "../services/member-password-service";

import type { Database } from "../../../db";
import type { AppEnv } from "../../../middleware/requestId";
import type { RedisClient } from "../../../redis";
import type { SessionTokenConfig } from "../services/session-service";
import type { Context } from "hono";

export const GUARDIAN_CHILD_SESSION_PATH = "/api/auth/guardian/children/{studentId}/session";

/** One parent's budget check: true to go ahead. Injectable so tests need no Redis. */
export type GuardianSigninLimiter = (
  c: Context<AppEnv>,
  guardianUserId: string,
) => Promise<{ allowed: true } | { allowed: false; retryAfter: number }>;

/** The Redis token bucket; fails open without Redis or on a Redis error, like the member sign-in. */
export function redisGuardianSigninLimiter(redis: RedisClient | null): GuardianSigninLimiter {
  return async (c, guardianUserId) => {
    if (!redis) return { allowed: true };
    try {
      const result = await takeRateLimitToken(
        redis,
        buildGuardianDeviceSigninRateLimitKey(guardianUserId),
        GUARDIAN_DEVICE_SIGNIN_BUDGET,
        Math.floor(Date.now() / 1000),
      );
      return result.allowed ? { allowed: true } : { allowed: false, retryAfter: result.retryAfter };
    } catch (err: unknown) {
      c.get("log")?.warn({ err }, "guardian device sign-in rate limiter redis error, failing open");
      return { allowed: true };
    }
  };
}

const paramsSchema = z.object({
  studentId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "studentId", in: "path" },
      description: "The child's student record id, as the parent app lists it.",
    }),
});

const guardianChildAccountSchema = z
  .object({
    user_id: z.string().uuid().openapi({ description: "The child's own user id." }),
    display_name: z
      .string()
      .openapi({ description: "The child's name, for the account switcher." }),
    school_name: z.string(),
    member_ids: z.array(z.string()).openapi({ description: "The child's member IDs (STU-...)." }),
  })
  .openapi("GuardianChildAccount");

const guardianChildSessionResponseSchema = z
  .object({
    access_token: z.string().openapi({ description: "The child's signed JWT access token." }),
    token_type: z.literal("Bearer"),
    expires_in: z.number().int().openapi({ description: "Access-token lifetime in seconds." }),
    session_id: z.string().uuid().openapi({ description: "The child's new session." }),
    refresh_token: z.string().openapi({ description: "The child's opaque refresh token." }),
    child: guardianChildAccountSchema,
  })
  .openapi("GuardianChildSessionResponse");

const route = createRoute({
  method: "post",
  path: GUARDIAN_CHILD_SESSION_PATH,
  tags: ["Auth"],
  operationId: "createGuardianChildSession",
  summary: "Put my child's account on this phone",
  description:
    "For a parent signed in on the mobile app: opens the linked child's own session, so the " +
    "child's account can be added to the phone's account switcher without the child's member ID " +
    "and password. Allowed while the school's `allow_parent_device_signin` setting is on and the " +
    "child's account is in use. The session is marked as opened by this parent in the child's " +
    "session list and can be ended there like any other. Limited to ten per parent per hour.",
  security: [{ bearerAuth: [] }],
  request: { params: paramsSchema },
  responses: standardResponses(
    { 200: { description: "The child's session.", schema: guardianChildSessionResponseSchema } },
    [400, 401, 403, 404, 429, 500],
  ),
});

export function guardianSessionRoutes(
  db: Database,
  config: SessionTokenConfig,
  limiter: GuardianSigninLimiter,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use(
    GUARDIAN_CHILD_SESSION_PATH.replace("{studentId}", ":studentId"),
    auditAction("login", "refresh_tokens"),
  );

  routes.openapi(route, async (c) => {
    const auth = requireAuth(c);
    const { studentId } = c.req.valid("param");

    if (!auth.roles.includes(ROLES.PARENT)) {
      throw new CodedHttpException(
        403,
        ERROR_CODES.AUTHZ_FORBIDDEN,
        "Only a parent can add a child's account to their phone.",
      );
    }

    const budget = await limiter(c, auth.userId);
    if (!budget.allowed) {
      c.header("Retry-After", String(budget.retryAfter));
      throw new HTTPException(429);
    }

    const clientIp = clientIpFrom(c);
    const userAgent = c.req.header("user-agent") ?? null;
    const result = await issueGuardianChildSession(db, config, {
      schoolId: auth.schoolId,
      guardianUserId: auth.userId,
      studentId,
      requestId: c.get("requestId"),
      device: { userAgent, ipAddress: clientIp },
      clientIp,
      userAgent,
    });

    switch (result.outcome) {
      case "ISSUED":
        return c.json(
          {
            access_token: result.tokens.accessToken,
            token_type: "Bearer" as const,
            expires_in: result.tokens.accessExpiresInSeconds,
            session_id: result.tokens.sessionId,
            refresh_token: result.tokens.refreshToken,
            child: {
              user_id: result.child.userId,
              display_name: result.child.displayName,
              school_name: result.child.schoolName,
              member_ids: result.child.memberIds,
            },
          },
          200,
        );
      case "NOT_LINKED":
        throw new CodedHttpException(
          404,
          ERROR_CODES.RESOURCE_NOT_FOUND,
          "No child with that id is linked to your account.",
        );
      case "DISABLED":
        throw new CodedHttpException(
          403,
          ERROR_CODES.AUTHZ_FORBIDDEN,
          "Your school has turned off adding a child's account from the parent app.",
        );
      case "CHILD_UNAVAILABLE":
        throw new CodedHttpException(
          403,
          ERROR_CODES.GUARDIAN_CHILD_UNAVAILABLE,
          "This child's account can't be used right now. Contact the school.",
        );
      case "LOCKED":
        throw new CodedHttpException(
          403,
          ERROR_CODES.AUTH_ACCOUNT_LOCKED,
          `Too many wrong passwords on this account. Try again in ${LOCKOUT_MINUTES} minutes or ask the school to reset it.`,
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
