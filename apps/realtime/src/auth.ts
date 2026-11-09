import { createHmac, timingSafeEqual } from "node:crypto";

import { REALTIME_TICKET, ROLES } from "@studafy/constants";
import { z } from "zod";

import type { Role } from "@studafy/constants";

/**
 * Handshake ticket verification (F-05, QA-14). The contract is in docs/protocol.md#handshake-ticket
 * and its constants in @studafy/constants' REALTIME_TICKET.
 *
 * `apps/api` mints the ticket (`POST /api/realtime/tickets`, apps/api/src/modules/realtime) for a
 * caller holding a valid session, signed HS256 with `WS_JWT_SECRET`, which both services read from
 * Secrets Manager. The gateway checks it here and never sees the session's access token.
 *
 * Why a shared key rather than the API's JWKS: the API generates its RSA keys in memory, per task
 * (apps/api/src/modules/auth/jwt/key-store.ts), so a JWKS fetched through the load balancer can come
 * from a different task than the one that signed the ticket. An agreed key has no such window and
 * no network dependency at handshake time.
 *
 * Single use and revocation are not this module's job: it is pure. The handshake in app.ts spends
 * `ticketId` and checks `sessionId` against the API's denylist through src/session-guard.ts.
 */

export interface AuthClaims {
  userId: string;
  schoolId: string;
  /** Every role the session holds in the school. Never empty. */
  roles: readonly Role[];
  /** The session's access-token `jti`, which the API denylists on revocation. */
  sessionId: string;
  /** When the session's access token expires (seconds since epoch). The socket closes then. */
  sessionExp: number;
  /** This ticket's own `jti`. Spent at handshake, so a ticket opens one socket. */
  ticketId: string;
  /** The ticket's own expiry (seconds since epoch). Bounds the handshake only. */
  exp: number;
}

const claimsSchema = z.object({
  iss: z.literal(REALTIME_TICKET.issuer),
  aud: z.literal(REALTIME_TICKET.audience),
  sub: z.string().min(1),
  school_id: z.string().min(1),
  roles: z.array(z.enum(ROLES)).min(1),
  sid: z.string().min(1),
  sexp: z.number().int().positive(),
  jti: z.string().min(1),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
});

const headerSchema = z.object({ alg: z.literal("HS256") });

/**
 * `code` drives the re-auth protocol (see docs/protocol.md#re-auth-protocol): `TOKEN_EXPIRED` tells
 * the client its credentials are merely stale, so it should get a fresh ticket and reconnect. Every
 * other cause is `TOKEN_INVALID`: the ticket itself is untrustworthy, so retrying it is pointless.
 * The codes keep their `TOKEN_` names so that clients built against the previous handshake still
 * branch correctly.
 */
export type TokenVerificationErrorCode = "TOKEN_EXPIRED" | "TOKEN_INVALID";

export class TokenVerificationError extends Error {
  readonly code: TokenVerificationErrorCode;

  constructor(reason: string, code: TokenVerificationErrorCode = "TOKEN_INVALID") {
    super(`Ticket verification failed: ${reason}`);
    this.name = "TokenVerificationError";
    this.code = code;
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

function parseJson(segment: string, what: string): unknown {
  try {
    return JSON.parse(base64UrlDecode(segment).toString("utf8"));
  } catch {
    throw new TokenVerificationError(`${what} is not valid JSON`);
  }
}

/**
 * Verifies a handshake ticket and returns its claims. Throws {@link TokenVerificationError} when it
 * is malformed, signed with another key or algorithm, addressed to anyone else, issued for longer
 * than {@link REALTIME_TICKET.maxTtlSeconds}, issued in the future, or expired.
 *
 * The error message names the failed check and never includes the ticket.
 */
export function verifyToken(token: string, secret: string, nowMs: number = Date.now()): AuthClaims {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new TokenVerificationError("expected header.payload.signature");
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  // Checked before the signature only to refuse another algorithm by name; the HMAC below is what
  // actually proves the ticket, and it is computed with HS256 whatever the header claims.
  if (!headerSchema.safeParse(parseJson(headerB64, "header")).success) {
    throw new TokenVerificationError("unsupported algorithm");
  }

  const expected = sign(`${headerB64}.${payloadB64}`, secret);
  const actual = base64UrlDecode(signatureB64);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new TokenVerificationError("invalid signature");
  }

  const parsed = claimsSchema.safeParse(parseJson(payloadB64, "payload"));
  if (!parsed.success) {
    throw new TokenVerificationError(z.prettifyError(parsed.error));
  }
  const claims = parsed.data;

  const nowSeconds = nowMs / 1000;
  if (claims.exp - claims.iat > REALTIME_TICKET.maxTtlSeconds) {
    throw new TokenVerificationError("ticket lifetime exceeds the maximum");
  }
  if (claims.iat > nowSeconds + REALTIME_TICKET.clockSkewSeconds) {
    throw new TokenVerificationError("ticket issued in the future");
  }
  if (claims.exp <= nowSeconds) {
    throw new TokenVerificationError("ticket expired", "TOKEN_EXPIRED");
  }
  if (claims.sexp <= nowSeconds) {
    throw new TokenVerificationError("session expired", "TOKEN_EXPIRED");
  }

  return {
    userId: claims.sub,
    schoolId: claims.school_id,
    roles: claims.roles,
    sessionId: claims.sid,
    sessionExp: claims.sexp,
    ticketId: claims.jti,
    exp: claims.exp,
  };
}

/** The claims a ticket carries, as the API mints them. */
export interface TicketPayload {
  iss: string;
  aud: string;
  sub: string;
  school_id: string;
  roles: readonly Role[];
  sid: string;
  sexp: number;
  jti: string;
  iat: number;
  exp: number;
}

/**
 * Mints a ticket this module accepts. For the gateway's own tests and `scripts/smoke-test.ts`
 * only: the issuer in production is apps/api, and the contract test
 * (apps/api/tests/realtime/ticket-contract.test.ts) proves the two agree.
 */
export function signToken(payload: TicketPayload, secret: string): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = base64UrlEncode(sign(`${header}.${body}`, secret));
  return `${header}.${body}.${signature}`;
}

/**
 * A ticket payload with every claim valid now, for tests and the smoke test. Overrides replace
 * individual claims.
 */
export function ticketPayload(
  claims: { sub: string; school_id: string; roles: readonly Role[] } & Partial<TicketPayload>,
  nowMs: number = Date.now(),
): TicketPayload {
  const iat = Math.floor(nowMs / 1000);
  return {
    iss: REALTIME_TICKET.issuer,
    aud: REALTIME_TICKET.audience,
    sid: crypto.randomUUID(),
    sexp: iat + 900,
    jti: crypto.randomUUID(),
    iat,
    exp: iat + REALTIME_TICKET.ttlSeconds,
    ...claims,
  };
}
