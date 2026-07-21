/**
 * Returning-user OAuth login route (ST-079).
 *
 *   POST /api/auth/login/oauth
 *
 * Public (no bearer token): the Microsoft OIDC id_token in the body is the credential. The handler
 * validates the id_token, matches the (provider, sub) against app.oauth_identities, enforces
 * tenant suspension policy, and issues session tokens.
 *
 * Three machine-readable outcome states:
 *   - LOGIN_SUCCESS  → 200 with session tokens
 *   - NO_ACCOUNT     → 403 with NO_ACCOUNT code
 *   - SCHOOL_SUSPENDED → 403 with SCHOOL_SUSPENDED code
 *
 * Identity verification is injected (`deps.verifyMicrosoftIdentity`) so tests can exercise the
 * flow without a live Microsoft JWKS; the default delegates to ST-077's validateMicrosoftIdToken.
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
import { getMicrosoftOAuthConfig } from "../oauth/microsoft-config";
import { validateMicrosoftIdToken } from "../oauth/microsoft-id-token";
import { loginReturningUser } from "../services/returning-user-login-service";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { SessionTokenConfig } from "../services/session-service";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const loginBodySchema = z
  .object({
    id_token: z
      .string()
      .min(1)
      .openapi({
        description:
          "A verified Microsoft OIDC ID token. The client obtains this from a Microsoft " +
          "authorization request; the server validates it against Microsoft's JWKS.",
        example: "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIs...",
      }),
    nonce: z
      .string()
      .min(1)
      .openapi({
        description:
          "The nonce the client generated for its OIDC authorization request. The ID token " +
          "is rejected unless it was minted with this nonce.",
        example: "n-0S6_WzA2Mj",
      }),
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
  .openapi("ReturningUserLoginRequest");

const loginResponseSchema = z
  .object({
    access_token: z.string().openapi({ description: "Signed JWT access token." }),
    token_type: z.literal("Bearer"),
    expires_in: z.number().int().openapi({ description: "Access-token lifetime in seconds." }),
    session_id: z.string().uuid().openapi({ description: "Identifier of the new session." }),
    refresh_token: z
      .string()
      .optional()
      .openapi({
        description:
          "Opaque refresh token. Present only for non-web channels; web sessions receive it as " +
          "an HttpOnly cookie instead.",
      }),
  })
  .openapi("ReturningUserLoginResponse");

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const loginRoute = createRoute({
  method: "post",
  path: "/api/auth/login/oauth",
  tags: ["Authentication"],
  operationId: "returningUserLogin",
  summary: "Log in as a returning user via OAuth",
  description:
    "Authenticates a returning active user by validating a Microsoft OIDC ID token, matching " +
    "the (provider, sub) against the platform's oauth_identities, enforcing tenant suspension " +
    "policy, and issuing a session token pair. Returns machine-readable outcome states for " +
    "unknown identities (NO_ACCOUNT) and suspended tenants (SCHOOL_SUSPENDED).",
  security: [],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: loginBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "Login successful. Returns session tokens.",
        schema: loginResponseSchema,
      },
    },
    [400, 401, 403, 429, 500],
  ),
});

// ---------------------------------------------------------------------------
// Identity verifier injection
// ---------------------------------------------------------------------------

interface LoginRouteDeps {
  verifyMicrosoftIdentity?: (
    idToken: string,
    nonce: string,
  ) => Promise<{ subject: string; email: string }>;
}

async function defaultVerifyIdentity(
  idToken: string,
  nonce: string,
): Promise<{ subject: string; email: string }> {
  const oauthConfig = getMicrosoftOAuthConfig();
  if (!oauthConfig) {
    throw new HTTPException(404, { message: "Microsoft OAuth is not configured" });
  }
  const claims = await validateMicrosoftIdToken(idToken, oauthConfig.clientId, nonce);
  return { subject: claims.sub, email: claims.email };
}

// ---------------------------------------------------------------------------
// Route group factory
// ---------------------------------------------------------------------------

/**
 * Build the returning-user login route group.
 *
 * Requires a database (for identity lookup and token issuance) and a session-token config
 * (key store + issuer/audience/TTLs). Public — no bearer token required.
 */
export function returningUserLoginRoutes(
  db: Database,
  config: SessionTokenConfig,
  logger: Logger,
  deps: LoginRouteDeps = {},
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const verifyIdentity = deps.verifyMicrosoftIdentity ?? defaultVerifyIdentity;

  routes.use("/api/auth/login/oauth", auditAction("login", "refresh_tokens"));

  routes.openapi(loginRoute, async (c) => {
    const { id_token, nonce, channel } = c.req.valid("json");
    const log = c.get("log");
    const requestId = c.get("requestId");
    const clientIp = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
    const userAgent = c.req.header("user-agent") ?? null;

    // Delegate identity verification to the injected or default verifier.
    // This may throw CodedHttpException(401) if the id_token is invalid.
    const claims = await verifyIdentity(id_token, nonce);

    const result = await loginReturningUser(db, config, {
      subject: claims.subject,
      channel,
      device: { userAgent, ipAddress: clientIp },
      requestId,
      logger: log,
      clientIp,
      userAgent,
    });

    switch (result.outcome) {
      case "LOGIN_SUCCESS": {
        const body = deliverTokenPair(c, result.tokens);
        return c.json(body, 200);
      }

      case "NO_ACCOUNT":
        throw new CodedHttpException(
          403,
          ERROR_CODES.NO_ACCOUNT,
          "No account found — ask your school admin for an invitation.",
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
