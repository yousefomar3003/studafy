/**
 * Microsoft OAuth (OIDC) routes.
 *
 * Two endpoints:
 *   GET /api/auth/oauth/microsoft/start    — redirects to Microsoft's authorization endpoint
 *   GET /api/auth/oauth/microsoft/callback — exchanges the code, validates the id_token, then
 *                                            finishes whichever browser flow minted the state
 *
 * Both are public (no bearer token required). The start endpoint generates state, nonce, and PKCE
 * parameters and stores them in the shared OAuth state store (state-store.ts) keyed by state.
 *
 * The callback is Microsoft's one registered redirect URI, so it serves every browser flow — login,
 * invitation activation, and provider linking — dispatching on the state entry's `flow` exactly as
 * google-route.ts does.
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
import { completeWebActivation } from "../routes/activation-oauth-routes";
import { completeWebLink } from "../routes/provider-link-routes";
import { findOAuthIdentity } from "../services/returning-user-login-service";
import { issueTokenPair } from "../services/session-service";

import { oauthErrorUrl } from "./error-redirect";
import {
  MICROSOFT_AUTH_ENDPOINT,
  MICROSOFT_SCOPES,
  MICROSOFT_TOKEN_ENDPOINT,
  getMicrosoftOAuthConfig,
} from "./microsoft-config";
import { validateMicrosoftIdToken } from "./microsoft-id-token";
import { generateCodeChallenge, generateCodeVerifier, generateNonce, generateState } from "./pkce";
import { isBrowserFlow } from "./state-store";

import type { StateStore } from "./state-store";
import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { SessionTokenConfig } from "../services/session-service";

// ---------------------------------------------------------------------------
// Route group factory
// ---------------------------------------------------------------------------

export interface MicrosoftOAuthDependencies {
  /** The process-wide OAuth state store, shared with every flow that returns through this callback. */
  stateStore: StateStore;
  /** Config loader. Tests inject a stub so no process-wide module mock is needed. */
  getOAuthConfig?: typeof getMicrosoftOAuthConfig;
  /** id_token validator. Tests inject a stub to skip the JWKS round trip. */
  validateIdToken?: typeof validateMicrosoftIdToken;
}

export function microsoftOAuthRoutes(
  db: Database,
  config: SessionTokenConfig,
  logger: Logger,
  deps: MicrosoftOAuthDependencies,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  const { stateStore } = deps;
  const getOAuthConfig = deps.getOAuthConfig ?? getMicrosoftOAuthConfig;
  const validateIdToken = deps.validateIdToken ?? validateMicrosoftIdToken;

  // GET /api/auth/oauth/microsoft/start
  // Generates PKCE + state + nonce, stores them, and redirects to Microsoft.
  routes.get("/api/auth/oauth/microsoft/start", async (c) => {
    const oauthConfig = getOAuthConfig();
    if (!oauthConfig) {
      throw new HTTPException(404, { message: "Microsoft OAuth is not configured" });
    }

    const state = generateState();
    const nonce = generateNonce();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    await stateStore.set(state, { flow: "login", provider: "microsoft", codeVerifier, nonce });

    const params = new URLSearchParams({
      client_id: oauthConfig.clientId,
      redirect_uri: oauthConfig.redirectUri,
      response_type: "code",
      scope: MICROSOFT_SCOPES,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      response_mode: "query",
    });

    return c.redirect(`${MICROSOFT_AUTH_ENDPOINT}?${params.toString()}`, 302);
  });

  // GET /api/auth/oauth/microsoft/callback
  // Microsoft redirects here with code + state. We exchange the code, validate the id_token, and
  // finish the flow the state was minted for.
  routes.get("/api/auth/oauth/microsoft/callback", async (c) => {
    const oauthConfig = getOAuthConfig();
    if (!oauthConfig) {
      throw new HTTPException(404, { message: "Microsoft OAuth is not configured" });
    }
    const frontendUrl = oauthConfig.frontendUrl ?? "/";

    // The user declined Microsoft's consent screen: Microsoft bounces back with `error` and no
    // `code`. Nothing is broken, so redirect to the frontend's friendly "cancelled" state rather
    // than an error page.
    if (c.req.query("error")) {
      return c.redirect(oauthErrorUrl(frontendUrl, ERROR_CODES.OAUTH_CANCELLED), 302);
    }

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

      // 1. Validate state — single use, and only a browser flow minted for Microsoft.
      const entry = await stateStore.take(state);
      if (!entry || entry.provider !== "microsoft" || !isBrowserFlow(entry.flow)) {
        throw new CodedHttpException(
          400,
          ERROR_CODES.OAUTH_STATE_INVALID,
          "Invalid or expired OAuth state",
        );
      }

      // 2. Exchange authorization code for tokens
      const idToken = await exchangeCode(code, oauthConfig, entry.codeVerifier);

      // 3. Validate id_token
      const claims = await validateIdToken(idToken, oauthConfig.clientId, entry.nonce);

      // 4. Finish the flow this state belongs to.
      if (entry.flow === "activation" && entry.token) {
        return await completeWebActivation(
          c,
          { db, sessionConfig: config, logger },
          {
            provider: "microsoft",
            token: entry.token,
            identity: claims,
            frontendUrl: oauthConfig.frontendUrl,
          },
        );
      }
      if (entry.flow === "link" && entry.userId && entry.schoolId) {
        return await completeWebLink(c, db, logger, {
          provider: "microsoft",
          userId: entry.userId,
          schoolId: entry.schoolId,
          identity: claims,
          frontendUrl: oauthConfig.frontendUrl,
        });
      }
      if (entry.flow !== "login") {
        throw new CodedHttpException(
          400,
          ERROR_CODES.OAUTH_STATE_INVALID,
          "Invalid or expired OAuth state",
        );
      }

      const identity = await findOAuthIdentity(db, "microsoft", claims.sub);
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
      const redirectUrl = new URL("/auth/callback", frontendUrl);

      return c.redirect(redirectUrl.toString(), 302);
    } catch (error) {
      // The browser is mid-round-trip on a real tab: an authored failure (bad state, unknown
      // account, unverified email, …) and an exchange-level failure (unreachable provider) both
      // redirect to the frontend error page so the user sees guidance, never raw JSON at the API
      // origin. Anything unexpected still propagates to the global error handler.
      if (error instanceof CodedHttpException) {
        return c.redirect(oauthErrorUrl(frontendUrl, error.code), 302);
      }
      if (error instanceof HTTPException) {
        return c.redirect(oauthErrorUrl(frontendUrl, ERROR_CODES.OAUTH_PROVIDER_ERROR), 302);
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
  oauthConfig: TokenExchangeConfig,
  codeVerifier: string,
): Promise<string> {
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(MICROSOFT_TOKEN_ENDPOINT, {
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
    throw new HTTPException(502, { message: "Failed to reach Microsoft token endpoint" });
  }

  if (!tokenResponse.ok) {
    throw new HTTPException(502, { message: "Failed to exchange authorization code" });
  }

  const tokenData = (await tokenResponse.json()) as { id_token?: string };
  if (!tokenData.id_token) {
    throw new HTTPException(502, { message: "Microsoft did not return an id_token" });
  }

  return tokenData.id_token;
}
