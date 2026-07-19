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

import { extractClientIp } from "./rateLimiter";

import type { SecurityEventSink, SecurityEventType } from "../lib/security/securityEventSink";
import type { MiddlewareHandler } from "hono";

const STATE_MUTATING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/**
 * Paths that never carry a browser-forged mutation worth protecting.
 *
 * /api/webhooks is exempt because ERPNext authenticates by HMAC signature over the request body,
 * not by a session token (see src/app.ts) — it has no cookie to forge and no way to read one.
 */
const EXEMPT_PATHS = ["/healthz", "/readyz", "/api/webhooks", "/docs", "/openapi.json"];

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

    if (exemptPaths.some((exempt) => path.startsWith(exempt))) {
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
  const clientIp = extractClientIp(c);
  const userAgent = c.req.header("User-Agent");

  c.get("log")?.warn(
    {
      path,
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
    path,
    method,
    clientIp,
    userAgent,
    requestId: c.get("requestId"),
  });

  throw new HTTPException(403, { message: "CSRF token missing or invalid" });
}
