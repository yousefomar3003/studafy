/**
 * Mobile OAuth routes — system-browser PKCE flow for native apps.
 *
 * Two endpoints per provider:
 *   GET  /api/auth/oauth/{provider}/mobile-start    — returns PKCE params as JSON
 *   POST /api/auth/oauth/{provider}/mobile-exchange  — exchanges code for session tokens
 *
 * These mirror the browser-redirect flow but skip the server-side redirect: the mobile app
 * opens its own system browser (ASWebAuthenticationSession / Custom Tabs), captures the
 * callback via a custom URI scheme, and posts the authorization code back here. The backend
 * performs the IdP code exchange, validates the id_token, and returns a TokenPair as JSON.
 *
 * The state store is shared with the browser-redirect routes (same in-memory TTL).
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { loginReturningUser } from "../services/returning-user-login-service";

import { GOOGLE_TOKEN_ENDPOINT, getGoogleOAuthConfig } from "./config";
import { validateGoogleIdToken } from "./google-id-token";
import { MICROSOFT_TOKEN_ENDPOINT, getMicrosoftOAuthConfig } from "./microsoft-config";
import { validateMicrosoftIdToken } from "./microsoft-id-token";
import { generateCodeChallenge, generateCodeVerifier, generateNonce, generateState } from "./pkce";
import { createStateStore } from "./state-store";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { SessionTokenConfig } from "../services/session-service";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const mobileStartResponseSchema = z
  .object({
    state: z.string().describe("OAuth state parameter. Pass back in the exchange request."),
    nonce: z.string().describe("OIDC nonce. Pass back in the exchange request."),
    code_challenge: z
      .string()
      .describe("PKCE S256 code_challenge derived from the code_verifier stored server-side."),
  })
  .openapi("MobileOAuthStartResponse");

const mobileExchangeRequestSchema = z
  .object({
    code: z.string().min(1).describe("Authorization code from the IdP callback."),
    state: z.string().min(1).describe("State parameter returned by the /mobile-start endpoint."),
    nonce: z.string().min(1).describe("Nonce returned by the /mobile-start endpoint."),
    code_verifier: z
      .string()
      .min(43)
      .describe("PKCE code_verifier. Must match the code_challenge stored against this state."),
  })
  .openapi("MobileOAuthExchangeRequest");

const tokenPairSchema = z
  .object({
    access_token: z.string().describe("RS256 JWT. Send as Authorization: Bearer."),
    token_type: z.literal("Bearer"),
    expires_in: z.number().int().describe("Access-token lifetime in seconds."),
    session_id: z.string().uuid().describe("Session identifier."),
    refresh_token: z
      .string()
      .optional()
      .describe("Opaque refresh token. Present for mobile channel sessions."),
  })
  .openapi("TokenPair");

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

function createMobileStartRoute(provider: string) {
  return createRoute({
    method: "get",
    path: `/api/auth/oauth/${provider}/mobile-start`,
    tags: ["Auth"],
    operationId: `${provider}MobileStart`,
    summary: `Start a mobile ${provider} OAuth session`,
    description:
      `Generates PKCE, state, and nonce parameters for a mobile OAuth flow using ${provider}. ` +
      "Returns them as JSON so the mobile app can construct the authorization URL and open a " +
      "system browser. The code_verifier is stored server-side keyed by the state parameter.",
    security: [],
    responses: standardResponses(
      {
        200: {
          description: "PKCE parameters for the mobile authorization request.",
          schema: mobileStartResponseSchema,
        },
      },
      [404, 429],
    ),
  });
}

function createMobileExchangeRoute(provider: string) {
  return createRoute({
    method: "post",
    path: `/api/auth/oauth/${provider}/mobile-exchange`,
    tags: ["Auth"],
    operationId: `${provider}MobileExchange`,
    summary: `Exchange a ${provider} authorization code for session tokens (mobile)`,
    description:
      `Validates the PKCE state, exchanges the authorization code with ${provider}'s token ` +
      "endpoint, verifies the id_token, and issues a session token pair. Returns the same " +
      "TokenPair shape as /api/auth/login/oauth with channel=mobile.",
    security: [],
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: mobileExchangeRequestSchema } },
      },
    },
    responses: standardResponses(
      {
        200: {
          description: "Session tokens.",
          schema: tokenPairSchema,
        },
      },
      [400, 403, 404, 429, 500],
    ),
  });
}

// ---------------------------------------------------------------------------
// Route group factory
// ---------------------------------------------------------------------------

export function mobileOAuthRoutes(
  db: Database,
  config: SessionTokenConfig,
  logger: Logger,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  const stateStore = createStateStore();

  // ----- Google mobile routes -----

  routes.openapi(createMobileStartRoute("google"), async (c) => {
    const oauthConfig = getGoogleOAuthConfig();
    if (!oauthConfig) {
      throw new HTTPException(404, { message: "Google OAuth is not configured" });
    }

    const state = generateState();
    const nonce = generateNonce();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    stateStore.set(state, { codeVerifier, nonce, createdAt: Date.now() });

    return c.json({ state, nonce, code_challenge: codeChallenge }, 200);
  });

  routes.openapi(createMobileExchangeRoute("google"), async (c) => {
    const { code, state, nonce, code_verifier } = c.req.valid("json");
    const oauthConfig = getGoogleOAuthConfig();
    if (!oauthConfig) {
      throw new HTTPException(404, { message: "Google OAuth is not configured" });
    }

    const entry = stateStore.get(state);
    if (!entry) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.OAUTH_STATE_INVALID,
        "Invalid or expired OAuth state",
      );
    }
    stateStore.delete(state);

    if (entry.codeVerifier !== code_verifier) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.OAUTH_STATE_INVALID,
        "PKCE code_verifier does not match",
      );
    }

    if (entry.nonce !== nonce) {
      throw new CodedHttpException(400, ERROR_CODES.OAUTH_STATE_INVALID, "Nonce does not match");
    }

    try {
      const idToken = await exchangeCode(code, GOOGLE_TOKEN_ENDPOINT, oauthConfig, code_verifier);
      const claims = await validateGoogleIdToken(idToken, oauthConfig.clientId, nonce);

      const result = await loginReturningUser(db, config, {
        subject: claims.sub,
        provider: "google",
        channel: "mobile",
        logger,
      });

      switch (result.outcome) {
        case "LOGIN_SUCCESS": {
          const body = {
            access_token: result.tokens.accessToken,
            token_type: "Bearer" as const,
            expires_in: result.tokens.accessExpiresInSeconds,
            session_id: result.tokens.sessionId,
            refresh_token: result.tokens.refreshToken,
          };
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
    } catch (error) {
      if (error instanceof CodedHttpException) throw error;
      if (error instanceof HTTPException) {
        throw new CodedHttpException(
          502,
          ERROR_CODES.OAUTH_PROVIDER_ERROR,
          "Failed to exchange authorization code with Google",
        );
      }
      throw error;
    }
  });

  // ----- Microsoft mobile routes -----

  routes.openapi(createMobileStartRoute("microsoft"), async (c) => {
    const oauthConfig = getMicrosoftOAuthConfig();
    if (!oauthConfig) {
      throw new HTTPException(404, { message: "Microsoft OAuth is not configured" });
    }

    const state = generateState();
    const nonce = generateNonce();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    stateStore.set(state, { codeVerifier, nonce, createdAt: Date.now() });

    return c.json({ state, nonce, code_challenge: codeChallenge }, 200);
  });

  routes.openapi(createMobileExchangeRoute("microsoft"), async (c) => {
    const { code, state, nonce, code_verifier } = c.req.valid("json");
    const oauthConfig = getMicrosoftOAuthConfig();
    if (!oauthConfig) {
      throw new HTTPException(404, { message: "Microsoft OAuth is not configured" });
    }

    const entry = stateStore.get(state);
    if (!entry) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.OAUTH_STATE_INVALID,
        "Invalid or expired OAuth state",
      );
    }
    stateStore.delete(state);

    if (entry.codeVerifier !== code_verifier) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.OAUTH_STATE_INVALID,
        "PKCE code_verifier does not match",
      );
    }

    if (entry.nonce !== nonce) {
      throw new CodedHttpException(400, ERROR_CODES.OAUTH_STATE_INVALID, "Nonce does not match");
    }

    try {
      const idToken = await exchangeCode(
        code,
        MICROSOFT_TOKEN_ENDPOINT,
        oauthConfig,
        code_verifier,
      );
      const claims = await validateMicrosoftIdToken(idToken, oauthConfig.clientId, nonce);

      const result = await loginReturningUser(db, config, {
        subject: claims.sub,
        provider: "microsoft",
        channel: "mobile",
        logger,
      });

      switch (result.outcome) {
        case "LOGIN_SUCCESS": {
          const body = {
            access_token: result.tokens.accessToken,
            token_type: "Bearer" as const,
            expires_in: result.tokens.accessExpiresInSeconds,
            session_id: result.tokens.sessionId,
            refresh_token: result.tokens.refreshToken,
          };
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
    } catch (error) {
      if (error instanceof CodedHttpException) throw error;
      if (error instanceof HTTPException) {
        throw new CodedHttpException(
          502,
          ERROR_CODES.OAUTH_PROVIDER_ERROR,
          "Failed to exchange authorization code with Microsoft",
        );
      }
      throw error;
    }
  });

  return routes;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TokenExchangeConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

async function exchangeCode(
  code: string,
  tokenEndpoint: string,
  oauthConfig: TokenExchangeConfig,
  codeVerifier: string,
): Promise<string> {
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: oauthConfig.clientId,
        client_secret: oauthConfig.clientSecret,
        redirect_uri: oauthConfig.redirectUri,
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
      }).toString(),
    });
  } catch {
    throw new HTTPException(502, { message: "Failed to reach IdP token endpoint" });
  }

  if (!tokenResponse.ok) {
    throw new HTTPException(502, { message: "Failed to exchange authorization code" });
  }

  const tokenData = (await tokenResponse.json()) as { id_token?: string };
  if (!tokenData.id_token) {
    throw new HTTPException(502, { message: "IdP did not return an id_token" });
  }

  return tokenData.id_token;
}
