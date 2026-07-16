import type { Logger } from "./logger";
import type { MiddlewareHandler } from "hono";

/**
 * Per-request tracing context: a generated request id, and a child logger bound to it. The id is
 * returned as X-Request-Id, embedded in every problem+json body, and carried to the database as the
 * transaction-local app.request_id GUC, which is what lets a log line be joined to the audit row it
 * produced. See docs/architecture/SAD_28_logging_conventions.md.
 */

/** Identity of the caller. Populated by an authentication middleware; this repo has none yet. */
export interface AuthContext {
  schoolId: string;
  userId: string;
}

export interface AppVariables {
  requestId: string;
  log: Logger;
  auth?: AuthContext;
}

export interface AppEnv {
  Variables: AppVariables;
}

export interface RequestContextOptions {
  logger: Logger;
  /** Seam for deterministic ids in tests. Defaults to crypto.randomUUID (CSPRNG-backed v4). */
  generateRequestId?: () => string;
}

export function requestContext({
  logger,
  generateRequestId = () => crypto.randomUUID(),
}: RequestContextOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // Always generated, never read from the request. An inbound X-Request-Id is client-controlled
    // input, and the edge forwards client headers unchanged — we have no trust boundary that could
    // make it safe. This id keys app.audit_logs.request_id, so honouring a caller's value would let
    // it choose the identifier for its own audit row, pin every request to one id, or collide with
    // another tenant's. It also reaches set_config('app.request_id', …), where a non-UUID raises
    // 22P02 — a client-triggerable 500. If upstream correlation is ever needed, log the caller's
    // value under a separate, explicitly untrusted, length-capped key; never under this one.
    const requestId = generateRequestId();
    const startedAt = performance.now();

    // No authentication exists in this repo, so this is undefined and both tenant fields bind null.
    // null rather than omitted: "we do not know who this is" and "this key does not apply" must not
    // look identical to "the field is missing" in a log query.
    //
    // This read documents the seam but is not the mechanism that will fire — an auth middleware
    // necessarily runs inside this one, so it cannot have set `auth` by this line. The mechanism is
    // the re-child, which an auth middleware performs itself:
    //     c.set("log", c.get("log").child({ school_id, user_id }))
    // Later bindings win in a JSON reader, so that override costs one string concat.
    const auth = c.get("auth");

    const log = logger.child({
      request_id: requestId,
      method: c.req.method,
      // Path only, never the query string: a query can carry a token or a PII filter, and neither
      // belongs in a log line.
      path: c.req.path,
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
