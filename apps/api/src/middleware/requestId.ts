import { sanitizeSensitivePath } from "../lib/security/sensitive-path";

import type { AuthContext } from "./authContext";
import type { Logger } from "../logger";
import type { AiEntitlementContext, AiQuotaHandle } from "../modules/ai/gate/entitlement-gate";
import type { MiddlewareHandler } from "hono";

/**
 * Request ID middleware: generates a unique identifier per request and attaches it to the request
 * context. The ID is never read from the request — client-provided values are untrusted input.
 *
 * The generated ID is used for:
 * - X-Request-Id response header
 * - RFC 9457 problem+json request_id field
 * - Database transaction app.request_id GUC
 * - Structured log correlation
 */

export interface RequestIdOptions {
  /** Root logger instance. */
  logger: Logger;
  /** Seam for deterministic request IDs in tests. Defaults to crypto.randomUUID (CSPRNG-backed v4). */
  generateRequestId?: () => string;
}

/**
 * Middleware that generates a unique request ID and attaches it to the request context.
 *
 * @example
 * ```typescript
 * app.use("*", requestIdMiddleware({ logger }));
 * ```
 */
export function requestIdMiddleware({
  logger,
  generateRequestId = () => crypto.randomUUID(),
}: RequestIdOptions): MiddlewareHandler {
  return async (c, next) => {
    // Always generated, never read from the request. An inbound X-Request-Id is client-controlled
    // input, and the edge forwards client headers unchanged — we have no trust boundary that could
    // make it safe. This id keys app.audit_logs.request_id, so honouring a caller's value would let
    // it choose the identifier for its own audit row, pin every request to one id, or collide with
    // another tenant's.
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

    // After next(), like the HSTS header alongside it. A header set before next() is only staged
    // and is dropped if a handler returns a Response it did not build through `c`. Setting it here
    // also stamps responses produced by app.onError: Hono catches a handler's throw at that
    // handler's own dispatch frame and returns normally, so an error response unwinds back through
    // this line.
    c.header("X-Request-Id", requestId);

    // Re-read from the context rather than closing over `log`: a middleware below this one may have
    // re-childed it with an identity we did not have on the way in.
    c.get("log").info(
      {
        status: c.res.status,
        duration_ms: Math.round((performance.now() - startedAt) * 1000) / 1000,
      },
      "request completed",
    );
  };
}

/**
 * Types for request context variables.
 *
 * AuthContext itself lives in ./authContext.ts — it is defined by what jwtAuth.ts hydrates, not by
 * this middleware — and is re-exported here so the import sites that predate it keep working.
 */
export type { AuthContext } from "./authContext";

export interface AppVariables {
  requestId: string;
  log: Logger;
  locale: string;
  auth?: AuthContext;
  /**
   * The resolved AI entitlement verdict and budget, set by aiEntitlementGate (ST-155) for every
   * `/api/ai/*` request that passes its gates.
   */
  aiEntitlement?: AiEntitlementContext;
  /**
   * The live quota reservation, set by aiEntitlementGate for requests that consume quota. AI route
   * handlers commit their actual usage through this handle; the gate releases it if they never
   * settle. Read with getAiQuota(c).
   */
  aiQuota?: AiQuotaHandle;
}

export interface AppEnv {
  Variables: AppVariables;
}
