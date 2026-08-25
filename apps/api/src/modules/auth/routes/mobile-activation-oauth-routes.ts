/**
 * Mobile invitation-activation OAuth routes (ST-215).
 *
 *   GET  /api/auth/invitations/{token}/oauth/{provider}/mobile-start
 *   POST /api/auth/invitations/{token}/oauth/{provider}/mobile-exchange
 *
 * The mobile arm of the same activation flow `activation-oauth-routes.ts` implements for the
 * browser. A browser gets a full-page redirect because the provider round trip needs one and the
 * activation service can set an HttpOnly cookie on the way back; a native app has neither a
 * navigable page to redirect nor a cookie jar worth trusting, so it drives the same PKCE exchange
 * itself against these two JSON endpoints — mirroring `mobile-oauth-routes.ts`'s split from the
 * browser-redirect login routes.
 *
 *   1. `/mobile-start` mints PKCE + nonce + state, binds the invitation token to that state (same
 *      state store shape `activation-oauth-routes.ts` uses, `purpose: "activation"`), and returns
 *      them as JSON so the app can open a system browser (ASWebAuthenticationSession / Custom Tabs)
 *      against the provider's authorization endpoint itself.
 *   2. The app captures the provider's redirect via its `studafy://auth/callback` deep link and
 *      posts `code` + `state` to `/mobile-exchange`, which validates the state, exchanges the code
 *      for an id_token, verifies it, and runs the same `activateAccount` transaction the web flow
 *      uses — with `channel: "mobile"`, so `deliverTokenPair` returns the refresh token in the JSON
 *      body instead of an HttpOnly cookie the app could never read.
 *
 * A lifecycle rejection (expired/revoked/consumed/suspended invitation, duplicate identity) and an
 * email-divergence REQUIRES_ADMIN_APPROVAL both surface as ordinary problem+json — there is no
 * redirect to bounce through, so unlike the browser callback this route lets `activateAccount`'s
 * `CodedHttpException` propagate exactly like the web `POST /activate` endpoint does.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../../coded-http-exception";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../channels";
import { deliverTokenPair } from "../delivery";
import { GOOGLE_TOKEN_ENDPOINT, getGoogleOAuthConfig } from "../oauth/config";
import { validateGoogleIdToken } from "../oauth/google-id-token";
import { MICROSOFT_TOKEN_ENDPOINT, getMicrosoftOAuthConfig } from "../oauth/microsoft-config";
import { validateMicrosoftIdToken } from "../oauth/microsoft-id-token";
import { MOBILE_OAUTH_REDIRECT_URI } from "../oauth/mobile-redirect";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateState,
} from "../oauth/pkce";
import { createStateStore } from "../oauth/state-store";
import { activateAccount } from "../services/activation-service";

import { activationPathParams, activationResponseSchema } from "./activation-schemas";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { ActivationProvider } from "../services/activation-service";
import type { SessionTokenConfig } from "../services/session-service";
import type { Context } from "hono";

type Provider = ActivationProvider;

const ACTIVATION_STATE_TTL_MS = 5 * 60 * 1000;

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  frontendUrl: string | undefined;
}

function providerConfig(provider: Provider): OAuthConfig {
  const config = provider === "google" ? getGoogleOAuthConfig() : getMicrosoftOAuthConfig();
  if (!config) {
    throw new HTTPException(404, { message: `${provider} OAuth is not configured` });
  }
  return config;
}

// ---------------------------------------------------------------------------
// Schemas — distinct component names from mobile-oauth-routes.ts's login shapes even though the
// fields line up field-for-field, since they describe a different operation (activation, not
// login) and zod-openapi registers components by that name.
// ---------------------------------------------------------------------------

const invitationMobileStartResponseSchema = z
  .object({
    state: z.string().describe("OAuth state parameter. Pass back in the exchange request."),
    nonce: z.string().describe("OIDC nonce. Pass back in the exchange request."),
    code_challenge: z
      .string()
      .describe("PKCE S256 code_challenge derived from the code_verifier stored server-side."),
  })
  .openapi("ActivateInvitationMobileStartResponse");

const invitationMobileExchangeRequestSchema = z
  .object({
    code: z.string().min(1).describe("Authorization code from the IdP callback."),
    state: z.string().min(1).describe("State parameter returned by the mobile-start endpoint."),
    nonce: z.string().min(1).describe("Nonce returned by the mobile-start endpoint."),
  })
  .openapi("ActivateInvitationMobileExchangeRequest");

// ---------------------------------------------------------------------------
// Route definitions — one static path per provider, matching mobile-oauth-routes.ts rather than
// activation-oauth-routes.ts's dynamic `:provider` segment, since createRoute needs a fixed path
// template per OpenAPI operation.
// ---------------------------------------------------------------------------

function providerLabel(provider: Provider): string {
  return provider === "google" ? "Google" : "Microsoft";
}

function createInvitationMobileStartRoute(provider: Provider) {
  return createRoute({
    method: "get",
    path: `/api/auth/invitations/{token}/oauth/${provider}/mobile-start`,
    tags: ["Invitations"],
    operationId: `activateInvitation${providerLabel(provider)}MobileStart`,
    summary: `Start a mobile ${provider} OAuth session for invitation activation`,
    description:
      `Generates PKCE, state, and nonce parameters for a mobile invitation-activation flow using ` +
      `${provider}, bound to the invitation token in the path. Returns them as JSON so the mobile ` +
      "app can construct the authorization URL and open a system browser. The code_verifier is " +
      "stored server-side keyed by the state parameter.",
    security: [],
    request: { params: activationPathParams },
    responses: standardResponses(
      {
        200: {
          description: "PKCE parameters for the mobile authorization request.",
          schema: invitationMobileStartResponseSchema,
        },
      },
      [400, 404, 429],
    ),
  });
}

function createInvitationMobileExchangeRoute(provider: Provider) {
  return createRoute({
    method: "post",
    path: `/api/auth/invitations/{token}/oauth/${provider}/mobile-exchange`,
    tags: ["Invitations"],
    operationId: `activateInvitation${providerLabel(provider)}MobileExchange`,
    summary: `Exchange a ${provider} authorization code to activate an invitation (mobile)`,
    description:
      `Validates the PKCE state, exchanges the authorization code with ${provider}'s token ` +
      "endpoint, verifies the id_token, and runs the same account-activation transaction as " +
      "POST /api/auth/invitations/{token}/activate — with channel=mobile, so the refresh token is " +
      "returned in the response body instead of an HttpOnly cookie.",
    security: [],
    request: {
      params: activationPathParams,
      body: {
        required: true,
        content: { "application/json": { schema: invitationMobileExchangeRequestSchema } },
      },
    },
    responses: standardResponses(
      {
        200: {
          description: "Account activated. Returns the first session token pair.",
          schema: activationResponseSchema,
        },
      },
      [400, 403, 404, 409, 429, 500],
    ),
  });
}

// ---------------------------------------------------------------------------
// Shared exchange logic — takes plain values rather than a Hono Context so both providers' typed
// handlers (each with their own route-specific `c.req.valid()` shape) can delegate to one place.
// ---------------------------------------------------------------------------

interface ExchangeInput {
  token: string;
  code: string;
  state: string;
  nonce: string;
}

interface ExchangeSuccessBody {
  status: "active";
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  session_id: string;
  refresh_token?: string;
}

async function runMobileExchange(
  c: Context<AppEnv>,
  db: Database,
  sessionConfig: SessionTokenConfig,
  stateStore: ReturnType<typeof createStateStore>,
  provider: Provider,
  logger: Logger,
  input: ExchangeInput,
): Promise<ExchangeSuccessBody> {
  const oauthConfig = providerConfig(provider);

  const entry = stateStore.get(input.state);
  if (!entry || entry.purpose !== "activation" || entry.token !== input.token) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.OAUTH_STATE_INVALID,
      "Invalid or expired activation state",
    );
  }
  stateStore.delete(input.state);

  if (entry.nonce !== input.nonce) {
    throw new CodedHttpException(400, ERROR_CODES.OAUTH_STATE_INVALID, "Nonce does not match");
  }

  try {
    // The verifier never left the server (the client only ever saw its S256 hash, sent to the IdP
    // as code_challenge at /mobile-start), so the exchange uses the one this state entry was
    // minted with rather than trusting anything the client could supply.
    const idToken = await exchangeCode(
      provider === "google" ? GOOGLE_TOKEN_ENDPOINT : MICROSOFT_TOKEN_ENDPOINT,
      { ...oauthConfig, redirectUri: MOBILE_OAUTH_REDIRECT_URI },
      input.code,
      entry.codeVerifier,
    );

    const claims =
      provider === "google"
        ? await validateGoogleIdToken(idToken, oauthConfig.clientId, input.nonce)
        : await validateMicrosoftIdToken(idToken, oauthConfig.clientId, input.nonce);

    const result = await activateAccount(db, sessionConfig, {
      rawToken: input.token,
      identity: { provider, subject: claims.sub, email: claims.email },
      channel: AUTH_CHANNELS.MOBILE,
      device: { userAgent: c.req.header("user-agent") ?? null },
      requestId: c.get("requestId"),
      logger,
    });

    if (result.outcome === "REQUIRES_ADMIN_APPROVAL") {
      throw new CodedHttpException(
        403,
        ERROR_CODES.REQUIRES_ADMIN_APPROVAL,
        "Activation requires administrator approval.",
      );
    }

    const body = deliverTokenPair(c, result.tokens);
    return { status: "active" as const, ...body };
  } catch (error) {
    if (error instanceof CodedHttpException) throw error;
    if (error instanceof HTTPException) {
      throw new CodedHttpException(
        502,
        ERROR_CODES.OAUTH_PROVIDER_ERROR,
        `Failed to exchange authorization code with ${provider}`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Route group factory
// ---------------------------------------------------------------------------

/**
 * Build the mobile invitation-activation route group.
 *
 * Requires a database and a session-token config, like the browser-redirect activation routes it
 * sits beside. Public — the invitation token in the path is the credential.
 */
export function mobileActivationOAuthRoutes(
  db: Database,
  config: SessionTokenConfig,
  logger: Logger,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const stateStore = createStateStore(ACTIVATION_STATE_TTL_MS);

  // ----- Google -----

  routes.openapi(createInvitationMobileStartRoute("google"), (c) => {
    const { token } = c.req.valid("param");
    providerConfig("google");

    const state = generateState();
    const nonce = generateNonce();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    stateStore.set(state, {
      codeVerifier,
      nonce,
      createdAt: Date.now(),
      purpose: "activation",
      token,
    });

    return c.json({ state, nonce, code_challenge: codeChallenge }, 200);
  });

  routes.openapi(createInvitationMobileExchangeRoute("google"), async (c) => {
    const { token } = c.req.valid("param");
    const { code, state, nonce } = c.req.valid("json");
    const body = await runMobileExchange(c, db, config, stateStore, "google", logger, {
      token,
      code,
      state,
      nonce,
    });
    return c.json(body, 200);
  });

  // ----- Microsoft -----

  routes.openapi(createInvitationMobileStartRoute("microsoft"), (c) => {
    const { token } = c.req.valid("param");
    providerConfig("microsoft");

    const state = generateState();
    const nonce = generateNonce();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    stateStore.set(state, {
      codeVerifier,
      nonce,
      createdAt: Date.now(),
      purpose: "activation",
      token,
    });

    return c.json({ state, nonce, code_challenge: codeChallenge }, 200);
  });

  routes.openapi(createInvitationMobileExchangeRoute("microsoft"), async (c) => {
    const { token } = c.req.valid("param");
    const { code, state, nonce } = c.req.valid("json");
    const body = await runMobileExchange(c, db, config, stateStore, "microsoft", logger, {
      token,
      code,
      state,
      nonce,
    });
    return c.json(body, 200);
  });

  return routes;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function exchangeCode(
  tokenEndpoint: string,
  oauthConfig: OAuthConfig,
  code: string,
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
    throw new HTTPException(502, { message: "Failed to reach OAuth token endpoint" });
  }

  if (!tokenResponse.ok) {
    throw new HTTPException(502, { message: "Failed to exchange authorization code" });
  }

  const tokenData = (await tokenResponse.json()) as { id_token?: string };
  if (!tokenData.id_token) {
    throw new HTTPException(502, { message: "OAuth provider did not return an id_token" });
  }

  return tokenData.id_token;
}
