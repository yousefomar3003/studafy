/**
 * Activation OAuth routes (ST-078, browser-redirect arm).
 *
 *   GET /api/auth/invitations/{token}/oauth/{provider}/start
 *   GET /api/auth/oauth/{provider}/invitation/callback
 *
 * The activation flow needs an OIDC identity, and an invited user has no account to authenticate
 * with — so the browser cannot go through the login OAuth flow (which resolves an existing
 * `oauth_identities` row). These two endpoints give the web invitee the same full-page redirect
 * experience as every other OAuth flow, but drive `activateAccount` instead of a login or a link:
 *
 *   1. The start endpoint stores PKCE + nonce + the invitation token against a `state` value and
 *      redirects to the provider's authorization endpoint (the invite token in the path is the
 *      credential, exactly as on `POST /api/auth/invitations/{token}/activate`).
 *   2. The provider bounces the browser back to the callback with `code` + `state`. The callback
 *      validates the state, exchanges the code for an id_token, verifies it against the provider's
 *      JWKS with the stored nonce, and runs the activation transaction.
 *   3. On success the refresh cookie is delivered and the browser lands on
 *      `/invite/{token}/complete`. An admin-approval divergence lands on the same route with
 *      `?outcome=requires_admin_approval`. Every other failure redirects back to `/invite/{token}`,
 *      where the page re-verifies the invitation and renders its current lifecycle state — the
 *      failure-rendering logic lives in exactly one place.
 *
 * These are plain Hono routes (redirect responses, not JSON), like the OAuth callbacks. They are
 * public: GETs carry no ambient authority, and the refresh cookie is only ever set on a verified
 * activation. The `state` store is shared with the login and provider-link flows; `purpose`
 * disambiguates.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../../coded-http-exception";
import { openApiValidationHook } from "../../../openapi/hook";
import { AUTH_CHANNELS } from "../channels";
import { deliverTokenPair } from "../delivery";
import {
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_ENDPOINT,
  getGoogleOAuthConfig,
} from "../oauth/config";
import { validateGoogleIdToken } from "../oauth/google-id-token";
import {
  MICROSOFT_AUTH_ENDPOINT,
  MICROSOFT_SCOPES,
  MICROSOFT_TOKEN_ENDPOINT,
  getMicrosoftOAuthConfig,
} from "../oauth/microsoft-config";
import { validateMicrosoftIdToken } from "../oauth/microsoft-id-token";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateState,
} from "../oauth/pkce";
import { createStateStore } from "../oauth/state-store";
import { activateAccount } from "../services/activation-service";

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

function authorizationParams(
  provider: Provider,
  config: OAuthConfig,
  state: string,
  nonce: string,
  codeChallenge: string,
): URLSearchParams {
  const shared = {
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: provider === "google" ? GOOGLE_SCOPES : MICROSOFT_SCOPES,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  };
  return provider === "google"
    ? new URLSearchParams(shared)
    : new URLSearchParams({ ...shared, response_mode: "query" });
}

/**
 * Build the activation route group.
 *
 * Requires a database and a session-token config (key store + issuer/audience/TTLs), like the
 * OAuth groups it sits beside. Public — no bearer token required.
 */
export function activationOAuthRoutes(
  db: Database,
  config: SessionTokenConfig,
  logger: Logger,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const stateStore = createStateStore(ACTIVATION_STATE_TTL_MS);

  // GET /api/auth/invitations/{token}/oauth/{provider}/start
  // Generates PKCE + state + nonce, binds them to the invitation token, and redirects to the
  // provider. The token is not validated here — the invite page has already verified it before
  // rendering the provider buttons, and the authoritative lifecycle check happens under the
  // activation transaction's lock.
  routes.get("/api/auth/invitations/:token/oauth/:provider/start", async (c) => {
    const { token, provider } = c.req.param();
    assertProvider(provider);

    const config = providerConfig(provider);
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

    const authEndpoint = provider === "google" ? GOOGLE_AUTH_ENDPOINT : MICROSOFT_AUTH_ENDPOINT;
    const params = authorizationParams(provider, config, state, nonce, codeChallenge);
    return c.redirect(`${authEndpoint}?${params.toString()}`, 302);
  });

  // GET /api/auth/oauth/{provider}/invitation/callback
  // The provider redirects here with code + state after the invitee signs in.
  routes.get("/api/auth/oauth/:provider/invitation/callback", async (c) => {
    const provider = c.req.param("provider");
    assertProvider(provider);
    return handleActivationCallback(c, db, config, stateStore, provider, logger);
  });

  return routes;
}

async function handleActivationCallback(
  c: Context<AppEnv>,
  db: Database,
  sessionConfig: SessionTokenConfig,
  stateStore: ReturnType<typeof createStateStore>,
  provider: Provider,
  logger: Logger,
): Promise<Response> {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const oauthConfig = providerConfig(provider);

  if (!code || !state) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.OAUTH_STATE_INVALID,
      "Missing code or state parameter",
    );
  }

  // 1. Validate state — the entry must be an activation flow, and it must carry the invitation
  // token. The token in the path of the start endpoint is not re-checked here because the state
  // store holds the authoritative token for this flow; a mismatch is a forged or expired state.
  const entry = stateStore.get(state);
  if (!entry || entry.purpose !== "activation" || !entry.token) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.OAUTH_STATE_INVALID,
      "Invalid or expired activation state",
    );
  }
  stateStore.delete(state);
  const token = entry.token;

  // 2. Exchange the authorization code for an id_token.
  const idToken = await exchangeCode(
    provider === "google" ? GOOGLE_TOKEN_ENDPOINT : MICROSOFT_TOKEN_ENDPOINT,
    oauthConfig,
    code,
    entry.codeVerifier,
  );

  // 3. Validate the id_token against the provider's JWKS with the stored nonce.
  const claims =
    provider === "google"
      ? await validateGoogleIdToken(idToken, oauthConfig.clientId, entry.nonce)
      : await validateMicrosoftIdToken(idToken, oauthConfig.clientId, entry.nonce);

  // 4. Run the atomic activation transaction. A lifecycle rejection (expired/revoked/consumed/
  // suspended invitation, duplicate identity) bounces back to the invite page, which re-verifies
  // and renders the current state — the failure UI lives in one place. A genuinely broken exchange
  // (unreachable provider, bad JWKS) still propagates to the global error handler.
  let result;
  try {
    result = await activateAccount(db, sessionConfig, {
      rawToken: token,
      identity: {
        provider,
        subject: claims.sub,
        email: claims.email,
      },
      channel: AUTH_CHANNELS.WEB,
      device: { userAgent: c.req.header("user-agent") ?? null },
      requestId: c.get("requestId"),
      logger,
    });
  } catch (error) {
    if (error instanceof CodedHttpException) {
      return c.redirect(activationFrontendUrl(oauthConfig, token), 302);
    }
    throw error;
  }

  const frontendUrl = oauthConfig.frontendUrl ?? "/";
  const base = new URL(`/invite/${token}/complete`, frontendUrl);

  if (result.outcome === "REQUIRES_ADMIN_APPROVAL") {
    base.searchParams.set("outcome", "requires_admin_approval");
    return c.redirect(base.toString(), 302);
  }

  // 5. Success: deliver the refresh cookie and bounce to the frontend completion route. The
  // access token rides in the HttpOnly session, so it never appears in a redirect URL.
  deliverTokenPair(c, result.tokens);
  return c.redirect(base.toString(), 302);
}

function activationFrontendUrl(oauthConfig: OAuthConfig, token: string): string {
  const url = new URL(`/invite/${token}`, oauthConfig.frontendUrl ?? "/");
  return url.toString();
}

function assertProvider(provider: string): asserts provider is Provider {
  if (provider !== "google" && provider !== "microsoft") {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Unknown OAuth provider");
  }
}

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
