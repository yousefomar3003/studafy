import type { SessionGuard } from "./session-guard";

/**
 * An in-memory {@link SessionGuard} for tests: the same answers the Redis one gives, over a Set of
 * spent ticket ids and a Set of revoked session ids the test controls. Not imported by index.ts.
 */
export function createMemorySessionGuard(): SessionGuard & {
  revoke(sessionId: string): void;
  failNext(error: Error): void;
} {
  const spent = new Set<string>();
  const revoked = new Set<string>();
  let failure: Error | undefined;

  const takeFailure = () => {
    const error = failure;
    failure = undefined;
    if (error) throw error;
  };

  return {
    async admit(claims) {
      takeFailure();
      if (revoked.has(claims.sessionId)) return "revoked";
      if (spent.has(claims.ticketId)) return "replayed";
      spent.add(claims.ticketId);
      return "ok";
    },
    async revokedSessions(sessionIds) {
      takeFailure();
      return new Set(sessionIds.filter((id) => revoked.has(id)));
    },
    revoke: (sessionId) => void revoked.add(sessionId),
    failNext: (error) => {
      failure = error;
    },
  };
}
