import type { ErrorCode } from "@studafy/constants";

/**
 * The frontend URL that renders a specific OAuth failure state (`/auth/error?code=…`).
 *
 * The browser-redirect OAuth callbacks (login, link) are reached after a full-page trip to the
 * identity provider, so a failed exchange must bounce the browser back to the frontend — a raw
 * problem+json body at the API origin would render as JSON on a tab the user is actually looking
 * at. The only thing in the query string is the machine-readable error code; the provider's
 * `code`/`state` are never echoed back, and no token ever appears in a URL (the refresh token
 * rides the HttpOnly cookie set by the success redirect instead).
 *
 * `frontendUrl` comes from the OAuth provider config's `FRONTEND_URL`, defaulting to `/` exactly
 * like the success redirect in the callbacks that call this.
 */
export function oauthErrorUrl(frontendUrl: string, code: ErrorCode): string {
  const url = new URL("/auth/error", frontendUrl);
  url.searchParams.set("code", code);
  return url.toString();
}
