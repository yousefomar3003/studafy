/**
 * CORS middleware: environment-aware Cross-Origin Resource Sharing.
 *
 * Features:
 * - Strict origin allowlist (no wildcards with credentials)
 * - Proper preflight (OPTIONS) handling
 * - Vary: Origin header for caching
 * - Early termination for disallowed origins
 *
 * @example
 * ```typescript
 * app.use("*", corsMiddleware());
 * ```
 */

import { getSecurityConfig } from "../config/security";
import { validateOrigin } from "../lib/security/origins";
import { sanitizeSensitivePath } from "../lib/security/sensitive-path";

import { extractClientIp } from "./rateLimiter";

import type { SecurityEventSink } from "../lib/security/securityEventSink";
import type { MiddlewareHandler } from "hono";

const ALLOWED_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];
const ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-XSRF-TOKEN",
  "X-Request-Id",
  "Idempotency-Key",
  "Accept-Language",
];
const EXPOSED_HEADERS = ["X-Request-Id"];
const MAX_AGE = 86400; // 24 hours

export interface CorsOptions {
  allowedOrigins?: string[];
  allowCredentials?: boolean;
  allowedMethods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  maxAge?: number;
  /** Where rejections are persisted. Omitted in tests and when no database is configured. */
  eventSink?: SecurityEventSink;
}

/**
 * Hand a refused origin to the async sink. Fire-and-forget by contract: record() buffers in memory
 * and returns, so an origin probe still costs no database I/O on the request path.
 *
 * The refused origin IS persisted, unlike CSRF token values — it is attacker-supplied and is the
 * single most useful field for attributing a probe.
 */
function recordOriginRejection(
  c: Parameters<MiddlewareHandler>[0],
  origin: string | undefined,
  path: string,
  method: string,
  eventSink?: SecurityEventSink,
): void {
  eventSink?.record({
    eventType: "cors_origin_rejected",
    path,
    method,
    origin: origin ?? null,
    clientIp: extractClientIp(c),
    userAgent: c.req.header("User-Agent"),
    requestId: c.get("requestId"),
  });
}

/**
 * CORS middleware factory.
 */
export function corsMiddleware(options?: CorsOptions): MiddlewareHandler {
  const config = getSecurityConfig();
  const allowedOrigins = options?.allowedOrigins ?? config.allowedOrigins;
  const allowCredentials = options?.allowCredentials ?? true;
  const allowedMethods = options?.allowedMethods ?? ALLOWED_METHODS;
  const allowedHeaders = options?.allowedHeaders ?? ALLOWED_HEADERS;
  const exposedHeaders = options?.exposedHeaders ?? EXPOSED_HEADERS;
  const maxAge = options?.maxAge ?? MAX_AGE;

  const eventSink = options?.eventSink;

  return async (c, next) => {
    const origin = c.req.header("Origin");
    const method = c.req.method;
    const path = sanitizeSensitivePath(c.req.path);

    // Handle preflight requests
    if (method === "OPTIONS") {
      const validationResult = validateOrigin(origin, allowedOrigins);

      if (!validationResult.allowed || !origin) {
        recordOriginRejection(c, origin, path, method, eventSink);
        return c.body(null, 403);
      }

      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Methods", allowedMethods.join(", "));
      c.header("Access-Control-Allow-Headers", allowedHeaders.join(", "));
      c.header("Access-Control-Max-Age", maxAge.toString());
      if (allowCredentials) {
        c.header("Access-Control-Allow-Credentials", "true");
      }
      c.header("Vary", "Origin");

      return c.body(null, 204);
    }

    // For non-preflight requests, validate origin if present
    if (origin) {
      const validationResult = validateOrigin(origin, allowedOrigins);

      if (!validationResult.allowed) {
        // Don't set CORS headers - browser will block the response
        // Continue processing but without CORS headers
        recordOriginRejection(c, origin, path, method, eventSink);
        await next();
        return;
      }

      c.header("Access-Control-Allow-Origin", origin);
      if (allowCredentials) {
        c.header("Access-Control-Allow-Credentials", "true");
      }
    }

    // Always set Vary header for proper caching
    c.header("Vary", "Origin");

    // Expose headers to the client
    if (exposedHeaders.length > 0) {
      c.header("Access-Control-Expose-Headers", exposedHeaders.join(", "));
    }

    await next();
  };
}
