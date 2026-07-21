/**
 * Google OAuth (OIDC) configuration.
 *
 * Reads from the environment once per process. The feature is fully optional — all three variables
 * must be present for the OAuth routes to mount. getGoogleOAuthConfig returns null when they are
 * absent, so every call site can guard with a simple null check rather than a feature flag.
 */

import { loadEnv } from "../../../env";

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ID_TOKEN_ISSUER = "https://accounts.google.com";
export const GOOGLE_SCOPES = "openid email profile";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  frontendUrl: string | undefined;
}

let cachedConfig: GoogleOAuthConfig | null | undefined;

export function getGoogleOAuthConfig(): GoogleOAuthConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;

  const env = loadEnv();
  if (!env.GOOGLE_OAUTH_CLIENT_ID) {
    cachedConfig = null;
    return null;
  }

  cachedConfig = {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
    redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI!,
    frontendUrl: env.FRONTEND_URL,
  };
  return cachedConfig;
}

export function isGoogleOAuthEnabled(): boolean {
  return getGoogleOAuthConfig() !== null;
}
