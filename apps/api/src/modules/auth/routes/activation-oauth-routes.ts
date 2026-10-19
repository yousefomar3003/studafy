/**
 * Activation OAuth routes (ST-078, browser-redirect arm).
 *
 *   GET /api/auth/invitations/{token}/oauth/{provider}/start
 *
 * The activation flow needs an OIDC identity, and an invited user has no account to authenticate
 * with — so the browser cannot go through the login OAuth flow (which resolves an existing
 * `oauth_identities` row). This gives the web invitee the same full-page redirect experience as
 * every other OAuth flow, but drives `activateAccount` instead of a login or a link:
 *
 *   1. The start endpoint stores PKCE + nonce + the invitation token against a `state` value
 *      (`flow: "activation"`) and redirects to the provider's authorization endpoint (the invite
 *      token in the path is the credential, exactly as on `POST /api/auth/invitations/{token}/activate`).
 *   2. The provider bounces the browser back to its one registered redirect URI — the same
 *      `/api/auth/oauth/{provider}/callback` the login flow uses. That callback validates the state,
 *      exchanges the code, verifies the id_token with the stored nonce, sees `flow: "activation"`,
 *      and hands the verified identity to {@link completeWebActivation} below.
 *   3. On success the refresh cookie is delivered and the browser lands on
 *      `/invite/{token}/complete`. An admin-approval divergence lands on the same route with
 *      `?outcome=requires_admin_approval`. Every other failure redirects back to `/invite/{token}`,
 *      where the page re-verifies the invitation and renders its current lifecycle state — the
 *      failure-rendering logic lives in exactly one place.
 *
 * Sharing the login callback is what lets a deployment register a single redirect URI per provider
 * (`GOOGLE_OAUTH_REDIRECT_URI`, …) and still have activation work: the authorization request has to
 * carry a redirect URI the provider accepts, and the token exchange has to repeat it exactly.
 *
 * Public: GETs carry no ambient authority, and the refresh cookie is only ever set on a verified
 * activation.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../../coded-http-exception";
import { openApiValidationHook } from "../../../openapi/hook";
import { AUTH_CHANNELS } from "../channels";
import { deliverTokenPair } from "../delivery";
import { GOOGLE_AUTH_ENDPOINT, GOOGLE_SCOPES, getGoogleOAuthConfig } from "../oauth/config";
import {
  MICROSOFT_AUTH_ENDPOINT,
  MICROSOFT_SCOPES,
  getMicrosoftOAuthConfig,
} from "../oauth/microsoft-config";
import {
  MOCK_AUTH_ENDPOINT,
  MOCK_OAUTH_CLIENT_ID,
  MOCK_OAUTH_SCOPES,
  getMockOAuthConfig,
} from "../oauth/mock-config";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateState,
} from "../oauth/pkce";
import { activateAccount } from "../services/activation-service";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { StateStore } from "../oauth/state-store";
import type { ActivationProvider } from "../services/activation-service";
import type { SessionTokenConfig } from "../services/session-service";
import type { Context } from "hono";

type Provider = ActivationProvider;

interface AuthorizeConfig {
  clientId: string;
  redirectUri: string;
  authEndpoint: string;
  scope: string;
}

/**
 * Normalizes each provider's config to what the authorization redirect needs. The mock provider has
 * no fixed client id registry, so it gets a nominal `clientId` (MOCK_OAUTH_CLIENT_ID).
 */
function authorizeConfig(provider: Provider): AuthorizeConfig {
  if (provider === "mock") {
    const config = getMockOAuthConfig();
    if (!config) throw new HTTPException(404, { message: "mock OAuth is not configured" });
    return {
      clientId: MOCK_OAUTH_CLIENT_ID,
      redirectUri: config.redirectUri,
      authEndpoint: MOCK_AUTH_ENDPOINT(config.issuer),
      scope: MOCK_OAUTH_SCOPES,
    };
  }
  const config = provider === "google" ? getGoogleOAuthConfig() : getMicrosoftOAuthConfig();
  if (!config) {
    throw new HTTPException(404, { message: `${provider} OAuth is not configured` });
  }
  return {
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    authEndpoint: provider === "google" ? GOOGLE_AUTH_ENDPOINT : MICROSOFT_AUTH_ENDPOINT,
    scope: provider === "google" ? GOOGLE_SCOPES : MICROSOFT_SCOPES,
  };
}

export interface ActivationOAuthDependencies {
  /** The process-wide OAuth state store, shared with the provider callbacks that redeem it. */
  stateStore: StateStore;
}

/**
 * Build the activation route group.
 *
 * Public — no bearer token required; the invitation token in the path is the credential.
 */
export function activationOAuthRoutes({
  stateStore,
}: ActivationOAuthDependencies): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // GET /api/auth/invitations/{token}/oauth/{provider}/start
  // Generates PKCE + state + nonce, binds them to the invitation token, and redirects to the
  // provider. The token is not validated here — the invite page has already verified it before
  // rendering the provider buttons, and the authoritative lifecycle check happens under the
  // activation transaction's lock.
  routes.get("/api/auth/invitations/:token/oauth/:provider/start", async (c) => {
    const { token, provider } = c.req.param();
    assertProvider(provider);

    const config = authorizeConfig(provider);
    const state = generateState();
    const nonce = generateNonce();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    await stateStore.set(state, { flow: "activation", provider, codeVerifier, nonce, token });

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: config.scope,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    if (provider === "microsoft") params.set("response_mode", "query");
    // The mock IdP has no consent screen or account picker: whichever seeded persona's email is
    // passed here is who the callback activates as. A real IdP resolves this from whoever is signed
    // in there instead — see mock-route.ts's identical use for the login (not activation) flow.
    const loginHint = c.req.query("login_hint");
    if (provider === "mock" && loginHint) params.set("login_hint", loginHint);

    return c.redirect(`${config.authEndpoint}?${params.toString()}`, 302);
  });

  return routes;
}

export interface WebActivationContext {
  db: Database;
  sessionConfig: SessionTokenConfig;
  logger: Logger;
}

export interface WebActivationInput {
  provider: Provider;
  /** The invitation token the state entry was bound to at start. */
  token: string;
  /** The identity the provider callback has already verified (id_token signature, nonce, audience). */
  identity: { sub: string; email: string };
  frontendUrl: string | undefined;
}

/**
 * Finish a browser activation once the provider callback has verified the identity.
 *
 * A lifecycle rejection (expired/revoked/consumed/suspended invitation, duplicate identity) bounces
 * back to the invite page, which re-verifies and renders the current state — the failure UI lives
 * in one place. Anything else propagates to the caller.
 */
export async function completeWebActivation(
  c: Context<AppEnv>,
  { db, sessionConfig, logger }: WebActivationContext,
  { provider, token, identity, frontendUrl }: WebActivationInput,
): Promise<Response> {
  const base = frontendUrl ?? "/";

  let result;
  try {
    result = await activateAccount(db, sessionConfig, {
      rawToken: token,
      identity: { provider, subject: identity.sub, email: identity.email },
      channel: AUTH_CHANNELS.WEB,
      device: { userAgent: c.req.header("user-agent") ?? null },
      requestId: c.get("requestId"),
      logger,
    });
  } catch (error) {
    if (error instanceof CodedHttpException) {
      return c.redirect(new URL(`/invite/${token}`, base).toString(), 302);
    }
    throw error;
  }

  const complete = new URL(`/invite/${token}/complete`, base);

  if (result.outcome === "REQUIRES_ADMIN_APPROVAL") {
    complete.searchParams.set("outcome", "requires_admin_approval");
    return c.redirect(complete.toString(), 302);
  }

  // Success: deliver the refresh cookie and bounce to the frontend completion route. The access
  // token rides in the HttpOnly session, so it never appears in a redirect URL.
  deliverTokenPair(c, result.tokens);
  return c.redirect(complete.toString(), 302);
}

function assertProvider(provider: string): asserts provider is Provider {
  if (provider !== "google" && provider !== "microsoft" && provider !== "mock") {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Unknown OAuth provider");
  }
}
