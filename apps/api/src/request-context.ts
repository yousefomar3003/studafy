import { sanitizeSensitivePath } from "./lib/security/sensitive-path";

import type { Logger } from "./logger";
import type { MiddlewareHandler } from "hono";

/**
 * @deprecated Import from "./middleware/requestId" instead. This file re-exports types and the
 * legacy requestContext function for backward compatibility with existing test files.
 */
export type { AppEnv, AppVariables, AuthContext } from "./middleware/requestId";

export interface RequestContextOptions {
  logger: Logger;
  /** Seam for deterministic ids in tests. Defaults to crypto.randomUUID (CSPRNG-backed v4). */
  generateRequestId?: () => string;
}

/**
 * @deprecated Use requestIdMiddleware from "./middleware/requestId" instead.
 */
export function requestContext({
  logger,
  generateRequestId = () => crypto.randomUUID(),
}: RequestContextOptions): MiddlewareHandler {
  return async (c, next) => {
    const requestId = generateRequestId();
    const startedAt = performance.now();

    const auth = c.get("auth");

    const log = logger.child({
      request_id: requestId,
      method: c.req.method,
      path: sanitizeSensitivePath(c.req.path),
      school_id: auth?.schoolId ?? null,
      user_id: auth?.userId ?? null,
    });

    c.set("requestId", requestId);
    c.set("log", log);

    await next();

    c.header("X-Request-Id", requestId);

    c.get("log").info(
      {
        status: c.res.status,
        duration_ms: Math.round((performance.now() - startedAt) * 1000) / 1000,
      },
      "request completed",
    );
  };
}
