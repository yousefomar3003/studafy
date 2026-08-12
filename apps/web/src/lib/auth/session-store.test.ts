// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createSessionStore } from "./session-store";

import type {
  SessionRefreshClient,
  SessionStatus,
  SessionStore,
  SessionStoreOptions,
  SessionTokens,
} from "./session-store";

const ACCESS_TTL_MS = 10_000;
const MARGIN_MS = 1_000;

interface FakeClock {
  readonly time: number;
  setTimeout(cb: () => void, delay: number): ReturnType<typeof globalThis.setTimeout>;
  clearTimeout(id: ReturnType<typeof globalThis.setTimeout>): void;
  /** Advance the clock and fire every timer that is due. */
  advance(ms: number): void;
  /** Move the clock without firing timers — simulates a throttled background tab. */
  set(ms: number): void;
}

/** Minimal controllable scheduler replacing the platform timers. */
function createFakeClock(): FakeClock {
  let time = 0;
  let nextId = 1;
  const scheduled = new Map<number, { at: number; cb: () => void }>();

  const fireDue = (): void => {
    for (;;) {
      const due = [...scheduled.entries()]
        .filter(([, entry]) => entry.at <= time)
        .sort((a, b) => a[1].at - b[1].at)
        .map(([id]) => id);
      if (due.length === 0) {
        return;
      }
      for (const id of due) {
        const entry = scheduled.get(id);
        if (entry) {
          scheduled.delete(id);
          entry.cb();
        }
      }
    }
  };

  return {
    get time() {
      return time;
    },
    setTimeout(cb, delay) {
      const id = nextId++;
      scheduled.set(id, { at: time + delay, cb });
      return id as unknown as ReturnType<typeof globalThis.setTimeout>;
    },
    clearTimeout(id) {
      scheduled.delete(id as unknown as number);
    },
    advance(ms) {
      time += ms;
      fireDue();
    },
    set(ms) {
      time = ms;
    },
  };
}

interface Harness {
  store: SessionStore;
  client: {
    refreshCalls: number;
    logoutCalls: number;
    setRefresh(impl: () => Promise<SessionTokens>): void;
    setFailure(status: number): void;
    setLogoutFailure(): void;
  };
  clock: FakeClock;
}

function createHarness(ttlMs = ACCESS_TTL_MS): Harness {
  const clock = createFakeClock();
  let refreshCalls = 0;
  let logoutCalls = 0;
  let logoutFailure = false;
  let refreshImpl: () => Promise<SessionTokens> = async () => ({
    accessToken: `at-${refreshCalls}`,
    expiresAt: clock.time + ttlMs,
    sessionId: "session-1",
  });

  const refreshClient: SessionRefreshClient = {
    refresh: () => {
      refreshCalls += 1;
      return refreshImpl();
    },
    logout: async () => {
      logoutCalls += 1;
      if (logoutFailure) {
        throw { status: 500 };
      }
    },
  };

  const options: SessionStoreOptions = {
    refreshClient,
    now: () => clock.time,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    refreshMarginMs: MARGIN_MS,
  };

  const store = createSessionStore(options);

  return {
    store,
    client: {
      get refreshCalls() {
        return refreshCalls;
      },
      get logoutCalls() {
        return logoutCalls;
      },
      setRefresh(impl) {
        refreshImpl = impl;
      },
      setFailure(status) {
        refreshImpl = async () => {
          throw { status };
        };
      },
      setLogoutFailure() {
        logoutFailure = true;
      },
    },
    clock,
  };
}

const flushMicrotasks = () => Promise.resolve();

describe("createSessionStore", () => {
  test("starts in the restoring state until the first token demand", () => {
    const { store } = createHarness();
    expect(store.getStatus()).toBe("restoring");
  });

  test("restores to authenticated and serves the access token", async () => {
    const { store, client, clock } = createHarness();

    const status = await store.restore();

    expect(status).toBe("authenticated");
    expect(store.getStatus()).toBe("authenticated");
    expect(store.getSessionId()).toBe("session-1");
    expect(await store.getToken()).toBe("at-1");
    expect(client.refreshCalls).toBe(1);
    // No token was written anywhere outside memory: nothing else observable on the store.
    expect(clock.time).toBe(0);
  });

  test("a 400 refresh (no cookie) resolves to unauthenticated", async () => {
    const { store, client } = createHarness();
    client.setFailure(400);

    const status = await store.restore();

    expect(status).toBe("unauthenticated");
    expect(await store.getToken()).toBeNull();
  });

  test("a 401 refresh (dead credential) resolves to expired", async () => {
    const { store, client } = createHarness();
    client.setFailure(401);

    const status = await store.restore();

    expect(status).toBe("expired");
    expect(await store.getToken()).toBeNull();
  });

  test("getToken lazily restores on first demand without an explicit restore", async () => {
    const { store, client } = createHarness();

    const token = await store.getToken();

    expect(token).toBe("at-1");
    expect(client.refreshCalls).toBe(1);
    expect(store.getStatus()).toBe("authenticated");
  });

  test("returns null once unauthenticated, without further refresh attempts", async () => {
    const { store, client } = createHarness();
    client.setFailure(400);
    await store.restore();

    expect(await store.getToken()).toBeNull();
    expect(client.refreshCalls).toBe(1);
  });

  test("concurrent callers share a single rotation", async () => {
    const { store, client } = createHarness();

    const [a, b, c] = await Promise.all([store.restore(), store.restore(), store.getToken()]);

    expect([a, b, c]).toEqual(["authenticated", "authenticated", "at-1"]);
    expect(client.refreshCalls).toBe(1);
  });

  test("the proactive timer rotates before expiry, without any request", async () => {
    const { store, client, clock } = createHarness();
    await store.restore();

    // Timer is armed for expiresAt - margin (9_000); cross it.
    clock.advance(ACCESS_TTL_MS - MARGIN_MS + 1);
    await flushMicrotasks();

    expect(client.refreshCalls).toBe(2);
    expect(store.getStatus()).toBe("authenticated");
  });

  test("getToken rotates a stale token when the proactive timer never fired (background tab)", async () => {
    const { store, client, clock } = createHarness();
    await store.restore();

    // Jump past the timer boundary and even past expiry without firing timers.
    clock.set(ACCESS_TTL_MS + 500);

    const token = await store.getToken();

    expect(token).toBe("at-2");
    expect(client.refreshCalls).toBe(2);
    expect(store.getStatus()).toBe("authenticated");
  });

  test("a transient refresh failure keeps a still-valid token and retries on the next demand", async () => {
    const { store, client, clock } = createHarness();
    await store.restore();

    // Within the margin (timer throttled), the next rotation fails transiently.
    clock.set(ACCESS_TTL_MS - MARGIN_MS + 100);
    client.setFailure(503);

    // The old token is still served and the failing rotation settles without losing it.
    expect(await store.getToken()).toBe("at-1");
    await flushMicrotasks();
    expect(store.getStatus()).toBe("authenticated");

    // Recovery: the next demand rotates and a later call serves the fresh token.
    client.setRefresh(async () => ({
      accessToken: "at-recovered",
      expiresAt: clock.time + ACCESS_TTL_MS,
      sessionId: "session-1",
    }));
    expect(await store.getToken()).toBe("at-1");
    await flushMicrotasks();
    expect(await store.getToken()).toBe("at-recovered");
    expect(client.refreshCalls).toBe(3);
  });

  test("a transient failure with nothing held drops to unauthenticated", async () => {
    const { store, client } = createHarness();
    client.setFailure(503);

    const status = await store.restore();

    expect(status).toBe("unauthenticated");
    expect(await store.getToken()).toBeNull();
  });

  test("restore can recover a previously unauthenticated session", async () => {
    const { store, client } = createHarness();
    client.setFailure(400);
    await store.restore();
    expect(store.getStatus()).toBe("unauthenticated");

    // The cookie appeared (or the network recovered): a fresh rotation succeeds.
    client.setRefresh(async () => ({
      accessToken: "at-2",
      expiresAt: 0,
      sessionId: "session-1",
    }));
    const status = await store.restore();

    expect(status).toBe("authenticated");
  });

  test("logout ends the session and clears the in-memory token", async () => {
    const { store, client } = createHarness();
    await store.restore();
    expect(store.getStatus()).toBe("authenticated");

    await store.logout();

    expect(client.logoutCalls).toBe(1);
    expect(store.getStatus()).toBe("unauthenticated");
    expect(await store.getToken()).toBeNull();
    expect(store.getSessionId()).toBeNull();
  });

  test("logout clears local state even when the server call fails", async () => {
    const { store, client } = createHarness();
    await store.restore();

    client.setLogoutFailure();
    await expect(store.logout()).rejects.toThrow();

    expect(store.getStatus()).toBe("unauthenticated");
    expect(await store.getToken()).toBeNull();
  });

  test("subscribe notifies listeners on status transitions only", async () => {
    const { store } = createHarness();
    const seen: SessionStatus[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.getStatus()));

    await store.restore();
    await store.logout();

    unsubscribe();
    expect(seen).toContain("authenticated");
    expect(seen).toContain("unauthenticated");
  });
});
