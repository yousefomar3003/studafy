/**
 * CSRF middleware: Double-Submit Cookie pattern for state-mutating requests.
 *
 * Protects browser-driven requests from Cross-Site Request Forgery while exempting stateless
 * Bearer token flows (mobile/API clients), which are not vulnerable to it: an attacker's page
 * cannot make a browser attach an Authorization header the way it attaches cookies.
 *
 * Flow:
 * 1. Server issues a random token in a JS-readable cookie.
 * 2. Client reads the cookie and echoes it in the X-XSRF-TOKEN header.
 * 3. Server compares header against cookie in constant time.
 *
 * The comparison is the whole mechanism: an attacker's cross-origin page can cause the cookie to
 * be sent, but the same-origin policy stops it from *reading* the cookie to forge the header.
 *
 * Entirely stateless — zero database reads on the accept path and the reject path alike, per the
 * ST-067 performance requirement. Rejections are logged and, when a sink is supplied, handed to an
 * async batched writer that persists them to app.security_events off the request path. The sink's
 * record() never awaits and never throws, so that remains true. See
 * docs/security/web_defense_matrix.md for why these events cannot live in app.audit_logs.
 *
 * @example
 * ```typescript
 * app.use("/api/*", csrfMiddleware());
 * ```
 */

import { getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";

import { getSecurityConfig } from "../config/security";
import { generateCsrfToken, validateCsrfToken } from "../lib/security/csrf";
import { sanitizeSensitivePath } from "../lib/security/sensitive-path";

import { extractClientIp } from "./rateLimiter";

import type { SecurityEventSink, SecurityEventType } from "../lib/security/securityEventSink";
import type { MiddlewareHandler } from "hono";

const STATE_MUTATING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/**
 * Account activation (ST-078): POST /api/auth/invitations/{token}/activate.
 *
 * Exempt for the same reason as the webhook and session endpoints — it carries no ambient authority
 * a cross-site page could forge. It authenticates with the invitation token in the path plus a
 * verified Microsoft OIDC identity in the body, never with a cookie the browser attaches on its own.
 * It is also frequently an invitee's first API call (arriving from an email link with no prior safe
 * request), so there is no bootstrapped double-submit cookie to require. The token segment varies, so
 * this is matched structurally rather than as a static prefix in EXEMPT_PATHS.
 */
function isInvitationActivationPath(path: string): boolean {
  const segments = path.split("/");
  return (
    segments.length === 6 &&
    segments[0] === "" &&
    segments[1] === "api" &&
    segments[2] === "auth" &&
    segments[3] === "invitations" &&
    segments[4] !== "" &&
    segments[5] === "activate"
  );
}

/**
 * Paths that never carry a browser-forged mutation worth protecting.
 *
 * /api/webhooks is exempt because ERPNext authenticates by HMAC signature over the request body,
 * not by a session token (see src/app.ts) — it has no cookie to forge and no way to read one.
 */
const EXEMPT_PATHS = [
  "/healthz",
  "/readyz",
  "/api/webhooks",
  "/docs",
  "/openapi.json",
  // The two session-lifecycle endpoints (ST-071). They authenticate with a refresh token rather
  // than an access token, and the Bearer exemption below cannot cover them: a client calls these
  // precisely when its access token is gone, so there is frequently no Authorization header to
  // exempt on. Without this entry a mobile client refreshing after its token expired — carrying no
  // cookie at all, and therefore nothing a CSRF attack could forge with — would be rejected by a
  // check that exists to protect browsers.
  //
  // What protects the browser case instead is the refresh cookie's own SameSite=Strict attribute
  // (see modules/auth/delivery.ts). Strict means the cookie is not attached to *any* cross-site
  // request, including top-level navigation, so an attacker's page cannot reach these endpoints
  // with the victim's credential in the first place — the ambient-authority premise CSRF depends on
  // never holds. The response is also unreadable cross-origin, and a web session's rotated token
  // goes back as a cookie rather than in the body, so a forged call would leak nothing even if one
  // landed.
  //
  // The narrower fix is to gate the check below on the presence of the session cookie rather than
  // on the absence of a Bearer header, which is what the comment there anticipates now that a
  // session subsystem exists. That changes CSRF behaviour for every route and belongs in its own
  // ticket; see docs/architecture/SAD_13_session_model.md.
  "/api/auth/refresh",
  "/api/auth/logout",
  // Returning-user OAuth login (ST-079). Authenticates with a Microsoft OIDC id_token in the
  // request body — the id_token is the credential. There is no ambient authority (cookie or
  // Bearer header) a cross-site page could forge; the token arrives as a one-shot credential,
  // identical in security posture to the activation endpoint above.
  "/api/auth/login",
  // Stripe billing webhook (ST-132). Same posture as the ERPNext entry above — authenticated by an
  // HMAC signature over the raw request body, with no cookie to forge and no way to read one — but
  // it needs naming explicitly because it lives under /api/ rather than at a top-level path like
  // /erpnext/webhooks or /email/webhooks/sns. Without this entry the check below rejects every
  // Stripe delivery with 403 missing_token before the handler runs: Stripe sends no session cookie
  // and no Authorization header, so neither the exemption list nor the Bearer exemption covered it.
  "/api/subscriptions/webhook/stripe",
];

type CsrfFailureReason = "missing_token" | "token_mismatch";

export interface CsrfOptions {
  cookieName?: string;
  headerName?: string;
  cookieMaxAge?: number;
  exemptPaths?: string[];
  /** Where rejections are persisted. Omitted in tests and when no database is configured. */
  eventSink?: SecurityEventSink;
}

/** Maps a validation failure onto the app.security_event_type enum. */
const CSRF_EVENT_TYPE: Record<CsrfFailureReason, SecurityEventType> = {
  missing_token: "csrf_missing_token",
  token_mismatch: "csrf_token_mismatch",
};

/**
 * CSRF middleware factory.
 */
export function csrfMiddleware(options?: CsrfOptions): MiddlewareHandler {
  const config = getSecurityConfig();
  const cookieName = options?.cookieName ?? config.csrfCookieName;
  const headerName = options?.headerName ?? config.csrfHeaderName;
  const cookieMaxAge = options?.cookieMaxAge ?? config.csrfCookieMaxAge;
  const exemptPaths = options?.exemptPaths ?? EXEMPT_PATHS;
  // Secure everywhere but local development, where the dev server is plain http and a Secure
  // cookie would simply never be stored.
  const secureCookie = config.environment !== "development" && config.environment !== "test";

  return async (c, next) => {
    const path = c.req.path;
    const method = c.req.method;

    if (isInvitationActivationPath(path) || exemptPaths.some((exempt) => path.startsWith(exempt))) {
      await next();
      return;
    }

    const cookieToken = getCookie(c, cookieName);

    // Bearer-authenticated callers are exempt. Gating on the *absence* of a Bearer header rather
    // than the presence of a session cookie is deliberate: no session subsystem exists yet, so
    // cookie-gating would enforce nothing today and would fail open tomorrow for any cookie name
    // other than the one guessed here.
    const isBearerAuth = c.req.header("Authorization")?.startsWith("Bearer ") ?? false;

    if (STATE_MUTATING_METHODS.has(method) && !isBearerAuth) {
      const headerToken = c.req.header(headerName);

      if (!cookieToken || !headerToken) {
        reject(c, "missing_token", path, method, options?.eventSink);
      }
      if (!validateCsrfToken(cookieToken, headerToken)) {
        reject(c, "token_mismatch", path, method, options?.eventSink);
      }
    }

    // Issue a token to any caller that does not have one, so a browser client can bootstrap by
    // making a safe request before its first mutation.
    if (!cookieToken) {
      setCookie(c, cookieName, generateCsrfToken(), {
        maxAge: cookieMaxAge,
        httpOnly: false, // Must be readable by JavaScript — that is the "double submit".
        secure: secureCookie,
        sameSite: "Strict",
        path: "/",
      });
    }

    await next();
  };
}

/**
 * Log the violation and throw. Returns `never` so the call sites above read as terminal and
 * TypeScript narrows the tokens as non-null afterwards.
 *
 * The 403 is thrown rather than written directly: errorHandlerMiddleware already renders
 * HTTPException as RFC 9457 application/problem+json carrying the tracing request_id, so this
 * middleware reuses that envelope instead of hand-rolling a second one that could drift from it.
 */
function reject(
  c: Parameters<MiddlewareHandler>[0],
  reason: CsrfFailureReason,
  path: string,
  method: string,
  eventSink?: SecurityEventSink,
): never {
  const safePath = sanitizeSensitivePath(path);
  const clientIp = extractClientIp(c);
  const userAgent = c.req.header("User-Agent");

  c.get("log")?.warn(
    {
      path: safePath,
      method,
      reason,
      client_ip: clientIp,
      user_agent: userAgent,
    },
    "csrf validation failed",
  );

  // Fire-and-forget by contract: record() buffers in memory and returns. Note that neither the
  // cookie nor the header token is passed — the sink persists the fact of a rejection, never the
  // token values, which would hand a database reader a working forgery.
  eventSink?.record({
    eventType: CSRF_EVENT_TYPE[reason],
    path: safePath,
    method,
    clientIp,
    userAgent,
    requestId: c.get("requestId"),
  });

  throw new HTTPException(403, { message: "CSRF token missing or invalid" });
}
