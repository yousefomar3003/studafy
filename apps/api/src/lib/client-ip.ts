import type { AppEnv } from "../middleware/requestId";
import type { Context } from "hono";

/**
 * The first X-Forwarded-For hop, or null. Guarded rather than passed through because the value is
 * written to an `inet` column, where an empty string fails the whole statement (see toInetOrNull in
 * lib/security/securityEventSink.ts).
 *
 * Several route files still carry a private copy of this function; new code imports this one.
 */
export function clientIpFrom(c: Context<AppEnv>): string | null {
  const first = c.req.header("X-Forwarded-For")?.split(",")[0]?.trim();
  return first ? first : null;
}
