import { createHmac, timingSafeEqual } from "node:crypto";

import { ROLES } from "@studafy/constants";
import { z } from "zod";

import type { Role } from "@studafy/constants";

/**
 * JWT handshake stub. Real signature verification (HS256) and expiry checking, so a connection
 * still requires a validly-signed, unexpired token — but there is no real identity provider yet,
 * so this module is both issuer and verifier of a single shared secret (`WS_JWT_SECRET`). It
 * deliberately does not do: issuer/audience checks, JWKS/RS256 rotation, or revocation — those
 * need the real auth service and are out of scope for this ticket. Replace `signToken` with a
 * call to the real issuer, and `verifyToken`'s secret lookup with JWKS verification, in the ticket
 * that wires up real authentication.
 */

export interface AuthClaims {
  userId: string;
  schoolId: string;
  role: Role;
}

const claimsSchema = z.object({
  sub: z.string().min(1),
  schoolId: z.string().min(1),
  role: z.enum(ROLES),
  /** Seconds since epoch, per the JWT spec's `exp` claim. */
  exp: z.number().int().positive().optional(),
});

export class TokenVerificationError extends Error {
  constructor(reason: string) {
    super(`Token verification failed: ${reason}`);
    this.name = "TokenVerificationError";
  }
}

function base64UrlDecode(segment: string): Buffer {
  return Buffer.from(segment, "base64url");
}

function base64UrlEncode(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

function sign(headerAndPayload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(headerAndPayload).digest();
}

/**
 * Verifies an HS256-signed token against `secret` and checks `exp` if present. Throws
 * {@link TokenVerificationError} for any malformed, mis-signed, or expired token.
 */
export function verifyToken(token: string, secret: string): AuthClaims {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new TokenVerificationError("expected header.payload.signature");
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  const expected = sign(`${headerB64}.${payloadB64}`, secret);
  const actual = base64UrlDecode(signatureB64);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new TokenVerificationError("invalid signature");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
  } catch {
    throw new TokenVerificationError("payload is not valid JSON");
  }

  const parsed = claimsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new TokenVerificationError(z.prettifyError(parsed.error));
  }

  if (parsed.data.exp !== undefined && parsed.data.exp * 1000 < Date.now()) {
    throw new TokenVerificationError("token expired");
  }

  return { userId: parsed.data.sub, schoolId: parsed.data.schoolId, role: parsed.data.role };
}

/**
 * Mints a token this module's own {@link verifyToken} accepts. Stands in for the future identity
 * provider — used by tests and `scripts/smoke-test.ts`, not meant to survive real auth
 * integration.
 */
export function signToken(
  claims: { sub: string; schoolId: string; role: Role; exp?: number },
  secret: string,
): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = base64UrlEncode(sign(`${header}.${payload}`, secret));
  return `${header}.${payload}.${signature}`;
}
