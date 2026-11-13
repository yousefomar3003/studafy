/**
 * Mock OAuth (OIDC) configuration — dev and E2E only.
 *
 * Mirrors config.ts's Google shape exactly: read once, memoized, `null` when unconfigured so every
 * call site can guard with a plain null check. Two things make this provider different from Google
 * and Microsoft:
 *
 *   1. Its endpoints are not fixed public URLs — they are `src/dev/mock-idp.ts`, mounted on this same
 *      process at `/mock-idp` (see app.ts). `MOCK_OAUTH_ISSUER_URL` is therefore the one variable
 *      that both selects "where the mock IdP lives" for app.ts's own mount and "where to send the
 *      browser" for this module — one source of truth, so the two can never point at different
 *      places.
 *   2. It is hard-disabled outside dev/test even if the variable is set: `isMockOAuthSafeEnvironment`
 *      duplicates `dev/mock-idp.ts`'s `isMockIdpEnabled` check rather than importing it, because that
 *      module lives under `src/dev` for the mount in app.ts and this one must not gain a dependency
 *      on it merely to reuse three lines — see the refinement in env.ts, which additionally refuses
 *      to *boot* with this variable set in a production-tier deployment, so a misconfiguration is
 *      loud at startup rather than silently inert.
 */

import { loadEnv } from "../../../env";

export const MOCK_OAUTH_CLIENT_ID = "studafy-e2e";
export const MOCK_OAUTH_SCOPES = "openid email profile";

export interface MockOAuthConfig {
  /** Where `src/dev/mock-idp.ts` is mounted, e.g. "http://127.0.0.1:3000/mock-idp". */
  issuer: string;
  redirectUri: string;
  frontendUrl: string | undefined;
}

/** Same production/staging kill switch as `dev/mock-idp.ts`'s `isMockIdpEnabled`, kept independent — see the file header. */
function isMockOAuthSafeEnvironment(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.APP_ENV !== "production";
}

export const MOCK_AUTH_ENDPOINT = (issuer: string): string => `${issuer}/authorize`;
export const MOCK_TOKEN_ENDPOINT = (issuer: string): string => `${issuer}/token`;
export const MOCK_JWKS_URI = (issuer: string): string => `${issuer}/.well-known/jwks.json`;

let cachedConfig: MockOAuthConfig | null | undefined;

export function getMockOAuthConfig(): MockOAuthConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;

  if (!isMockOAuthSafeEnvironment()) {
    cachedConfig = null;
    return null;
  }

  const env = loadEnv();
  if (!env.MOCK_OAUTH_ISSUER_URL) {
    cachedConfig = null;
    return null;
  }

  cachedConfig = {
    issuer: env.MOCK_OAUTH_ISSUER_URL,
    redirectUri: env.MOCK_OAUTH_REDIRECT_URI!,
    frontendUrl: env.FRONTEND_URL,
  };
  return cachedConfig;
}

export function isMockOAuthEnabled(): boolean {
  return getMockOAuthConfig() !== null;
}
