import {
  JTI_DENYLIST_PREFIX,
  REALTIME_TICKET,
  REALTIME_TICKET_USED_PREFIX,
} from "@studafy/constants";

import type { AuthClaims } from "./auth";

/**
 * Session checks the handshake and the revocation sweep need beyond the ticket's signature
 * (F-05, QA-14): a ticket opens one socket, and a revoked session loses its sockets.
 *
 * Both read the API's Redis keyspace, which is why the gateway has a second Redis URL
 * (`AUTH_REDIS_URL`, env.ts): the API keeps its denylist in a different logical database from the
 * one the gateway's pub/sub connection selects.
 */
export interface SessionGuard {
  /**
   * Spends the ticket and checks its session in one round trip. Rejects when Redis is unreachable,
   * and the handshake answers 503: letting a ticket through unchecked would make it reusable.
   */
  admit(claims: AuthClaims, nowMs?: number): Promise<"ok" | "replayed" | "revoked">;
  /** Which of `sessionIds` the API has revoked. Rejects when Redis is unreachable. */
  revokedSessions(sessionIds: readonly string[]): Promise<Set<string>>;
}

/** The subset of ioredis this module uses, so tests can pass a fake. */
export interface GuardRedis {
  set(key: string, value: string, ex: "EX", seconds: number, nx: "NX"): Promise<"OK" | null>;
  exists(key: string): Promise<number>;
  mget(keys: string[]): Promise<(string | null)[]>;
}

/** Keys per MGET in a sweep. Bounds one command's size, whatever the number of sockets. */
const SWEEP_BATCH = 500;

export function createRedisSessionGuard(redis: GuardRedis): SessionGuard {
  return {
    async admit(claims, nowMs = Date.now()) {
      // Kept until the ticket could no longer verify anyway, plus the skew the verifier allows.
      const ttl = Math.max(
        1,
        Math.ceil(claims.exp - nowMs / 1000) + REALTIME_TICKET.clockSkewSeconds,
      );
      const [spent, revoked] = await Promise.all([
        redis.set(`${REALTIME_TICKET_USED_PREFIX}${claims.ticketId}`, "1", "EX", ttl, "NX"),
        redis.exists(`${JTI_DENYLIST_PREFIX}${claims.sessionId}`),
      ]);
      if (revoked === 1) return "revoked";
      if (spent === null) return "replayed";
      return "ok";
    },

    async revokedSessions(sessionIds) {
      const revoked = new Set<string>();
      for (let start = 0; start < sessionIds.length; start += SWEEP_BATCH) {
        const batch = sessionIds.slice(start, start + SWEEP_BATCH);
        const values = await redis.mget(batch.map((id) => `${JTI_DENYLIST_PREFIX}${id}`));
        values.forEach((value, index) => {
          if (value !== null) revoked.add(batch[index]);
        });
      }
      return revoked;
    },
  };
}

/** One open socket's session, as the sweep sees it. */
export interface LiveSession {
  sessionId: string;
  /** Tells the client and closes the socket. Called at most once per socket. */
  close(reason: string): void;
}

/**
 * Open sockets keyed by their raw socket, the same identity rooms.ts and lifecycle.ts use. app.ts
 * adds an entry on open and removes it on close; the sweep reads it.
 */
export interface SessionRegistry<S> {
  add(socket: S, session: LiveSession): void;
  remove(socket: S): void;
  sessions(): LiveSession[];
}

export function createSessionRegistry<S>(): SessionRegistry<S> {
  const live = new Map<S, LiveSession>();
  return {
    add: (socket, session) => void live.set(socket, session),
    remove: (socket) => void live.delete(socket),
    sessions: () => [...live.values()],
  };
}

/**
 * How often open sockets are checked against the denylist. A revoked session's sockets close
 * within this interval of the API writing the denylist entry, plus one Redis round trip.
 */
export const REVOCATION_SWEEP_INTERVAL_MS = 15_000;

export const SESSION_REVOKED_REASON = "session revoked";

/**
 * Closes every socket whose session the API has revoked. Returns how many it closed. A Redis error
 * propagates: the caller logs it and the next sweep tries again, so revocation is late but never
 * skipped while the sockets stay open.
 */
export async function sweepRevokedSessions(
  registry: SessionRegistry<unknown>,
  guard: SessionGuard,
): Promise<number> {
  const sessions = registry.sessions();
  if (sessions.length === 0) return 0;
  const ids = [...new Set(sessions.map((session) => session.sessionId))];
  const revoked = await guard.revokedSessions(ids);
  let closed = 0;
  for (const session of sessions) {
    if (revoked.has(session.sessionId)) {
      session.close(SESSION_REVOKED_REASON);
      closed += 1;
    }
  }
  return closed;
}

/**
 * Runs {@link sweepRevokedSessions} every `intervalMs`. A sweep still in flight when the next is
 * due is not doubled up. Returns a stop function for shutdown.
 */
export function startRevocationSweep({
  registry,
  guard,
  intervalMs = REVOCATION_SWEEP_INTERVAL_MS,
  onError,
}: {
  registry: SessionRegistry<unknown>;
  guard: SessionGuard;
  intervalMs?: number;
  onError: (error: unknown) => void;
}): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    sweepRevokedSessions(registry, guard)
      .catch(onError)
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return () => clearInterval(timer);
}
