/**
 * Ephemeral state store for the OAuth authorization-code flow.
 *
 * Holds the code_verifier and nonce keyed by the `state` parameter for the short window between a
 * flow's start and its callback/exchange (typically seconds, never more than the TTL).
 *
 * One store is shared by every OAuth flow in the process (app.ts builds it once), for two reasons:
 *
 *   1. **One registered redirect URI per provider.** Login, invitation activation and provider
 *      linking all send the browser back to the same `/api/auth/oauth/{provider}/callback`, which
 *      reads the entry and dispatches on its `flow`. Separate stores per route group would make the
 *      callback unable to see a state an activation or link start had minted.
 *   2. **Multiple API instances.** Production runs several API tasks behind a load balancer with no
 *      session affinity, so a flow's start and its callback land on different processes. The Redis
 *      store is what lets them meet; the in-memory store is only for a process with no Redis (bare
 *      tests, the OpenAPI generator, a single local process).
 *
 * Every entry records its `flow` and `provider`, and every consumer checks both: sharing the store
 * must not let a state minted for one flow (or provider) be redeemed by another.
 *
 * Entries are single-use: `take` reads and removes in one step (GETDEL on Redis), so a replayed
 * callback finds nothing even when two requests race.
 */

import type { RedisClient } from "../../../redis";

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SWEEP_INTERVAL = 10;

/** Key prefix for OAuth state entries on Redis DB 0 — see docs/runbooks/redis-conventions.md. */
export const OAUTH_STATE_KEY_PREFIX = "auth:oauth:state:";

export type OAuthStateProvider = "google" | "microsoft" | "mock";

/**
 * Which flow minted an authorization state — and therefore what the provider callback does with it.
 *
 * Every flow sends the browser to the provider with the server's own registered redirect URI, so
 * every flow returns through the provider's single callback, which dispatches on this:
 *   - `login`, `activation`, `link` — browser flows, finished in that browser tab.
 *   - `mobile-login`, `mobile-activation` — native-app flows. The callback verifies the identity
 *     and hands it to the app as a one-time {@link HandoffEntry} through the app's deep link; the
 *     app redeems it at its JSON `/mobile-exchange` endpoint.
 */
export type OAuthFlow = "login" | "activation" | "link" | "mobile-login" | "mobile-activation";

/** An authorization in flight: minted at a flow's start, consumed by the provider callback. */
export interface AuthorizationEntry {
  flow: OAuthFlow;
  provider: OAuthStateProvider;
  codeVerifier: string;
  nonce: string;
  /** `link` only: the user and school the provider is being linked to. */
  userId?: string;
  schoolId?: string;
  /** `activation` / `mobile-activation` only: the invitation bearer token this flow activates. */
  token?: string;
}

/**
 * A provider-verified identity waiting for the native app to redeem it, keyed by a one-time code
 * the callback hands the app through its deep link.
 *
 * The app must present the original `state` and `nonce` alongside the code. The nonce never
 * appears in the deep link, so another app that intercepts `studafy://auth/callback` holds the code
 * and state but cannot redeem them.
 */
export interface HandoffEntry {
  flow: "mobile-handoff";
  provider: OAuthStateProvider;
  /** Which mobile flow minted the authorization this handoff completes. */
  purpose: "login" | "activation";
  /** The authorization `state` this handoff answers, and the nonce it was minted with. */
  state: string;
  nonce: string;
  identity: { sub: string; email: string };
  /** `activation` only: the invitation bearer token. */
  token?: string;
}

export type StateEntry = AuthorizationEntry | HandoffEntry;
type StateFlow = StateEntry["flow"];

export interface StateStore {
  set(state: string, entry: StateEntry): Promise<void>;
  /** Read and remove an entry in one step. Undefined when missing, expired, or already taken. */
  take(state: string): Promise<StateEntry | undefined>;
}

/** Whether an entry is an authorization the provider callback may redeem (not a mobile handoff). */
export function isAuthorizationEntry(entry: StateEntry): entry is AuthorizationEntry {
  return entry.flow !== "mobile-handoff";
}

/** The native-app flows, whose callback ends in a handoff to the app rather than in the browser. */
export function isMobileFlow(flow: StateFlow): flow is "mobile-login" | "mobile-activation" {
  return flow === "mobile-login" || flow === "mobile-activation";
}

/**
 * Take an entry and return it only when it belongs to the expected flow and provider.
 *
 * A mismatched entry is still consumed: a state presented to the wrong endpoint is either forged
 * or misrouted, and leaving it redeemable elsewhere would serve neither case.
 */
export async function takeStateFor<F extends StateFlow>(
  store: StateStore,
  state: string,
  flow: F,
  provider: OAuthStateProvider,
): Promise<EntryFor<F> | undefined> {
  const entry = await store.take(state);
  if (!entry || entry.flow !== flow || entry.provider !== provider) return undefined;
  return entry as EntryFor<F>;
}

type EntryFor<F extends StateFlow> = F extends "mobile-handoff" ? HandoffEntry : AuthorizationEntry;

/** In-process store for a process with no Redis. Not shared across instances. */
export function createMemoryStateStore(ttlMs = DEFAULT_TTL_MS): StateStore {
  const map = new Map<string, { entry: StateEntry; createdAt: number }>();
  let callCount = 0;

  function sweep(): void {
    const now = Date.now();
    for (const [key, item] of map) {
      if (now - item.createdAt > ttlMs) map.delete(key);
    }
  }

  return {
    set(state, entry) {
      map.set(state, { entry, createdAt: Date.now() });
      return Promise.resolve();
    },

    take(state) {
      callCount += 1;
      if (callCount % SWEEP_INTERVAL === 0) sweep();

      const item = map.get(state);
      map.delete(state);
      if (!item || Date.now() - item.createdAt > ttlMs) return Promise.resolve(undefined);
      return Promise.resolve(item.entry);
    },
  };
}

/**
 * Redis-backed store shared by every API instance.
 *
 * Fails closed: a Redis error rejects, so a flow cannot start (or complete) without its state
 * being durably recorded and atomically consumed. The global error handler turns that into a 5xx.
 */
export function createRedisStateStore(redis: RedisClient, ttlMs = DEFAULT_TTL_MS): StateStore {
  return {
    async set(state, entry) {
      await redis.set(stateKey(state), JSON.stringify(entry), "PX", ttlMs);
    },

    async take(state) {
      const raw = await redis.getdel(stateKey(state));
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw) as StateEntry;
      } catch {
        return undefined;
      }
    },
  };
}

function stateKey(state: string): string {
  return `${OAUTH_STATE_KEY_PREFIX}${state}`;
}
