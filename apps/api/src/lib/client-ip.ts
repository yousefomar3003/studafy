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
 *      (`fly-client-ip` on fly.io), so the visitor cannot forge it.
 *   2. The first X-Forwarded-For hop, then X-Real-IP, for deployments without such a header.
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
  const candidates = [
    trustedHeader ? c.req.header(trustedHeader) : undefined,
    c.req.header("x-forwarded-for")?.split(",")[0],
    c.req.header("x-real-ip"),
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value && isIP(value) !== 0) return value;
  }
  return null;
}
