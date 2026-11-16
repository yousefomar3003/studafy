import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of a presented secret with the expected one (QA-092). Both are hashed
 * first, so timingSafeEqual always compares 32 bytes: neither the content nor the length of the
 * expected secret shows in how long a wrong guess takes. A missing or empty value never matches.
 */
export function secretsMatch(
  given: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  if (!given || !expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
