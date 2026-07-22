/**
 * Ephemeral state store for the OAuth authorization-code flow.
 *
 * Holds the code_verifier and nonce keyed by the state parameter for the short window between
 * /start and /callback (typically seconds, never more than the TTL). In-memory is the right
 * choice here: the state is single-use, short-lived, and not shared across processes. A
 * Redis-backed store would be the follow-up if the service scales beyond a single instance.
 *
 * Expired entries are evicted lazily on get() and proactively every N calls.
 */

const SWEEP_INTERVAL = 10;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface StateEntry {
  codeVerifier: string;
  nonce: string;
  createdAt: number;
  /** When present, this state initiates a provider-link flow bound to this user. */
  purpose?: "link";
  userId?: string;
  schoolId?: string;
}

export interface StateStore {
  set(state: string, entry: StateEntry): void;
  get(state: string): StateEntry | undefined;
  delete(state: string): void;
}

export function createStateStore(ttlMs = DEFAULT_TTL_MS): StateStore {
  const map = new Map<string, StateEntry>();
  let callCount = 0;

  function sweep(): void {
    const now = Date.now();
    for (const [key, entry] of map) {
      if (now - entry.createdAt > ttlMs) map.delete(key);
    }
  }

  return {
    set(state, entry) {
      map.set(state, entry);
    },

    get(state) {
      callCount += 1;
      if (callCount % SWEEP_INTERVAL === 0) sweep();

      const entry = map.get(state);
      if (!entry) return undefined;

      if (Date.now() - entry.createdAt > ttlMs) {
        map.delete(state);
        return undefined;
      }

      return entry;
    },

    delete(state) {
      map.delete(state);
    },
  };
}
