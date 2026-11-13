/**
 * CSRF token utilities: cryptographic token generation and validation.
 *
 * Implements the double-submit cookie pattern:
 * 1. Generate a cryptographically secure token
 * 2. Store in cookie (accessible to JavaScript)
 * 3. Client sends token in custom header
 * 4. Server validates header token matches cookie token
 *
 * All operations are stateless - no database lookups required.
 */

import { timingSafeEqual } from "crypto";

const TOKEN_BYTES = 32; // 256 bits

/**
 * Generate a cryptographically secure CSRF token.
 *
 * Uses the Web Crypto API (CSPRNG) for secure random generation.
 *
 * @returns Base64URL-encoded token string
 */
export function generateCsrfToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Validate a CSRF token pair using constant-time comparison.
 *
 * The tokens are compared as opaque strings rather than decoded first. Decoding would make the
 * comparison ambiguous — base64url decoding is lenient, so several distinct strings decode to the
 * same bytes and would compare equal. Exact string equality is both stricter and simpler, and the
 * token's encoding is irrelevant to a check that only ever asks "are these the same value".
 *
 * @param cookieToken - Token from cookie
 * @param headerToken - Token from request header
 * @returns true if tokens match, false otherwise
 */
export function validateCsrfToken(cookieToken: string, headerToken: string): boolean {
  if (!cookieToken || !headerToken) {
    return false;
  }

  const cookieBytes = Buffer.from(cookieToken, "utf8");
  const headerBytes = Buffer.from(headerToken, "utf8");

  // timingSafeEqual throws on a length mismatch, so the lengths must be checked first. This leaks
  // only the token's length, which is a fixed constant and not a secret.
  if (cookieBytes.length !== headerBytes.length) {
    return false;
  }

  return timingSafeEqual(cookieBytes, headerBytes);
}
