/**
 * Microsoft OAuth (OIDC) configuration.
 *
 * Reads from the environment once per process. The feature is fully optional — all three variables
 * must be present for the OAuth routes to mount. getMicrosoftOAuthConfig returns null when they
 * are absent, so every call site can guard with a simple null check rather than a feature flag.
 *
 * Uses the Microsoft identity platform common endpoint, which accepts tokens from any Entra ID
 * tenant. The issuer in the id_token is tenant-specific
 * (https://login.microsoftonline.com/{tenant}/v2.0), so validation uses prefix matching rather
 * than a fixed string.
 */

import { loadEnv } from "../../../env";

export const MICROSOFT_AUTH_ENDPOINT =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
export const MICROSOFT_TOKEN_ENDPOINT =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";
export const MICROSOFT_JWKS_URI = "https://login.microsoftonline.com/common/discovery/v2.0/keys";
export const MICROSOFT_ISSUER_PREFIX = "https://login.microsoftonline.com/";
export const MICROSOFT_SCOPES = "openid email profile";

export interface MicrosoftOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  frontendUrl: string | undefined;
}

let cachedConfig: MicrosoftOAuthConfig | null | undefined;

export function getMicrosoftOAuthConfig(): MicrosoftOAuthConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;

  const env = loadEnv();
  if (!env.MICROSOFT_OAUTH_CLIENT_ID) {
    cachedConfig = null;
    return null;
  }

  cachedConfig = {
    clientId: env.MICROSOFT_OAUTH_CLIENT_ID,
    clientSecret: env.MICROSOFT_OAUTH_CLIENT_SECRET!,
    redirectUri: env.MICROSOFT_OAUTH_REDIRECT_URI!,
    frontendUrl: env.FRONTEND_URL,
  };
  return cachedConfig;
}

export function isMicrosoftOAuthEnabled(): boolean {
  return getMicrosoftOAuthConfig() !== null;
}
