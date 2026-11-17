/**
 * Framework-agnostic web session store.
 *
 * Owns the access-token lifecycle for a browser session against the Studafy API. The access token
 * lives in memory only — never in localStorage, sessionStorage, or a cookie — and is re-fetched by
 * rotating the HttpOnly refresh cookie (see `auth/api.ts` for the wire client and
 * `apps/api/src/modules/auth/delivery.ts` for why the refresh token stays out of JavaScript's reach).
 *
 * Responsibilities, each deliberately small (SRP):
 *   - a status state machine (`restoring | authenticated | unauthenticated | expired`),
 *   - single-flight refresh so concurrent callers share one rotation — the backend burns a token
 *     family on reuse (`SAD_13_session_model.md`: "clients must serialize refreshes"),
 *   - a proactive rotation timer armed from `expires_in` minus a safety margin, plus a reactive
 *     `getToken()` path that rotates when the in-memory token is stale (covers throttled background
 *     tabs, where timers run late),
 *   - lazy restore: nothing is checked until a guard or an authenticated request first asks for a
 *     token, so a public page load does not rotate the refresh cookie.
 *
 * The store is a plain module with injected dependencies (the refresh client and the timer/clock
 * seams); the React wiring lives in `context.tsx`. No token material is ever written to a storage
 * medium — the code audit test (`token-storage.test.ts`) locks that in.
 */

import { decodeAccessTokenRoles, decodeAccessTokenUserId } from "./access-token-claims";

/**
 * Session lifecycle state.
 * - `restoring` — no token demand yet, or a first-time check in flight. Guards render a loader
 *   here; the first `restore()`/`getToken()` call resolves it. (A *background* rotation with a
 *   token in hand keeps reporting `authenticated` until its outcome is known.)
 * - `authenticated` — an access token is held in memory. Invariant: a held token with
 *   `expiresAt > now`.
 * - `unauthenticated` — the refresh endpoint answered 400 (no cookie), or a transient failure left
 *   nothing servable: there is no session.
 * - `expired` — the refresh endpoint answered 401 (a credential existed but is dead — revoked,
 *   reused, or expired). The session ended mid-life and the UI should say so.
 */
export type SessionStatus = "restoring" | "authenticated" | "unauthenticated" | "expired";

/** The in-memory session after a successful rotation. */
export interface SessionTokens {
  /** RS256 JWT; sent as `Authorization: Bearer` by the api-client's auth interceptor. */
  readonly accessToken: string;
  /** Epoch milliseconds at which the access token expires. */
  readonly expiresAt: number;
  /** Identifies the session in `GET /api/auth/sessions`. */
  readonly sessionId: string;
}

/**
 * The two cookie-authenticated endpoints the store talks to. A separate, anonymous api-client
 * instance backs this (see `auth/api.ts`) so a rotation can never loop through the bearer
 * interceptor's own `getToken` call.
 */
export interface SessionRefreshClient {
  /** Rotate the refresh cookie and resolve the new access token. Throws the client's `ApiError`. */
  refresh(): Promise<SessionTokens>;
  /** End the current session server-side (always answers 200). */
  logout(): Promise<void>;
}

/**
 * What the tabs of one browser share (QA-033). Every tab holds the same HttpOnly refresh cookie,
 * and the API burns the session's whole token family when one refresh token is presented twice,
 * so two tabs rotating at once (a browser restoring its tabs, say) log the user out. Tabs therefore
 * rotate one at a time under a cross-tab lock, and the tab that rotated publishes the result; a tab
 * that waited adopts it instead of rotating again.
 */
export interface CrossTabCoordinator {
  /** Run `fn` while holding the browser-wide refresh lock. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  /** Share freshly rotated tokens with the other tabs. */
  publish(tokens: SessionTokens): void;
  /** The newest tokens any tab has published, or null. */
  latest(): SessionTokens | null;
}

const REFRESH_LOCK_NAME = "studafy-refresh";
const SESSION_CHANNEL_NAME = "studafy-session";

/**
 * The browser coordinator: Web Locks for mutual exclusion, BroadcastChannel to share tokens. Falls
 * back to no locking where either API is missing (old browsers, tests without a DOM), which is the
 * pre-QA-033 behaviour.
 */
export function createBrowserCrossTab(): CrossTabCoordinator {
  let latest: SessionTokens | null = null;
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  const channel =
    typeof globalThis.BroadcastChannel === "function"
      ? new globalThis.BroadcastChannel(SESSION_CHANNEL_NAME)
      : null;
  if (channel) {
    channel.onmessage = (event: MessageEvent<SessionTokens>) => {
      const tokens = event.data;
      if (
        tokens &&
        typeof tokens.accessToken === "string" &&
        typeof tokens.expiresAt === "number"
      ) {
        latest = tokens;
      }
    };
  }
  return {
    withLock: <T>(fn: () => Promise<T>): Promise<T> =>
      locks ? (locks.request(REFRESH_LOCK_NAME, () => fn()) as Promise<T>) : fn(),
    publish(tokens) {
      latest = tokens;
      channel?.postMessage(tokens);
    },
    latest: () => latest,
  };
}

/** The opaque handle the rotation timer passes to its `clearTimeout` counterpart. */
export type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface SessionStoreOptions {
  readonly refreshClient: SessionRefreshClient;
  /** Test seam for the clock. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Test seams for the rotation timer. Defaults to the platform timers. */
  readonly setTimeoutFn?: (cb: () => void, delay: number) => TimerHandle;
  readonly clearTimeoutFn?: (id: TimerHandle) => void;
  /**
   * Rotate this many milliseconds before the access token actually expires, so a token is never
   * presented to the API near its lifetime boundary. Defaults to 60 000 (the default access-token
   * TTL is 900 s).
   */
  readonly refreshMarginMs?: number;
  /** Cross-tab coordination (QA-033). Omitted: this tab alone, as before. */
  readonly crossTab?: CrossTabCoordinator;
  /**
   * Runs on every sign-out, after the in-memory session is dropped, whether or not the server call
   * succeeded: clears what this browser kept for the person (QA-089, recent searches).
   */
  readonly onSignedOut?: () => void;
}

export interface SessionStore {
  getStatus(): SessionStatus;
  getSessionId(): string | null;
  /**
   * The `roles` claim of the held access token, decoded once per rotation and cached — see
   * `decodeAccessTokenRoles` for why this is routing/UX data, never an authorization decision.
   * Empty when signed out.
   */
  getRoles(): readonly string[];
  /**
   * The `sub` claim of the held access token (the caller's own `app.users.id`), decoded once per
   * rotation and cached alongside `roles` — see `decodeAccessTokenUserId` for the same
   * "UX data, not an authorization decision" caveat. `null` when signed out.
   */
  getUserId(): string | null;
  /** Resolve the current access token, rotating first if it is stale. Never rejects. */
  getToken(): Promise<string | null>;
  /** Ensure a rotation attempt has happened (idempotent; concurrent callers share one request). */
  restore(): Promise<SessionStatus>;
  /** End the session server-side and drop the in-memory token. */
  logout(): Promise<void>;
  /** Subscribe to status transitions. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}

const DEFAULT_REFRESH_MARGIN_MS = 60_000;

/** HTTP statuses the refresh endpoint uses to mean "no session" vs "session died" (see session-routes.ts). */
const REFRESH_NO_CREDENTIAL_STATUS = 400;
const REFRESH_REJECTED_STATUS = 401;

export function createSessionStore(options: SessionStoreOptions): SessionStore {
  const refreshClient = options.refreshClient;
  const now = options.now ?? Date.now;
  // The platform `setTimeout` returns a `number` under the DOM lib and a `Timeout` under Node's;
  // both are valid for `clearTimeout`. The adapter pins the fallback to the store's `TimerHandle`
  // so it shares one type with the injected test seam.
  const setTimer: (cb: () => void, delay: number) => TimerHandle =
    options.setTimeoutFn ?? ((cb, delay) => globalThis.setTimeout(cb, delay) as TimerHandle);
  const clearTimer: (id: TimerHandle) => void =
    options.clearTimeoutFn ?? ((id) => globalThis.clearTimeout(id));
  const marginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
  const crossTab = options.crossTab ?? null;

  /**
   * Rotate under the cross-tab lock. A tab that waited on the lock first looks at what the tab
   * ahead of it published: tokens newer than its own and still outside the refresh margin are
   * adopted as they are, so N tabs restoring together cost one rotation, not N reuse alarms.
   */
  // Not `async`: without a coordinator this must be exactly the old single call, with no extra
  // microtask hops in the rotation's settling order.
  function refreshOnce(): Promise<SessionTokens> {
    if (crossTab === null) return refreshClient.refresh();
    const held = tokens;
    return crossTab.withLock(async () => {
      const shared = crossTab.latest();
      if (
        shared !== null &&
        shared.accessToken !== held?.accessToken &&
        shared.expiresAt - now() > marginMs
      ) {
        return shared;
      }
      const next = await refreshClient.refresh();
      crossTab.publish(next);
      return next;
    });
  }

  let status: SessionStatus = "restoring";
  let tokens: SessionTokens | null = null;
  let roles: readonly string[] = [];
  let userId: string | null = null;
  let rotationTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let rotationInFlight: Promise<SessionStatus> | null = null;
  const listeners = new Set<() => void>();

  function setStatus(next: SessionStatus): void {
    if (status === next) {
      return;
    }
    status = next;
    for (const listener of [...listeners]) {
      listener();
    }
  }

  /** True while the held token has more than `marginMs` of life left. */
  function tokenIsUsable(): boolean {
    return tokens !== null && tokens.expiresAt - now() > marginMs;
  }

  function cancelRotationTimer(): void {
    if (rotationTimer !== null) {
      clearTimer(rotationTimer);
      rotationTimer = null;
    }
  }

  /** Arm the proactive rotation for the end of the held token's life, minus the margin. */
  function armRotationTimer(): void {
    cancelRotationTimer();
    if (tokens === null) {
      return;
    }
    const delayMs = tokens.expiresAt - now() - marginMs;
    rotationTimer = setTimer(
      () => {
        rotationTimer = null;
        void restore();
      },
      delayMs <= 0 ? 0 : delayMs,
    );
  }

  /**
   * One rotation, shared by every concurrent caller. The backend treats each presented refresh
   * token as valid exactly once and burns the family on reuse, so concurrent rotations must be
   * serialized into a single request.
   *
   * Error handling is deliberate:
   *   - 400 (nothing presented) -> `unauthenticated`: a fresh visitor with no cookie.
   *   - 401 (credential dead) -> `expired`: the session ended; the UI asks the user to sign in again.
   *   - transient (429, 5xx, network) -> keep a still-valid token and status `authenticated`,
   *     retrying the rotation on the next token demand; otherwise drop to `unauthenticated`. The
   *     timer is never re-armed here, so a persistent outage cannot turn into a tight retry loop
   *     against a rate-limited endpoint.
   */
  async function rotate(): Promise<SessionStatus> {
    if (rotationInFlight !== null) {
      return rotationInFlight;
    }

    rotationInFlight = (async () => {
      // Only a first-time check shows the loader. A background rotation (timer or `getToken` on a
      // stale token) keeps reporting `authenticated` until the outcome is known, so the guarded UI
      // never blanks for a few hundred milliseconds on every rotation.
      if (tokens === null) {
        setStatus("restoring");
      }
      try {
        const next = await refreshOnce();
        tokens = next;
        roles = decodeAccessTokenRoles(next.accessToken);
        userId = decodeAccessTokenUserId(next.accessToken);
        setStatus("authenticated");
        armRotationTimer();
      } catch (error) {
        const statusCode = (error as { status?: number }).status;
        cancelRotationTimer();

        if (statusCode === REFRESH_NO_CREDENTIAL_STATUS) {
          tokens = null;
          roles = [];
          userId = null;
          setStatus("unauthenticated");
        } else if (statusCode === REFRESH_REJECTED_STATUS) {
          tokens = null;
          roles = [];
          userId = null;
          setStatus("expired");
        } else if (tokens !== null && tokens.expiresAt > now()) {
          // Transient failure while a still-valid token was held: keep serving it.
          setStatus("authenticated");
        } else {
          tokens = null;
          roles = [];
          userId = null;
          setStatus("unauthenticated");
        }
      } finally {
        rotationInFlight = null;
      }
      return status;
    })();

    return rotationInFlight;
  }

  async function restore(): Promise<SessionStatus> {
    return rotate();
  }

  async function getToken(): Promise<string | null> {
    if (status === "unauthenticated" || status === "expired") {
      return null;
    }
    if (tokens !== null && tokens.expiresAt > now()) {
      // Valid token in hand. If it is inside the refresh margin, rotate in the background and
      // serve the current token meanwhile — requests never block on a rotation.
      if (!tokenIsUsable()) {
        void rotate();
      }
      return tokens.accessToken;
    }
    const result = await rotate();
    return result === "authenticated" && tokens !== null ? tokens.accessToken : null;
  }

  async function logout(): Promise<void> {
    try {
      await refreshClient.logout();
    } finally {
      tokens = null;
      roles = [];
      userId = null;
      cancelRotationTimer();
      setStatus("unauthenticated");
      options.onSignedOut?.();
    }
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return {
    getStatus: () => status,
    getSessionId: () => tokens?.sessionId ?? null,
    getRoles: () => roles,
    getUserId: () => userId,
    getToken,
    restore,
    logout,
    subscribe,
  };
}
