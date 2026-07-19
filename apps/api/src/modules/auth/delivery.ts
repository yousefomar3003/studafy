/**
 * Channel-aware delivery of refresh tokens (ST-071).
 *
 * The same token goes to a browser and to a native app by different routes, because the two have
 * different threat models. A browser can be scripted by an XSS payload, so the token must be
 * somewhere JavaScript cannot read it: an HttpOnly cookie. A native app has no DOM and no
 * document.cookie, but also no cookie jar worth relying on — it has an OS keychain instead, which it
 * can only put a token into if it can read one, so mobile gets the token in the response body.
 *
 * Which branch runs is decided by `app.refresh_tokens.channel`, fixed when the session was
 * established and carried unchanged through every rotation. It is deliberately not read from a
 * request header. A header would let a caller ask for a web session's token in the response body,
 * which is exactly the read an XSS payload needs and exactly what HttpOnly exists to prevent — the
 * attacker would simply opt out of the defence. The channel is a property of the session, so it
 * lives with the session.
 */

import { deleteCookie, setCookie } from "hono/cookie";

import { getSecurityConfig } from "../../config/security";

import { AUTH_CHANNELS } from "./channels";

import type { AuthChannel } from "./channels";
import type { IssuedTokenPair } from "./services/session-service";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";
import type { CookieOptions } from "hono/utils/cookie";

/**
 * Where the refresh token is scoped to.
 *
 * Narrower than "/" on purpose: the cookie is only ever needed by the two endpoints that consume a
 * refresh token, so scoping it there keeps it off every other API request. A credential that is not
 * transmitted cannot be captured in transit, logged by a proxy, or replayed from a request that had
 * no business carrying it.
 */
const REFRESH_COOKIE_PATH = "/api/auth";

/** The response body shape. `refresh_token` is present only for non-web channels. */
export interface TokenResponseBody {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  session_id: string;
  refresh_token?: string;
}

/**
 * Write an issued token pair onto the response according to the session's channel.
 *
 * Returns the body to serialize. The cookie, when there is one, is set as a side effect on `c` —
 * Hono's cookie helpers stage a header rather than returning a value.
 */
export function deliverTokenPair(c: Context<AppEnv>, issued: IssuedTokenPair): TokenResponseBody {
  const body: TokenResponseBody = {
    access_token: issued.accessToken,
    token_type: "Bearer",
    expires_in: issued.accessExpiresInSeconds,
    session_id: issued.sessionId,
  };

  if (usesCookieDelivery(issued.channel)) {
    setCookie(c, refreshCookieName(), issued.refreshToken, refreshCookieOptions());
    // Note what is *not* here: no `refresh_token` key. Setting the cookie and also returning the
    // token in the body would make HttpOnly decorative, since the value an attacker wants would be
    // readable from the response that set it.
    return body;
  }

  return { ...body, refresh_token: issued.refreshToken };
}

/**
 * Read the presented refresh token from wherever this client would have put it.
 *
 * Cookie first, then body. The order matters for a web client: if both are present, the cookie is
 * the one the browser attached automatically and the body is attacker-supplied, so preferring the
 * cookie means a script that can write a request body still cannot substitute a token of its own
 * choosing for the session's real one.
 */
export function readPresentedToken(
  c: Context<AppEnv>,
  body: { refresh_token?: string } | undefined,
): string | undefined {
  const fromCookie = getCookieValue(c, refreshCookieName());
  if (fromCookie !== undefined && fromCookie.length > 0) return fromCookie;

  const fromBody = body?.refresh_token;
  return fromBody !== undefined && fromBody.length > 0 ? fromBody : undefined;
}

/** Clear the refresh cookie. Attributes must match the ones it was set with or browsers ignore it. */
export function clearRefreshCookie(c: Context<AppEnv>): void {
  deleteCookie(c, refreshCookieName(), {
    path: REFRESH_COOKIE_PATH,
    secure: useSecureCookie(),
    sameSite: "Strict",
  });
}

/** Whether a channel receives its token as a cookie rather than in the body. */
export function usesCookieDelivery(channel: AuthChannel): boolean {
  return channel === AUTH_CHANNELS.WEB;
}

function refreshCookieName(): string {
  return getSecurityConfig().sessionCookieName;
}

/**
 * Cookie attributes for the refresh token.
 *
 * - `httpOnly` — the whole point. Keeps the token out of reach of any script on the page.
 * - `sameSite: "Strict"` — the refresh endpoint is state-changing and needs no cross-site entry
 *   point. Strict rather than Lax because there is no top-level-navigation case to preserve: nobody
 *   follows a link *into* a token refresh.
 * - `secure` — off only in development and test, where there is no TLS to attach it to. The
 *   environment comes from getSecurityConfig(), which treats NODE_ENV=test as its own arm, so this
 *   cannot be accidentally disabled by an APP_ENV misconfiguration in a deployed tier.
 * - `maxAge` — matches the token's own 30-day lifetime, so the browser drops it at the same moment
 *   the server would stop honouring it.
 */
function refreshCookieOptions(): CookieOptions {
  const maxAgeSeconds = refreshCookieMaxAge;
  return {
    httpOnly: true,
    secure: useSecureCookie(),
    sameSite: "Strict",
    path: REFRESH_COOKIE_PATH,
    maxAge: maxAgeSeconds,
  };
}

/**
 * Set once at wiring time from env.JWT_REFRESH_TTL_SECONDS.
 *
 * Module-level state rather than a parameter threaded through every call because the cookie's
 * lifetime is a deployment fact, not a per-request one, and `deliverTokenPair` is called from route
 * handlers that have no reason to know about it.
 */
let refreshCookieMaxAge = 30 * 24 * 60 * 60;

/** Align the cookie's max-age with the configured refresh-token TTL. Called from createApp. */
export function configureRefreshCookie(ttlSeconds: number): void {
  refreshCookieMaxAge = ttlSeconds;
}

function useSecureCookie(): boolean {
  const { environment } = getSecurityConfig();
  return environment !== "development" && environment !== "test";
}

/**
 * Read one cookie without pulling in Hono's parser for the whole header.
 *
 * `getCookie` from hono/cookie would do, and is avoided here only because it parses every cookie on
 * the request to return one — on a refresh endpoint that is the hot path.
 */
function getCookieValue(c: Context<AppEnv>, name: string): string | undefined {
  const header = c.req.header("Cookie");
  if (!header) return undefined;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}
