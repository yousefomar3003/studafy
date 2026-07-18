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

  return async (c, next) => {
    const origin = c.req.header("Origin");
    const method = c.req.method;

    // Handle preflight requests
    if (method === "OPTIONS") {
      const validationResult = validateOrigin(origin, allowedOrigins);

      if (!validationResult.allowed || !origin) {
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
