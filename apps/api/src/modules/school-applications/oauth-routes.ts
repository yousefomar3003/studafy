/**
 * Sign-up OAuth routes: Google or Microsoft sign-in for a prospective school owner.
 *
 *   GET /api/auth/oauth/{provider}/school-application/start
 *   GET /api/auth/oauth/{provider}/school-application/callback
 *
 * The login flow (oauth/google-route.ts) rejects anyone without an `app.oauth_identities` row, and
 * an applicant has none -- their school does not exist yet. These two endpoints run the same
 * PKCE + nonce authorization-code flow but, instead of issuing a session, verify the id_token and
 * hand the browser an applicant session cookie (applicant-session.ts) for the application form.
 *
 * The callback is its own redirect URI, derived from the provider's configured login callback by
 * swapping the path (see `applicationRedirectUri`). **It must be registered as an authorized
 * redirect URI in the Google Cloud console and the Microsoft Entra app registration**, alongside
 * the login one, or the provider will refuse the request.
 *
 * Plain Hono routes (redirects, not JSON), public under the `/api/auth/oauth` prefix like every
 * other OAuth endpoint (jwtAuth.ts DEFAULT_PUBLIC_PATHS). Failures redirect to the frontend's
 * `/signup?error=<CODE>` so the page can explain them.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";
import { openApiValidationHook } from "../../openapi/hook";
import {
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_ENDPOINT,
  getGoogleOAuthConfig,
} from "../auth/oauth/config";
import { validateGoogleIdToken } from "../auth/oauth/google-id-token";
import {
  MICROSOFT_AUTH_ENDPOINT,
  MICROSOFT_SCOPES,
  MICROSOFT_TOKEN_ENDPOINT,
  getMicrosoftOAuthConfig,
} from "../auth/oauth/microsoft-config";
import { validateMicrosoftIdToken } from "../auth/oauth/microsoft-id-token";
import {
  MOCK_AUTH_ENDPOINT,
  MOCK_JWKS_URI,
  MOCK_OAUTH_CLIENT_ID,
  MOCK_OAUTH_SCOPES,
  getMockOAuthConfig,
} from "../auth/oauth/mock-config";
import { validateMockIdToken } from "../auth/oauth/mock-id-token";
import { exchangeCode as exchangeMockCode } from "../auth/oauth/mock-route";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateState,
} from "../auth/oauth/pkce";
import { createMemoryStateStore, takeStateFor } from "../auth/oauth/state-store";
import { findOAuthIdentity } from "../auth/services/returning-user-login-service";

import { setApplicantCookie, signApplicantSession } from "./applicant-session";

import type {
  ApplicantIdentity,
  ApplicantProvider,
  ApplicantSessionConfig,
} from "./applicant-session";
import type { Database } from "../../db";
import type { Logger } from "../../logger";
import type { AppEnv } from "../../middleware/requestId";
import type { AuthorizationEntry, StateStore } from "../auth/oauth/state-store";

interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  /** The provider's *login* callback; the application callback is derived from it. */
  redirectUri: string;
  frontendUrl: string | undefined;
}

export interface ApplicationOAuthDependencies {
  /** Tests inject a stub so no provider configuration is needed. */
  getProviderConfig?: (provider: ApplicantProvider) => ProviderConfig | null;
  /** Exchanges the code and validates the id_token. Tests inject a stub to skip the network. */
  verifyIdentity?: (
    provider: ApplicantProvider,
    code: string,
    entry: AuthorizationEntry,
    config: ProviderConfig,
  ) => Promise<{ sub: string; email: string; name?: string | null }>;
  /** Whether this identity already belongs to a user. Tests inject a stub. */
  identityExists?: (provider: ApplicantProvider, subject: string) => Promise<boolean>;
  /** The process-wide OAuth state store (app.ts), so a start and its callback can land on
   * different API instances. Defaults to an in-process store. */
  stateStore?: StateStore;
}

export const APPLICATION_CALLBACK_PATH = (provider: string): string =>
  `/api/auth/oauth/${provider}/school-application/callback`;

/** Same origin as the configured login callback, application-specific path. */
export function applicationRedirectUri(provider: ApplicantProvider, loginRedirectUri: string) {
  return new URL(APPLICATION_CALLBACK_PATH(provider), loginRedirectUri).toString();
}

function defaultProviderConfig(provider: ApplicantProvider): ProviderConfig | null {
  if (provider === "mock") {
    const config = getMockOAuthConfig();
    return config
      ? {
          clientId: MOCK_OAUTH_CLIENT_ID,
          clientSecret: "",
          redirectUri: config.redirectUri,
          frontendUrl: config.frontendUrl,
        }
      : null;
  }
  return provider === "google" ? getGoogleOAuthConfig() : getMicrosoftOAuthConfig();
}

function mockIssuer(): string {
  const config = getMockOAuthConfig();
  if (!config) throw new HTTPException(404, { message: "mock OAuth is not configured" });
  return config.issuer;
}

function authEndpoint(provider: ApplicantProvider): string {
  if (provider === "google") return GOOGLE_AUTH_ENDPOINT;
  if (provider === "microsoft") return MICROSOFT_AUTH_ENDPOINT;
  return MOCK_AUTH_ENDPOINT(mockIssuer());
}

function scopes(provider: ApplicantProvider): string {
  if (provider === "google") return GOOGLE_SCOPES;
  if (provider === "microsoft") return MICROSOFT_SCOPES;
  return MOCK_OAUTH_SCOPES;
}

async function exchangeCode(
  provider: "google" | "microsoft",
  config: ProviderConfig,
  code: string,
  codeVerifier: string,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(
      provider === "google" ? GOOGLE_TOKEN_ENDPOINT : MICROSOFT_TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: applicationRedirectUri(provider, config.redirectUri),
          grant_type: "authorization_code",
          code_verifier: codeVerifier,
        }).toString(),
      },
    );
  } catch {
    throw new HTTPException(502, { message: "Failed to reach OAuth token endpoint" });
  }
  if (!response.ok) {
    throw new HTTPException(502, { message: "Failed to exchange authorization code" });
  }
  const data = (await response.json()) as { id_token?: string };
  if (!data.id_token) {
    throw new HTTPException(502, { message: "OAuth provider did not return an id_token" });
  }
  return data.id_token;
}

async function defaultVerifyIdentity(
  provider: ApplicantProvider,
  code: string,
  entry: AuthorizationEntry,
  config: ProviderConfig,
): Promise<{ sub: string; email: string; name?: string | null }> {
  if (provider === "mock") {
    const issuer = mockIssuer();
    const accessToken = await exchangeMockCode(issuer, code, entry.codeVerifier);
    return validateMockIdToken(accessToken, issuer, entry.nonce, MOCK_JWKS_URI(issuer));
  }
  const idToken = await exchangeCode(provider, config, code, entry.codeVerifier);
  return provider === "google"
    ? validateGoogleIdToken(idToken, config.clientId, entry.nonce)
    : validateMicrosoftIdToken(idToken, config.clientId, entry.nonce);
}

function assertProvider(provider: string): asserts provider is ApplicantProvider {
  if (provider !== "google" && provider !== "microsoft" && provider !== "mock") {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Unknown OAuth provider");
  }
}

function signupUrl(frontendUrl: string | undefined, path: string, errorCode?: string): string {
  const url = new URL(path, frontendUrl ?? "/");
  if (errorCode) url.searchParams.set("error", errorCode);
  return url.toString();
}

export function schoolApplicationOAuthRoutes(
  db: Database,
  sessionConfig: ApplicantSessionConfig,
  logger: Logger,
  deps: ApplicationOAuthDependencies = {},
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const stateStore = deps.stateStore ?? createMemoryStateStore();
  const getProviderConfig = deps.getProviderConfig ?? defaultProviderConfig;
  const verifyIdentity = deps.verifyIdentity ?? defaultVerifyIdentity;
  const identityExists =
    deps.identityExists ??
    (async (provider, subject) => (await findOAuthIdentity(db, provider, subject)) !== undefined);

  routes.get("/api/auth/oauth/:provider/school-application/start", async (c) => {
    const provider = c.req.param("provider");
    assertProvider(provider);
    const config = getProviderConfig(provider);
    if (!config) throw new HTTPException(404, { message: `${provider} OAuth is not configured` });

    const state = generateState();
    const nonce = generateNonce();
    const codeVerifier = generateCodeVerifier();
    await stateStore.set(state, { flow: "school-application", provider, codeVerifier, nonce });

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: applicationRedirectUri(provider, config.redirectUri),
      response_type: "code",
      scope: scopes(provider),
      state,
      nonce,
      code_challenge: generateCodeChallenge(codeVerifier),
      code_challenge_method: "S256",
      // Always show the account chooser: the person may be signed in with a personal account and
      // want to apply with their school's.
      prompt: "select_account",
    });
    if (provider === "microsoft") params.set("response_mode", "query");
    const loginHint = c.req.query("login_hint");
    if (provider === "mock" && loginHint) params.set("login_hint", loginHint);

    return c.redirect(`${authEndpoint(provider)}?${params.toString()}`, 302);
  });

  routes.get("/api/auth/oauth/:provider/school-application/callback", async (c) => {
    const provider = c.req.param("provider");
    assertProvider(provider);
    const config = getProviderConfig(provider);
    if (!config) throw new HTTPException(404, { message: `${provider} OAuth is not configured` });
    const frontendUrl = config.frontendUrl;

    if (c.req.query("error")) {
      return c.redirect(signupUrl(frontendUrl, "/signup", ERROR_CODES.OAUTH_CANCELLED), 302);
    }

    try {
      const code = c.req.query("code");
      const state = c.req.query("state");
      const entry = state
        ? await takeStateFor(stateStore, state, "school-application", provider)
        : undefined;
      if (!code || !state || !entry) {
        throw new CodedHttpException(
          400,
          ERROR_CODES.OAUTH_STATE_INVALID,
          "Invalid or expired OAuth state",
        );
      }
      const claims = await verifyIdentity(provider, code, entry, config);

      // Someone who already has a Studafy account signs in; they do not apply for a second school
      // with the same identity (app.oauth_identities is unique on provider + subject).
      if (await identityExists(provider, claims.sub)) {
        return c.redirect(
          signupUrl(frontendUrl, "/signup", ERROR_CODES.SCHOOL_APPLICATION_ACCOUNT_EXISTS),
          302,
        );
      }

      const identity: ApplicantIdentity = {
        provider,
        subject: claims.sub,
        email: claims.email.trim().toLowerCase(),
        name: claims.name?.trim() || null,
      };
      setApplicantCookie(c, await signApplicantSession(sessionConfig, identity));
      logger.info({ provider }, "school applicant signed in");
      return c.redirect(signupUrl(frontendUrl, "/signup/apply"), 302);
    } catch (error) {
      if (error instanceof CodedHttpException) {
        return c.redirect(signupUrl(frontendUrl, "/signup", error.code), 302);
      }
      if (error instanceof HTTPException) {
        return c.redirect(signupUrl(frontendUrl, "/signup", ERROR_CODES.OAUTH_PROVIDER_ERROR), 302);
      }
      throw error;
    }
  });

  return routes;
}
