import { QueryClient } from "@tanstack/react-query";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, mock, test } from "bun:test";

import { RealtimeClient } from "./client";
import { REAUTH_REQUIRED_CLOSE_CODE } from "./protocol";

import type { RealtimeSocket } from "./client";

const OPEN_STATE = 1;

const ENVELOPE = (id: string, type: string) => ({
  id,
  type,
  room: "school:123:role:STUDENT",
  payload: {},
  publishedAt: "2026-07-09T12:00:00.000Z",
});

const EVENT_ID_A = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const EVENT_ID_B = "5f4f2a7c-9b3d-4e1a-8f2b-1c6d9e0a7b21";

/** Controllable {@link RealtimeSocket} for driving the client through open/message/close. */
class FakeSocket implements RealtimeSocket {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly openHandlers = new Set<() => void>();
  private readonly messageHandlers = new Set<(data: unknown) => void>();
  private readonly closeHandlers = new Set<(info: { code: number; reason: string }) => void>();
  private readonly errorHandlers = new Set<() => void>();

  onOpen(handler: () => void): () => void {
    this.openHandlers.add(handler);
    return () => this.openHandlers.delete(handler);
  }

  onMessage(handler: (data: unknown) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: (info: { code: number; reason: string }) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onError(handler: () => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  emitOpen(): void {
    this.readyState = OPEN_STATE;
    for (const handler of [...this.openHandlers]) {
      handler();
    }
  }

  emitMessage(data: unknown): void {
    for (const handler of [...this.messageHandlers]) {
      handler(data);
    }
  }

  emitClose(code: number, reason = ""): void {
    this.readyState = 3;
    for (const handler of [...this.closeHandlers]) {
      handler({ code, reason });
    }
  }
}

/** Injectable setTimeout/clearTimeout whose delay is advanced manually. */
function createFakeTimers() {
  let now = 0;
  let nextId = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: ((fn: () => void, delay: number) => {
      const id = ++nextId;
      queue.set(id, { at: now + delay, fn });
      return id;
    }) as typeof globalThis.setTimeout,
    clearTimeout: ((id: number) => {
      queue.delete(id);
    }) as typeof globalThis.clearTimeout,
    advance: (ms: number) => {
      now += ms;
      for (const [id, { at, fn }] of [...queue]) {
        if (at <= now) {
          queue.delete(id);
          fn();
        }
      }
    },
  };
}

function createHarness(options: {
  token: () => string | null;
  maxConnectFailures?: number;
  queryClient?: QueryClient;
  onAuthError?: (reason: string) => void;
}) {
  const timers = createFakeTimers();
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const queryClient =
    options.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateQueries = mock((_filters: { queryKey?: readonly unknown[] }) =>
    Promise.resolve(),
  );
  queryClient.invalidateQueries = invalidateQueries as QueryClient["invalidateQueries"];

  const client = new RealtimeClient({
    baseUrl: "ws://localhost:3001",
    getToken: options.token,
    queryClient,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    random: () => 0.5,
    backoff: { baseDelayMs: 1_000, maxDelayMs: 30_000, jitterRatio: 0.2 },
    maxConnectFailures: options.maxConnectFailures ?? 3,
    onAuthError: options.onAuthError,
    socketFactory: (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });

  return { client, timers, sockets, urls, queryClient, invalidateQueries };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("RealtimeClient", () => {
  test("connects with the token in the handshake URL and reports connected", async () => {
    const h = createHarness({ token: () => "jwt" });
    h.client.connect();
    await flush();

    expect(h.client.getStatus()).toBe("connecting");
    expect(h.urls).toEqual(["ws://localhost:3001/ws?token=jwt"]);

    h.sockets[0].emitOpen();
    expect(h.client.getStatus()).toBe("connected");
  });

  test("stays unauthorized without a token", async () => {
    const authErrors: string[] = [];
    const h = createHarness({
      token: () => null,
      onAuthError: (reason) => authErrors.push(reason),
    });
    h.client.connect();
    await flush();

    expect(h.client.getStatus()).toBe("unauthorized");
    expect(h.urls).toEqual([]);
    expect(authErrors).toEqual(["no realtime session token"]);
  });

  test("invalidates the mapped query keys for a live event, deduplicated by event id", async () => {
    const h = createHarness({ token: () => "jwt" });
    h.client.connect();
    await flush();
    h.sockets[0].emitOpen();
    expect(h.invalidateQueries).toHaveBeenCalledTimes(0);

    h.sockets[0].emitMessage(JSON.stringify(ENVELOPE(EVENT_ID_A, "grades.published")));
    expect(h.invalidateQueries.mock.calls).toEqual([
      [{ queryKey: ["approval-queue"] }],
      [{ queryKey: ["grades"] }],
    ]);

    h.sockets[0].emitMessage(JSON.stringify(ENVELOPE(EVENT_ID_A, "grades.published")));
    expect(h.invalidateQueries.mock.calls).toHaveLength(2);
  });

  test("ignores events with no mapping and system messages", async () => {
    const h = createHarness({ token: () => "jwt" });
    h.client.connect();
    await flush();
    h.sockets[0].emitOpen();

    h.sockets[0].emitMessage(JSON.stringify(ENVELOPE(EVENT_ID_B, "no.such.event")));
    h.sockets[0].emitMessage(JSON.stringify({ type: "system.error", message: "nope" }));
    h.sockets[0].emitMessage("not json");
    expect(h.invalidateQueries).toHaveBeenCalledTimes(0);
  });

  test("network drop: backs off with jitter, reconnects, re-joins rooms, and refetches", async () => {
    const h = createHarness({ token: () => "jwt" });
    h.client.connect();
    await flush();
    h.sockets[0].emitOpen();

    h.client.join("school:123:role:INSTRUCTOR");
    expect(JSON.parse(h.sockets[0].sent.at(-1) ?? "")).toEqual({
      type: "join",
      room: "school:123:role:INSTRUCTOR",
    });
    h.invalidateQueries.mockClear();

    h.sockets[0].emitClose(1006);
    expect(h.client.getStatus()).toBe("reconnecting");

    h.timers.advance(999);
    expect(h.sockets).toHaveLength(1);
    h.timers.advance(1);
    await flush();
    expect(h.client.getStatus()).toBe("connecting");
    expect(h.sockets).toHaveLength(2);

    h.sockets[1].emitOpen();
    expect(h.client.getStatus()).toBe("connected");

    // Resubscribed the extra room on the fresh socket.
    expect(JSON.parse(h.sockets[1].sent.at(-1) ?? "")).toEqual({
      type: "join",
      room: "school:123:role:INSTRUCTOR",
    });
    // Reconcile missed state via refetch: every mapped key was invalidated on reconnect.
    expect(h.invalidateQueries.mock.calls).toEqual([
      [{ queryKey: ["approval-queue"] }],
      [{ queryKey: ["grades"] }],
    ]);
  });

  test("reauth close (4401) fetches a fresh token and reconnects immediately", async () => {
    let tokenCalls = 0;
    const h = createHarness({ token: () => (++tokenCalls, "jwt") });
    h.client.connect();
    await flush();
    h.sockets[0].emitOpen();
    expect(tokenCalls).toBe(1);

    h.sockets[0].emitClose(REAUTH_REQUIRED_CLOSE_CODE);
    expect(h.client.getStatus()).toBe("reconnecting");

    h.timers.advance(0);
    await flush();
    expect(h.sockets).toHaveLength(2);
    expect(tokenCalls).toBe(2);
    expect(h.client.getStatus()).toBe("connecting");

    h.sockets[1].emitOpen();
    expect(h.client.getStatus()).toBe("connected");
  });

  test("gives up as unauthorized after repeated pre-open handshake failures", async () => {
    const h = createHarness({ token: () => "jwt", maxConnectFailures: 2 });
    h.client.connect();
    await flush();

    h.sockets[0].emitClose(1006);
    expect(h.client.getStatus()).toBe("reconnecting");
    h.timers.advance(1_000);
    await flush();
    expect(h.sockets).toHaveLength(2);

    h.sockets[1].emitClose(1006);
    expect(h.client.getStatus()).toBe("unauthorized");

    h.timers.advance(10_000);
    await flush();
    expect(h.sockets).toHaveLength(2);
  });

  test("reconnects indefinitely after a post-open drop", async () => {
    const h = createHarness({ token: () => "jwt", maxConnectFailures: 1 });
    h.client.connect();
    await flush();
    h.sockets[0].emitOpen();
    expect(h.client.getStatus()).toBe("connected");

    h.sockets[0].emitClose(1006);
    expect(h.client.getStatus()).toBe("reconnecting");
    h.timers.advance(1_000);
    await flush();
    expect(h.sockets).toHaveLength(2);
    expect(h.client.getStatus()).toBe("connecting");
  });

  test("disconnect stops retries and returns to idle", async () => {
    const h = createHarness({ token: () => "jwt" });
    h.client.connect();
    await flush();
    h.sockets[0].emitOpen();

    h.sockets[0].emitClose(1006);
    h.client.disconnect();
    expect(h.client.getStatus()).toBe("idle");

    h.timers.advance(60_000);
    await flush();
    expect(h.sockets).toHaveLength(1);
  });
});
