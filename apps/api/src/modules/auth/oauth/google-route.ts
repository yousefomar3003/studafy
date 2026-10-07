/**
 * Google OAuth (OIDC) routes.
 *
 * Two endpoints:
 *   GET /api/auth/oauth/google/start    — redirects to Google's authorization endpoint
 *   GET /api/auth/oauth/google/callback — exchanges the code, validates the id_token, then finishes
 *                                         whichever browser flow minted the state
 *
 * Both are public (no bearer token required). The start endpoint generates state, nonce, and PKCE
 * parameters and stores them in the shared OAuth state store (state-store.ts) keyed by state.
 *
 * The callback is Google's one registered redirect URI, so it serves every flow that sends a user
 * to Google — not just login. After validating the state, exchanging the code, and verifying the
 * id_token, it dispatches on the entry's `flow` (callback-flows.ts):
 *   - `login`      — finds the user via app.oauth_identities and issues a token pair
 *   - `activation` — activates the invitation the state was bound to (activation-oauth-routes.ts)
 *   - `link`       — links Google to the signed-in user who started the link (provider-link-routes.ts)
 *   - `mobile-login` / `mobile-activation` — hands the verified identity to the native app through
 *     its deep link (mobile-handoff.ts)
 *
 * These are browser-redirect endpoints, not JSON API endpoints, so they use plain Hono routes
 * rather than OpenAPI-typed routes. The primary responses are HTTP redirects, not JSON bodies.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { openApiValidationHook } from "../../../openapi/hook";
import { deliverTokenPair } from "../delivery";
import { findOAuthIdentity } from "../services/returning-user-login-service";
import { issueTokenPair } from "../services/session-service";

import {
  cancelledRedirect,
  failureRedirect,
  finishFlow,
  takeAuthorization,
} from "./callback-flows";
import {
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_SCOPES,
  getGoogleOAuthConfig,
} from "./config";
import { validateGoogleIdToken } from "./google-id-token";
import { generateCodeChallenge, generateCodeVerifier, generateNonce, generateState } from "./pkce";

import type { CallbackContext } from "./callback-flows";
import type { AuthorizationEntry, StateStore } from "./state-store";
import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { SessionTokenConfig } from "../services/session-service";

// ---------------------------------------------------------------------------
// Route group factory
// ---------------------------------------------------------------------------

export interface GoogleOAuthDependencies {
  /** The process-wide OAuth state store, shared with every flow that returns through this callback. */
  stateStore: StateStore;
  /** Config loader. Tests inject a stub so no process-wide module mock is needed. */
  getOAuthConfig?: typeof getGoogleOAuthConfig;
  /** id_token validator. Tests inject a stub to skip the JWKS round trip. */
  validateIdToken?: typeof validateGoogleIdToken;
}

export function googleOAuthRoutes(
  db: Database,
  config: SessionTokenConfig,
  logger: Logger,
  deps: GoogleOAuthDependencies,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  const { stateStore } = deps;
  const getOAuthConfig = deps.getOAuthConfig ?? getGoogleOAuthConfig;
  const validateIdToken = deps.validateIdToken ?? validateGoogleIdToken;

  // GET /api/auth/oauth/google/start
  // Generates PKCE + state + nonce, stores them, and redirects to Google.
  routes.get("/api/auth/oauth/google/start", async (c) => {
    const oauthConfig = getOAuthConfig();
    if (!oauthConfig) {
      throw new HTTPException(404, { message: "Google OAuth is not configured" });
    }

    const state = generateState();
    const nonce = generateNonce();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    await stateStore.set(state, { flow: "login", provider: "google", codeVerifier, nonce });

    const params = new URLSearchParams({
      client_id: oauthConfig.clientId,
      redirect_uri: oauthConfig.redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      access_type: "offline",
    });

    return c.redirect(`${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`, 302);
  });

  // GET /api/auth/oauth/google/callback
  // Google redirects here with code + state. We exchange the code, validate the id_token, and
  // finish the flow the state was minted for (callback-flows.ts).
  routes.get("/api/auth/oauth/google/callback", async (c) => {
    const oauthConfig = getOAuthConfig();
    if (!oauthConfig) {
      throw new HTTPException(404, { message: "Google OAuth is not configured" });
    }
    const ctx: CallbackContext = {
      db,
      sessionConfig: config,
      logger,
      stateStore,
      provider: "google",
      frontendUrl: oauthConfig.frontendUrl,
    };

    if (c.req.query("error")) return cancelledRedirect(c, ctx);

    let entry: AuthorizationEntry | undefined;
    try {
      const code = c.req.query("code");
      const state = c.req.query("state");

      if (!code || !state) {
        throw new CodedHttpException(
          400,
          ERROR_CODES.OAUTH_STATE_INVALID,
          "Missing code or state parameter",
        );
      }

      // 1. Validate state — single use, and only an authorization minted for Google.
      entry = await takeAuthorization(ctx, state);

      // 2. Exchange authorization code for tokens
      const idToken = await exchangeCode(code, oauthConfig, entry.codeVerifier);

      // 3. Validate id_token
      const claims = await validateIdToken(idToken, oauthConfig.clientId, entry.nonce);

      // 4. Finish an invitation, a link, or a native-app sign-in; a browser login continues below.
      const finished = await finishFlow(c, ctx, entry, state, claims);
      if (finished) return finished;

      const identity = await findOAuthIdentity(db, "google", claims.sub);
      if (!identity) {
        logger.warn({ sub: claims.sub, email: claims.email }, "OAuth identity not found");
        throw new CodedHttpException(
          403,
          ERROR_CODES.AUTHZ_FORBIDDEN,
          "Account not found. Contact your administrator.",
        );
      }

      // 5. Issue token pair inside a tenant transaction
      const issued = await withTenantTx(
        db,
        { schoolId: identity.schoolId, userId: identity.userId },
        (tx) =>
          issueTokenPair(tx, config, {
            userId: identity.userId,
            schoolId: identity.schoolId,
            channel: "web",
          }),
      );

      // 6. Set refresh cookie and redirect to frontend
      deliverTokenPair(c, issued);
      return c.redirect(new URL("/auth/callback", oauthConfig.frontendUrl ?? "/").toString(), 302);
    } catch (error) {
      return failureRedirect(c, ctx, entry, error);
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
  oauthConfig: TokenExchangeConfig,
  codeVerifier: string,
): Promise<string> {
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(GOOGLE_TOKEN_ENDPOINT, {
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
    throw new HTTPException(502, { message: "Failed to reach Google token endpoint" });
  }

  if (!tokenResponse.ok) {
    throw new HTTPException(502, { message: "Failed to exchange authorization code" });
  }

  const tokenData = (await tokenResponse.json()) as { id_token?: string };
  if (!tokenData.id_token) {
    throw new HTTPException(502, { message: "Google did not return an id_token" });
  }

  return tokenData.id_token;
}
