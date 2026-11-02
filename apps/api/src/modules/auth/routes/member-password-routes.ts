/**
 * Member-code + password sign-in (migration 000141). See services/member-password-service.ts.
 *
 *   POST /api/auth/login/member     public: member code + password (+ new_password on first use)
 *   POST /api/auth/password/change  bearer: the signed-in member replaces their own password
 *
 * Sign-in outcomes:
 *   - 200                                   session tokens
 *   - 401 AUTH_INVALID_CREDENTIALS          unknown code, wrong password or an account that does not
 *                                           sign in this way -- deliberately indistinguishable
 *   - 403 AUTH_PASSWORD_CHANGE_REQUIRED     still on the default password; resend with new_password
 *   - 403 AUTH_ACCOUNT_LOCKED               too many wrong passwords; try again later
 *   - 403 SCHOOL_SUSPENDED
 *   - 422 AUTH_PASSWORD_REJECTED            new_password breaks the policy
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { deliverTokenPair } from "../delivery";
import {
  changeMemberPassword,
  loginMember,
  LOCKOUT_MINUTES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "../services/member-password-service";

import { loginResponseSchema } from "./returning-user-login-routes";

import type { Database } from "../../../db";
import type { AppEnv } from "../../../middleware/requestId";
import type { PasswordPolicyViolation } from "../services/member-password-service";
import type { SessionTokenConfig } from "../services/session-service";

export const MEMBER_LOGIN_PATH = "/api/auth/login/member";
export const MEMBER_PASSWORD_CHANGE_PATH = "/api/auth/password/change";

const POLICY_MESSAGES: Record<PasswordPolicyViolation, string> = {
  TOO_SHORT: `The new password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
  TOO_LONG: `The new password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
  IS_DEFAULT: "Choose a password other than the starting password.",
  SAME_AS_USERNAME: "The new password cannot be your ID.",
};

function rejected(reason: PasswordPolicyViolation): never {
  // eslint-disable-next-line security/detect-object-injection -- `reason` is a closed union from the policy check
  throw new CodedHttpException(422, ERROR_CODES.AUTH_PASSWORD_REJECTED, POLICY_MESSAGES[reason]);
}

function locked(): never {
  throw new CodedHttpException(
    403,
    ERROR_CODES.AUTH_ACCOUNT_LOCKED,
    `Too many wrong passwords. Try again in ${LOCKOUT_MINUTES} minutes or ask your school to reset it.`,
  );
}

const passwordField = z.string().min(1).max(256);

const memberLoginBodySchema = z
  .object({
    username: z.string().trim().min(1).max(32).openapi({
      description: "The member ID issued by the school (STU-, TCH-, PAR- or ATT-).",
      example: "STU-100001",
    }),
    password: passwordField.openapi({ description: "Current password." }),
    new_password: passwordField.optional().openapi({
      description:
        "Required while the account is still on its starting password: the password to replace it " +
        "with. Ignored otherwise.",
    }),
    channel: z
      .enum(["web", "mobile", "api"])
      .default("mobile")
      .openapi({
        description:
          "Session channel. 'web' delivers the refresh token as an HttpOnly cookie; 'mobile' and " +
          "'api' return it in the body.",
      }),
  })
  .openapi("MemberLoginRequest");

const changePasswordBodySchema = z
  .object({
    current_password: passwordField,
    new_password: passwordField,
  })
  .openapi("MemberPasswordChangeRequest");

const memberLoginRoute = createRoute({
  method: "post",
  path: MEMBER_LOGIN_PATH,
  tags: ["Auth"],
  operationId: "memberLogin",
  summary: "Sign in with a member ID and password",
  description:
    "For students, parents, teachers and attendance officers. An account still on its starting " +
    "password receives 403 AUTH_PASSWORD_CHANGE_REQUIRED and no session until the request also " +
    "carries new_password. School leadership signs in with Google or Microsoft instead.",
  security: [],
  request: {
    body: { required: true, content: { "application/json": { schema: memberLoginBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "Signed in.", schema: loginResponseSchema } },
    [400, 401, 403, 422, 429, 500],
  ),
});

const changePasswordRoute = createRoute({
  method: "post",
  path: MEMBER_PASSWORD_CHANGE_PATH,
  tags: ["Auth"],
  operationId: "changeMemberPassword",
  summary: "Change my password",
  description: "The signed-in member replaces their password, confirming the current one.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: changePasswordBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "Password changed.",
        schema: z.object({ changed: z.literal(true) }).openapi("MemberPasswordChangeResponse"),
      },
    },
    [400, 401, 403, 422, 429, 500],
  ),
});

export function memberPasswordRoutes(
  db: Database,
  config: SessionTokenConfig,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use(MEMBER_LOGIN_PATH, auditAction("login", "refresh_tokens"));
  routes.use(MEMBER_PASSWORD_CHANGE_PATH, auditAction("update", "member_credentials"));

  routes.openapi(memberLoginRoute, async (c) => {
    const body = c.req.valid("json");
    const clientIp = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
    const userAgent = c.req.header("user-agent") ?? null;

    const result = await loginMember(db, config, {
      username: body.username,
      password: body.password,
      newPassword: body.new_password,
      channel: body.channel,
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
        throw new CodedHttpException(
          401,
          ERROR_CODES.AUTH_INVALID_CREDENTIALS,
          "Invalid ID or password.",
        );
      case "LOCKED":
        return locked();
      case "PASSWORD_CHANGE_REQUIRED":
        throw new CodedHttpException(
          403,
          ERROR_CODES.AUTH_PASSWORD_CHANGE_REQUIRED,
          "Set a new password to finish signing in.",
        );
      case "PASSWORD_REJECTED":
        return rejected(result.reason);
      case "SCHOOL_SUSPENDED":
        throw new CodedHttpException(
          403,
          ERROR_CODES.SCHOOL_SUSPENDED,
          "Your school's account has been suspended. Contact your administrator.",
        );
    }
  });

  routes.openapi(changePasswordRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");

    const result = await changeMemberPassword(
      db,
      { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") },
      body.current_password,
      body.new_password,
    );

    switch (result.outcome) {
      case "CHANGED":
        return c.json({ changed: true as const }, 200);
      case "WRONG_PASSWORD":
        throw new CodedHttpException(
          403,
          ERROR_CODES.AUTH_INVALID_CREDENTIALS,
          "Your current password is not correct.",
        );
      case "LOCKED":
        return locked();
      case "NOT_ELIGIBLE":
        throw new CodedHttpException(
          403,
          ERROR_CODES.AUTHZ_FORBIDDEN,
          "This account signs in with Google or Microsoft and has no password.",
        );
      case "PASSWORD_REJECTED":
        return rejected(result.reason);
    }
  });

  return routes;
}
