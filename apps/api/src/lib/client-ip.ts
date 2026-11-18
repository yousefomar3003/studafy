import { isIP } from "node:net";

import { getSecurityConfig } from "../config/security";

interface HeaderSource {
  req: { header(name: string): string | undefined };
}

/**
 * The visitor's address for an `inet` column, or null when it cannot be determined.
 *
 * Order of trust:
 *   1. `CLIENT_IP_HEADER` — the header the platform proxy overwrites on every request
 *      (`fly-client-ip` on fly.io), so the visitor cannot forge it. When configured it is the only
 *      source; a request without it gets null (QA-086).
 *   2. Only for deployments without such a header: the first X-Forwarded-For hop, then X-Real-IP.
 *
 * Whatever is chosen must parse as one IPv4 or IPv6 address. A raw X-Forwarded-For value is a
 * comma-separated list ("203.0.113.7, 66.241.125.144" behind fly's edge), and handing that — or an
 * empty or forged string — to PostgreSQL fails the whole statement with "invalid input syntax for
 * type inet". That broke member sign-in with a setup code in production (the session insert
 * failed after the new password was accepted). Null is always safe; the column is nullable.
 *
 * Every route that records a client address uses this helper; do not read the headers directly.
 */
export function clientIpFrom(c: HeaderSource): string | null {
  const trustedHeader = getSecurityConfig().clientIpHeader;
  // With a trusted header configured, it is the only source (QA-086): a request without it did not
  // come through the edge (a caller on the private network), and X-Forwarded-For is whatever that
  // caller chose to write.
  const candidates = trustedHeader
    ? [c.req.header(trustedHeader)]
    : [c.req.header("x-forwarded-for")?.split(",")[0], c.req.header("x-real-ip")];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value && isIP(value) !== 0) return value;
  }
  return null;
}
