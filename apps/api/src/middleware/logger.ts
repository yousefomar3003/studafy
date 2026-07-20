import { sanitizeSensitivePath } from "../lib/security/sensitive-path";

import type { Logger } from "../logger";
import type { MiddlewareHandler } from "hono";

/**
 * Structured logger middleware: logs incoming requests with timing context.
 * Adds request_id to log context for correlation across distributed systems.
 *
 * Note: Request completion logging is handled by requestIdMiddleware to avoid duplicate log lines.
 *
 * @example
 * ```typescript
 * app.use("*", loggerMiddleware({ logger }));
 * ```
 */

export interface LoggerMiddlewareOptions {
  /** Root logger instance. */
  logger: Logger;
  /** Paths to exclude from logging (e.g., health checks). */
  excludePaths?: string[];
}

/**
 * Logger middleware that captures incoming request details.
 */
export function loggerMiddleware({
  logger,
  excludePaths = ["/healthz", "/readyz"],
}: LoggerMiddlewareOptions): MiddlewareHandler {
  return async (c, next) => {
    const path = sanitizeSensitivePath(c.req.path);

    // Skip logging for excluded paths (health checks, etc.)
    if (excludePaths.includes(path)) {
      await next();
      return;
    }

    const requestId = c.get("requestId");
    const log = c.get("log") ?? logger.child({ request_id: requestId });

    // Log incoming request
    const requestInfo: Record<string, unknown> = {
      method: c.req.method,
      path,
      query: Object.fromEntries(new URL(c.req.url).searchParams),
      user_agent: c.req.header("User-Agent"),
      content_type: c.req.header("Content-Type"),
      accept_language: c.req.header("Accept-Language"),
    };

    log.info(requestInfo, "request received");

    await next();
  };
}
