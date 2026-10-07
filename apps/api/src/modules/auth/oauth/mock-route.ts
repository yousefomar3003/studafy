/**
 * Mock OAuth (OIDC) routes — dev and E2E only.
 *
 * Two endpoints, mirroring google-route.ts:
 *   GET /api/auth/oauth/mock/start    — redirects to the mock IdP's authorization endpoint
 *   GET /api/auth/oauth/mock/callback — exchanges the code, validates the token, then finishes the
 *                                       login, invitation activation, or native-app sign-in that
 *                                       minted the state (the mock provider has no link flow)
 *
 * Both 404 when `getMockOAuthConfig()` is null — unset `MOCK_OAUTH_ISSUER_URL`, or a
 * staging/production environment (mock-config.ts) — the same inert-by-default posture Google and
 * Microsoft use. There is no consent screen and no real credential exchange: the mock IdP issues a
 * code immediately and signs a JWT off whatever `login_hint` was passed, so `/start` accepts and
 * forwards `login_hint` — a real IdP's `/authorize` accepts the same parameter, this one just always
 * honors it. That is how a caller (the "Continue with Mock" button, or a test driving the browser
 * directly) picks which seeded persona to sign in as.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { createMockIdp } from "../../../dev/mock-idp";
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
  MOCK_AUTH_ENDPOINT,
  MOCK_JWKS_URI,
  MOCK_OAUTH_CLIENT_ID,
  MOCK_OAUTH_SCOPES,
  MOCK_TOKEN_ENDPOINT,
  getMockOAuthConfig,
} from "./mock-config";
import { validateMockIdToken } from "./mock-id-token";
import { generateCodeChallenge, generateCodeVerifier, generateNonce, generateState } from "./pkce";

import type { CallbackContext } from "./callback-flows";
import type { AuthorizationEntry, StateStore } from "./state-store";
import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { SessionTokenConfig } from "../services/session-service";

export interface MockOAuthDependencies {
  /** The process-wide OAuth state store, shared with every flow that returns through this callback. */
  stateStore: StateStore;
}

export function mockOAuthRoutes(
  db: Database,
  config: SessionTokenConfig,
  logger: Logger,
  { stateStore }: MockOAuthDependencies,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // The mock IdP itself, mounted on this same app at `/mock-idp` — so `MOCK_OAUTH_ISSUER_URL`
  // (typically `<this API's own origin>/mock-idp`) is the one variable that both selects where the
  // browser is sent and where the IdP actually lives, and E2E has one process and one port to run
  // rather than a second server to orchestrate. Mounted only when a mock config is present — the
  // same inert-by-default posture as the login/callback routes below — so a production deployment
  // (where getMockOAuthConfig() is always null, see mock-config.ts) never exposes it.
  const idpConfig = getMockOAuthConfig();
  if (idpConfig) {
    routes.route("/mock-idp", createMockIdp({ issuer: idpConfig.issuer }));
  }

  // GET /api/auth/oauth/mock/start
  routes.get("/api/auth/oauth/mock/start", async (c) => {
    const oauthConfig = getMockOAuthConfig();
    if (!oauthConfig) {
      throw new HTTPException(404, { message: "Mock OAuth is not configured" });
    }

    const state = generateState();
    const nonce = generateNonce();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const loginHint = c.req.query("login_hint");

    await stateStore.set(state, { flow: "login", provider: "mock", codeVerifier, nonce });

    const params = new URLSearchParams({
      client_id: MOCK_OAUTH_CLIENT_ID,
      redirect_uri: oauthConfig.redirectUri,
      response_type: "code",
      scope: MOCK_OAUTH_SCOPES,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    if (loginHint) params.set("login_hint", loginHint);

    return c.redirect(`${MOCK_AUTH_ENDPOINT(oauthConfig.issuer)}?${params.toString()}`, 302);
  });

  // GET /api/auth/oauth/mock/callback
  routes.get("/api/auth/oauth/mock/callback", async (c) => {
    const oauthConfig = getMockOAuthConfig();
    if (!oauthConfig) {
      throw new HTTPException(404, { message: "Mock OAuth is not configured" });
    }
    const ctx: CallbackContext = {
      db,
      sessionConfig: config,
      logger,
      stateStore,
      provider: "mock",
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

      entry = await takeAuthorization(ctx, state);

      const accessToken = await exchangeCode(oauthConfig.issuer, code, entry.codeVerifier);
      const claims = await validateMockIdToken(
        accessToken,
        oauthConfig.issuer,
        entry.nonce,
        MOCK_JWKS_URI(oauthConfig.issuer),
      );

      // An invitation or a native-app sign-in finishes here; a browser login continues below.
      const finished = await finishFlow(c, ctx, entry, state, claims);
      if (finished) return finished;

      const identity = await findOAuthIdentity(db, "mock", claims.sub);
      if (!identity) {
        logger.warn({ sub: claims.sub }, "mock OAuth identity not found");
        throw new CodedHttpException(
          403,
          ERROR_CODES.AUTHZ_FORBIDDEN,
          "Account not found. Contact your administrator.",
        );
      }

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

      deliverTokenPair(c, issued);
      return c.redirect(new URL("/auth/callback", oauthConfig.frontendUrl ?? "/").toString(), 302);
    } catch (error) {
      return failureRedirect(c, ctx, entry, error);
    }
  });
  return routes;
}

/**
 * Exchange a code at the mock IdP's token endpoint. Reads `access_token`, not `id_token` — see the
 * file header and mock-id-token.ts.
 */
export async function exchangeCode(
  issuer: string,
  code: string,
  codeVerifier: string,
): Promise<string> {
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(MOCK_TOKEN_ENDPOINT(issuer), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
      }).toString(),
    });
  } catch {
    throw new HTTPException(502, { message: "Failed to reach mock IdP token endpoint" });
  }

  if (!tokenResponse.ok) {
    throw new HTTPException(502, { message: "Failed to exchange authorization code" });
  }

  const tokenData = (await tokenResponse.json()) as { access_token?: string };
  if (!tokenData.access_token) {
    throw new HTTPException(502, { message: "Mock IdP did not return an access_token" });
  }

  return tokenData.access_token;
}
