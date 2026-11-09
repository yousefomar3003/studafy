/**
 * Resource limits for the gateway (F-16). Without them one valid token could send unbounded frames,
 * grow the room maps until the process ran out of memory, and open sockets from any web page.
 */

/** Largest client frame Bun accepts; a bigger one closes the socket with 1009 (message too big). */
export const MAX_PAYLOAD_BYTES = 16 * 1024;

/** Close code for a socket that exceeds the control-frame rate limit (RFC 6455: policy violation). */
export const RATE_LIMITED_CLOSE_CODE = 1008;

export interface RealtimeLimits {
  /**
   * Most rooms one socket may be in at once, home rooms included. The room policy already keeps an
   * honest socket to its three home rooms; this cap stops growth if a future room kind allows more.
   */
  maxRoomsPerSocket: number;
  /** Client frames a socket may send in a burst before the limiter kicks in. */
  controlBurst: number;
  /** Client frames per second the burst refills at. */
  controlRefillPerSecond: number;
}

export const DEFAULT_LIMITS: RealtimeLimits = {
  maxRoomsPerSocket: 8,
  // A client sends one `join` per tracked room on reconnect, so a handful is the honest peak.
  controlBurst: 20,
  controlRefillPerSecond: 2,
};

export interface TokenBucket {
  /** Spends one token. False when the bucket is empty: the frame is over the limit. */
  take(): boolean;
}

/** A per-socket token bucket: `capacity` frames at once, refilled at `refillPerSecond`. */
export function createTokenBucket(
  capacity: number,
  refillPerSecond: number,
  now: () => number = Date.now,
): TokenBucket {
  let tokens = capacity;
  let last = now();
  return {
    take() {
      const current = now();
      tokens = Math.min(capacity, tokens + ((current - last) / 1000) * refillPerSecond);
      last = current;
      if (tokens < 1) {
        return false;
      }
      tokens -= 1;
      return true;
    },
  };
}

/** Splits a comma-separated origin list, trimming blanks. */
export function parseOriginList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** True for a bare `scheme://host[:port]` origin — what a browser's `Origin` header looks like. */
export function isBareOrigin(value: string): boolean {
  try {
    // WHATWG URL parsing accepts `*` in a host, so a wildcard has to be refused explicitly.
    return !value.includes("*") && new URL(value).origin === value;
  } catch {
    return false;
  }
}

/**
 * Handshake Origin check. An empty allowlist turns the check off (development only; `env.ts`
 * requires a list in production). A request without an `Origin` header passes: browsers always
 * send one on a WebSocket handshake, so its absence means a non-browser client (the mobile app, a
 * server), which cross-site WebSocket hijacking — what this check prevents — cannot come from.
 */
export function isOriginAllowed(origin: string | undefined, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0 || origin === undefined) {
    return true;
  }
  return allowlist.includes(origin);
}
