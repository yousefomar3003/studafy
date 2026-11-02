/**
 * Mobile OAuth routes — system-browser PKCE flow for native apps.
 *
 * Per provider:
 *   GET  /api/auth/oauth/{provider}/mobile-start     — mints state + nonce + PKCE, returns them as JSON
 *   GET  /api/auth/oauth/{provider}/mobile-authorize — where the app opens its system browser;
 *                                                      redirects to the provider
 *   POST /api/auth/oauth/{provider}/mobile-exchange  — redeems the one-time handoff code for a
 *                                                      session token pair
 *
 * The provider returns to the server's own registered callback — the same one the browser flows
 * use — not to the app: Google refuses custom-scheme redirect URIs on a web client, and the app
 * has no client of its own. That callback exchanges the code and verifies the id_token, then hands
 * the verified identity to the app through `studafy://auth/callback` as a one-time code (see
 * mobile-handoff.ts for the whole sequence). The app posts that code here with the state and nonce
 * from /mobile-start, and gets a TokenPair as JSON.
 *
 * Entries live in the process-wide state store (state-store.ts), tagged `flow: "mobile-login"`
 * and then `"mobile-handoff"`, so neither can be redeemed by a browser flow, nor the reverse.
 *
 * A third "mock" provider sits alongside Google and Microsoft (ST-247) — dev/E2E only, inert
 * unless `getMockOAuthConfig()` returns non-null (mock-config.ts's own production kill switch).
 * It exists so the Flutter integration_test suite can drive the real PKCE round trip against the
 * same mock IdP (`dev/mock-idp.ts`) the browser-redirect mock routes and the web critical-journeys
 * E2E suite already use — without it, "login" has no mobile-drivable provider at all: Google and
 * Microsoft both require a real IdP app registration, which CI/E2E environments don't have.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { loginReturningUser } from "../services/returning-user-login-service";

import { GOOGLE_AUTH_ENDPOINT, GOOGLE_SCOPES, getGoogleOAuthConfig } from "./config";
import {
  MICROSOFT_AUTH_ENDPOINT,
  MICROSOFT_SCOPES,
  getMicrosoftOAuthConfig,
} from "./microsoft-config";
import { redeemHandoff } from "./mobile-handoff";
import {
  MOCK_AUTH_ENDPOINT,
  MOCK_OAUTH_CLIENT_ID,
  MOCK_OAUTH_SCOPES,
  getMockOAuthConfig,
} from "./mock-config";
import { generateCodeChallenge, generateCodeVerifier, generateNonce, generateState } from "./pkce";

import type { StateStore } from "./state-store";
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

export interface MobileOAuthDependencies {
  /** The process-wide OAuth state store, so /mobile-start and /mobile-exchange may hit different instances. */
  stateStore: StateStore;
}

export function mobileOAuthRoutes(
  db: Database,
  config: SessionTokenConfig,
  logger: Logger,
  { stateStore }: MobileOAuthDependencies,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  for (const provider of MOBILE_PROVIDERS) {
    routes.openapi(createMobileStartRoute(provider), async (c) => {
      assertProviderConfigured(provider);

      const state = generateState();
      const nonce = generateNonce();
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      await stateStore.set(state, { flow: "mobile-login", provider, codeVerifier, nonce });

      return c.json({ state, nonce, code_challenge: codeChallenge }, 200);
    });

    // The provider's code was already exchanged and its id_token verified by the server's own
    // callback, which handed the app a one-time code through its deep link (mobile-handoff.ts).
    // Redeeming it needs the state and nonce from /mobile-start, which only this app instance has.
    routes.openapi(createMobileExchangeRoute(provider), async (c) => {
      const { code, state, nonce } = c.req.valid("json");
      assertProviderConfigured(provider);

      const handoff = await redeemHandoff(stateStore, {
        code,
        state,
        nonce,
        provider,
        purpose: "login",
      });
      if (!handoff) {
        throw new CodedHttpException(
          400,
          ERROR_CODES.OAUTH_STATE_INVALID,
          "Invalid or expired OAuth state",
        );
      }

      const result = await loginReturningUser(db, config, {
        subject: handoff.identity.sub,
        provider,
        channel: "mobile",
        logger,
      });

      switch (result.outcome) {
        case "LOGIN_SUCCESS":
          return c.json(
            {
              access_token: result.tokens.accessToken,
              token_type: "Bearer" as const,
              expires_in: result.tokens.accessExpiresInSeconds,
              session_id: result.tokens.sessionId,
              refresh_token: result.tokens.refreshToken,
            },
            200,
          );
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
  }

  // GET /api/auth/oauth/{provider}/mobile-authorize?state=&nonce=&code_challenge=[&login_hint=]
  // Where the native app opens its system browser, for sign-in and invitation activation alike. The
  // server — not the app — knows the registered client and redirect URI, so it builds the provider
  // URL here; the provider then returns to the server's callback, which finishes the flow the state
  // was minted for. A plain redirect route, not part of the OpenAPI contract. Nothing here is
  // trusted: a mismatched state, nonce or challenge simply fails at the callback.
  routes.get("/api/auth/oauth/:provider/mobile-authorize", (c) => {
    const provider = c.req.param("provider");
    if (!isMobileProvider(provider)) {
      throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Unknown OAuth provider");
    }
    const state = c.req.query("state");
    const nonce = c.req.query("nonce");
    const codeChallenge = c.req.query("code_challenge");
    if (!state || !nonce || !codeChallenge) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.OAUTH_STATE_INVALID,
        "Missing state, nonce or code_challenge",
      );
    }

    return c.redirect(
      providerAuthorizationUrl(provider, {
        state,
        nonce,
        codeChallenge,
        loginHint: c.req.query("login_hint"),
      }),
      302,
    );
  });

  return routes;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOBILE_PROVIDERS = ["google", "microsoft", "mock"] as const;
type MobileProvider = (typeof MOBILE_PROVIDERS)[number];

function isMobileProvider(provider: string): provider is MobileProvider {
  return (MOBILE_PROVIDERS as readonly string[]).includes(provider);
}

function assertProviderConfigured(provider: MobileProvider): void {
  const configured =
    provider === "google"
      ? getGoogleOAuthConfig()
      : provider === "microsoft"
        ? getMicrosoftOAuthConfig()
        : getMockOAuthConfig();
  if (!configured) {
    throw new HTTPException(404, { message: `${provider} OAuth is not configured` });
  }
}

/**
 * The provider authorization URL for a native-app flow: the server's own client and registered
 * redirect URI, so the provider returns to the server's callback (see mobile-handoff.ts).
 */
export function providerAuthorizationUrl(
  provider: MobileProvider,
  params: { state: string; nonce: string; codeChallenge: string; loginHint?: string | undefined },
): string {
  const shared = {
    response_type: "code",
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  };

  if (provider === "google") {
    const config = getGoogleOAuthConfig();
    if (!config) throw new HTTPException(404, { message: "google OAuth is not configured" });
    const query = new URLSearchParams({
      ...shared,
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: GOOGLE_SCOPES,
    });
    return `${GOOGLE_AUTH_ENDPOINT}?${query.toString()}`;
  }

  if (provider === "microsoft") {
    const config = getMicrosoftOAuthConfig();
    if (!config) throw new HTTPException(404, { message: "microsoft OAuth is not configured" });
    const query = new URLSearchParams({
      ...shared,
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: MICROSOFT_SCOPES,
      response_mode: "query",
    });
    return `${MICROSOFT_AUTH_ENDPOINT}?${query.toString()}`;
  }

  const config = getMockOAuthConfig();
  if (!config) throw new HTTPException(404, { message: "mock OAuth is not configured" });
  const query = new URLSearchParams({
    ...shared,
    client_id: MOCK_OAUTH_CLIENT_ID,
    redirect_uri: config.redirectUri,
    scope: MOCK_OAUTH_SCOPES,
  });
  // The mock IdP has no account picker: login_hint selects which seeded persona signs in (dev/E2E).
  if (params.loginHint) query.set("login_hint", params.loginHint);
  return `${MOCK_AUTH_ENDPOINT(config.issuer)}?${query.toString()}`;
}
