import { randomUUID } from "node:crypto";

import { REALTIME_TICKET } from "@studafy/constants";
import { SignJWT } from "jose";

import type { Role } from "@studafy/constants";

/**
 * Realtime handshake ticket issuer (F-05, QA-14). The gateway's verifier is
 * apps/realtime/src/auth.ts; the contract both follow is apps/realtime/docs/protocol.md#handshake-ticket,
 * and tests/realtime/ticket-contract.test.ts runs this issuer against that verifier.
 *
 * A ticket stands in for the session at the gateway, so the session's access token never travels
 * in a WebSocket URL (and so never lands in a load-balancer access log). It names the session it
 * came from (`sid`, the access token's `jti`, and `sexp`, its `exp`): the gateway closes the socket
 * when that session expires or is denylisted.
 */

/** The authenticated session a ticket is minted for. */
export interface TicketSession {
  userId: string;
  schoolId: string;
  roles: readonly Role[];
  /** The access token's `jti`: what the API denylists when it revokes the session. */
  accessTokenJti: string;
  /** The access token's `exp`, in seconds since the epoch. */
  accessTokenExp: number;
}

export interface MintedTicket {
  ticket: string;
  expiresAt: Date;
}

/**
 * Signs a ticket for `session` with `secret` (`WS_JWT_SECRET`). HS256, lifetime
 * {@link REALTIME_TICKET.ttlSeconds}, a fresh `jti` per call.
 */
export async function mintRealtimeTicket(
  session: TicketSession,
  secret: string,
  now: () => number = Date.now,
): Promise<MintedTicket> {
  const iat = Math.floor(now() / 1000);
  const exp = iat + REALTIME_TICKET.ttlSeconds;
  const ticket = await new SignJWT({
    school_id: session.schoolId,
    roles: [...session.roles],
    sid: session.accessTokenJti,
    sexp: session.accessTokenExp,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(REALTIME_TICKET.issuer)
    .setAudience(REALTIME_TICKET.audience)
    .setSubject(session.userId)
    .setJti(randomUUID())
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(secret));
  return { ticket, expiresAt: new Date(exp * 1000) };
}
