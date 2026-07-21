/**
 * Microsoft OAuth (OIDC) routes.
 *
 * Two endpoints:
 *   GET /api/auth/oauth/microsoft/start    — redirects to Microsoft's authorization endpoint
 *   GET /api/auth/oauth/microsoft/callback — exchanges the code, validates the id_token, issues tokens
 *
 * Both are public (no bearer token required). The start endpoint generates state, nonce, and PKCE
 * parameters and stores them in an ephemeral in-memory store keyed by state. The callback
 * validates the state, exchanges the authorization code, verifies the id_token against Microsoft's
 * JWKS, finds the user via app.oauth_identities, and issues a token pair.
 *
 * These are browser-redirect endpoints, not JSON API endpoints, so they use plain Hono routes
 * rather than OpenAPI-typed routes. The primary responses are HTTP redirects, not JSON bodies.
 * Errors are still thrown as HTTPException/CodedHttpException and handled by the global error
 * handler like every other route in the app.
 *
 * The state store is in-memory intentionally (KISS). This is fine for single-instance deployments
 * and the 5-minute TTL window. Multi-instance scaling needs a Redis-backed store — follow-up.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { openApiValidationHook } from "../../../openapi/hook";
import { deliverTokenPair } from "../delivery";
import { issueTokenPair } from "../services/session-service";

import {
  MICROSOFT_AUTH_ENDPOINT,
  MICROSOFT_SCOPES,
  MICROSOFT_TOKEN_ENDPOINT,
  getMicrosoftOAuthConfig,
} from "./microsoft-config";
import { validateMicrosoftIdToken } from "./microsoft-id-token";
import { generateCodeChallenge, generateCodeVerifier, generateNonce, generateState } from "./pkce";
import { createStateStore } from "./state-store";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { SessionTokenConfig } from "../services/session-service";

// ---------------------------------------------------------------------------
// Route group factory
// ---------------------------------------------------------------------------

export function microsoftOAuthRoutes(
  db: Database,
  config: SessionTokenConfig,
  logger: Logger,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  const stateStore = createStateStore();

  // GET /api/auth/oauth/microsoft/start
  // Generates PKCE + state + nonce, stores them, and redirects to Microsoft.
  routes.get("/api/auth/oauth/microsoft/start", async (c) => {
    const oauthConfig = getMicrosoftOAuthConfig();
    if (!oauthConfig) {
      throw new HTTPException(404, { message: "Microsoft OAuth is not configured" });
    }

    const state = generateState();
    const nonce = generateNonce();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    stateStore.set(state, { codeVerifier, nonce, createdAt: Date.now() });

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
  // Microsoft redirects here with code + state. We exchange the code, validate the id_token,
  // find the user, issue tokens, and redirect to the frontend.
  routes.get("/api/auth/oauth/microsoft/callback", async (c) => {
    const oauthConfig = getMicrosoftOAuthConfig();
    if (!oauthConfig) {
      throw new HTTPException(404, { message: "Microsoft OAuth is not configured" });
    }

    const code = c.req.query("code");
    const state = c.req.query("state");

    if (!code || !state) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.OAUTH_STATE_INVALID,
        "Missing code or state parameter",
      );
    }

    // 1. Validate state
    const entry = stateStore.get(state);
    if (!entry) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.OAUTH_STATE_INVALID,
        "Invalid or expired OAuth state",
      );
    }
    stateStore.delete(state);

    // 2. Exchange authorization code for tokens
    const idToken = await exchangeCode(code, oauthConfig, entry.codeVerifier);

    // 3. Validate id_token
    const claims = await validateMicrosoftIdToken(idToken, oauthConfig.clientId, entry.nonce);

    // 4. Find oauth identity
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
    const frontendUrl = oauthConfig.frontendUrl ?? "/";
    const redirectUrl = new URL("/auth/callback", frontendUrl);

    return c.redirect(redirectUrl.toString(), 302);
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

interface OAuthIdentity {
  userId: string;
  schoolId: string;
}

async function findOAuthIdentity(
  db: Database,
  provider: string,
  subject: string,
): Promise<OAuthIdentity | undefined> {
  let result: OAuthIdentity | undefined;
  await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    const rows = await tx<{ user_id: string; school_id: string }[]>`
      SELECT user_id, school_id
        FROM app.oauth_identities
       WHERE provider = ${provider}
         AND subject = ${subject}
       LIMIT 1
    `;
    result = rows[0] ? { userId: rows[0].user_id, schoolId: rows[0].school_id } : undefined;
  });
  return result;
}
