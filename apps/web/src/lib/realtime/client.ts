import { computeBackoffDelay } from "./backoff";
import { allInvalidationKeys, invalidationKeysFor } from "./invalidations";
import { isSystemMessage, parseIncomingMessage, REAUTH_REQUIRED_CLOSE_CODE } from "./protocol";

import type { ClientMessage, EventEnvelope, RoomKey } from "./protocol";
import type { QueryClient } from "@tanstack/react-query";

/**
 * Connection state surfaced to the UI.
 * - `idle` — never started, or intentionally disconnected.
 * - `connecting` — handshake in progress.
 * - `connected` — socket open and joined to the home rooms.
 * - `reconnecting` — socket down; waiting out a jittered backoff before retrying.
 * - `unauthorized` — no session token, or the handshake was rejected; not retrying.
 */
export type RealtimeConnectionStatus =
  "idle" | "connecting" | "connected" | "reconnecting" | "unauthorized";

/**
 * Minimal socket surface the client talks to. The default implementation wraps the browser
 * `WebSocket`; tests inject a fake so reconnect behavior can be driven without a live server.
 * Each `on*` returns an unsubscribe.
 */
export interface RealtimeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onOpen(handler: () => void): () => void;
  onMessage(handler: (data: unknown) => void): () => void;
  onClose(handler: (info: { code: number; reason: string }) => void): () => void;
  onError(handler: () => void): () => void;
}

export interface RealtimeClientOptions {
  /** Gateway origin, e.g. `ws://localhost:3001` (the `/ws?token=` path is appended). */
  readonly baseUrl: string;
  /** Resolves the handshake token on every connect attempt, and again on a re-auth close. */
  readonly getToken: () => string | null | undefined | Promise<string | null | undefined>;
  /** The app's TanStack Query client — receives the invalidations. */
  readonly queryClient: QueryClient;
  /** Called when the connection gives up on authentication (no token, or rejected handshake). */
  readonly onAuthError?: (reason: string) => void;
  /** Test seam — the socket factory defaults to a browser `WebSocket` wrapper. */
  readonly socketFactory?: (url: string) => RealtimeSocket;
  /** Test seams for deterministic reconnect scheduling. */
  readonly setTimeoutFn?: typeof globalThis.setTimeout;
  readonly clearTimeoutFn?: typeof globalThis.clearTimeout;
  readonly random?: () => number;
  readonly backoff?: { baseDelayMs: number; maxDelayMs: number; jitterRatio: number };
  /**
   * Consecutive handshake failures (before the socket has ever opened) after which the client
   * stops retrying and reports `unauthorized`. The browser WebSocket API does not expose a
   * rejected handshake's HTTP status/body, so a pre-open close can be a refused token or a dead
   * network; capping retries prevents a permanently-rejected token from hammering the gateway
   * forever. Resets on any successful open, and the `online` event (or an explicit `connect`)
   * resumes attempts.
   */
  readonly maxConnectFailures?: number;
}

const OPEN_STATE = 1;
const DEFAULT_BACKOFF = { baseDelayMs: 1_000, maxDelayMs: 30_000, jitterRatio: 0.2 };
const DEFAULT_MAX_CONNECT_FAILURES = 3;
const MAX_SEEN_EVENT_IDS = 128;

function createWebSocketSocket(url: string): RealtimeSocket {
  const socket = new WebSocket(url);
  return {
    readyState: socket.readyState,
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onOpen: (handler) => {
      const listener = () => handler();
      socket.addEventListener("open", listener);
      return () => socket.removeEventListener("open", listener);
    },
    onMessage: (handler) => {
      const listener = (event: MessageEvent) => handler(event.data);
      socket.addEventListener("message", listener);
      return () => socket.removeEventListener("message", listener);
    },
    onClose: (handler) => {
      const listener = (event: CloseEvent) => handler({ code: event.code, reason: event.reason });
      socket.addEventListener("close", listener);
      return () => socket.removeEventListener("close", listener);
    },
    onError: (handler) => {
      const listener = () => handler();
      socket.addEventListener("error", listener);
      return () => socket.removeEventListener("error", listener);
    },
  };
}

function buildSocketUrl(baseUrl: string, token: string): string {
  const normalized = baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const url = new URL("/ws", normalized);
  url.searchParams.set("token", token);
  return url.toString();
}

/**
 * The app-wide realtime socket client: a single connection to the gateway that authenticates with
 * the token seam, rejoins subscribed rooms and invalidates TanStack Query state after every
 * reconnect (reconciling what was missed while the socket was down), and applies the event ->
 * query invalidation map to live events. Framework-agnostic — the React wiring lives in
 * `connection.tsx`.
 */
export class RealtimeClient {
  private readonly options: RealtimeClientOptions;
  private readonly setTimer: typeof globalThis.setTimeout;
  private readonly clearTimer: typeof globalThis.clearTimeout;
  private readonly random: () => number;
  private readonly backoffOptions;
  private readonly maxConnectFailures: number;

  private status: RealtimeConnectionStatus = "idle";
  private readonly listeners = new Set<() => void>();

  private started = false;
  private generation = 0;
  private socket: RealtimeSocket | null = null;
  private disposeSocket: (() => void)[] = [];
  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private connectAttempt = 0;
  private consecutiveFailures = 0;
  private everConnected = false;
  private readonly joinedRooms = new Set<string>();
  private readonly seenEventIds: string[] = [];

  constructor(options: RealtimeClientOptions) {
    this.options = options;
    this.setTimer = options.setTimeoutFn ?? globalThis.setTimeout;
    this.clearTimer = options.clearTimeoutFn ?? globalThis.clearTimeout;
    this.random = options.random ?? Math.random;
    this.backoffOptions = options.backoff ?? DEFAULT_BACKOFF;
    this.maxConnectFailures = options.maxConnectFailures ?? DEFAULT_MAX_CONNECT_FAILURES;
    globalThis.addEventListener("online", this.handleOnline);
  }

  /** Opens the connection (idempotent). */
  connect(): void {
    if (!this.started) {
      this.started = true;
      this.connectAttempt = 0;
    }
    void this.attemptConnect();
  }

  /** Closes the connection and stops retrying. */
  disconnect(): void {
    this.started = false;
    this.generation += 1;
    this.cancelReconnectTimer();
    this.teardownSocket();
    this.setStatus("idle");
  }

  /** Subscribes to an additional room (within the caller's own school — the gateway enforces it). */
  join(room: RoomKey): void {
    if (!this.joinedRooms.has(room)) {
      this.joinedRooms.add(room);
      this.sendClientMessage({ type: "join", room });
    }
  }

  /** Leaves a room joined via {@link join}. Home rooms are the gateway's to manage. */
  leave(room: RoomKey): void {
    if (this.joinedRooms.delete(room)) {
      this.sendClientMessage({ type: "leave", room });
    }
  }

  getStatus(): RealtimeConnectionStatus {
    return this.status;
  }

  /** Subscribes to status changes. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async attemptConnect(): Promise<void> {
    if (!this.started || this.status === "connecting" || this.status === "connected") {
      return;
    }
    this.cancelReconnectTimer();
    this.setStatus("connecting");

    const generation = this.generation;
    const token = await this.options.getToken();
    if (!this.started || generation !== this.generation) {
      return;
    }
    if (!token) {
      this.setStatus("unauthorized");
      this.options.onAuthError?.("no realtime session token");
      return;
    }
    this.openSocket(buildSocketUrl(this.options.baseUrl, token));
  }

  private openSocket(url: string): void {
    const socket = (this.options.socketFactory ?? createWebSocketSocket)(url);
    this.socket = socket;
    this.disposeSocket = [
      socket.onOpen(() => this.handleOpen()),
      socket.onMessage((data) => this.handleMessage(data)),
      socket.onClose(({ code }) => this.handleClose(code)),
      socket.onError(() => {
        // The browser follows an `error` with a `close`; the close handler owns the recovery.
      }),
    ];
  }

  private handleOpen(): void {
    this.consecutiveFailures = 0;
    const wasReconnect = this.everConnected;
    this.everConnected = true;
    this.setStatus("connected");
    this.resubscribeRooms();
    if (wasReconnect) {
      this.invalidateAllMapped();
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") {
      return;
    }
    const message = parseIncomingMessage(data);
    if (!message) {
      console.warn("[realtime] dropped malformed frame", data);
      return;
    }
    if (isSystemMessage(message)) {
      if (message.type === "system.error") {
        console.warn("[realtime] gateway error:", message.message);
      } else if (message.type === "system.left") {
        this.joinedRooms.delete(message.room);
      }
      return;
    }
    this.applyEvent(message);
  }

  private handleClose(code: number): void {
    this.teardownSocket();
    if (!this.started) {
      this.setStatus("idle");
      return;
    }

    if (code === REAUTH_REQUIRED_CLOSE_CODE) {
      // Token expired mid-connection: fetch a fresh token and reconnect right away.
      this.setStatus("reconnecting");
      this.scheduleReconnect(0);
      return;
    }

    this.setStatus("reconnecting");
    if (this.everConnected) {
      this.scheduleReconnect(this.backoffDelay(this.connectAttempt++));
      return;
    }

    // Never opened: a pre-open close is either a refused token or a dead network (the browser
    // WebSocket API hides the 401 body). Retry with backoff, but give up after a bounded number
    // of consecutive failures so a rejected token doesn't hammer the gateway forever.
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.maxConnectFailures) {
      this.setStatus("unauthorized");
      this.options.onAuthError?.(`realtime handshake rejected ${this.consecutiveFailures} times`);
      return;
    }
    this.scheduleReconnect(this.backoffDelay(this.connectAttempt++));
  }

  private applyEvent(envelope: EventEnvelope): void {
    if (this.seenEventIds.includes(envelope.id)) {
      return;
    }
    this.seenEventIds.push(envelope.id);
    if (this.seenEventIds.length > MAX_SEEN_EVENT_IDS) {
      this.seenEventIds.shift();
    }
    for (const queryKey of invalidationKeysFor(envelope.type)) {
      void this.options.queryClient.invalidateQueries({ queryKey });
    }
  }

  private invalidateAllMapped(): void {
    for (const queryKey of allInvalidationKeys()) {
      void this.options.queryClient.invalidateQueries({ queryKey });
    }
  }

  private resubscribeRooms(): void {
    for (const room of this.joinedRooms) {
      this.sendClientMessage({ type: "join", room });
    }
  }

  private sendClientMessage(message: ClientMessage): void {
    if (this.socket?.readyState === OPEN_STATE) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private scheduleReconnect(delayMs: number): void {
    if (!this.started) {
      return;
    }
    this.cancelReconnectTimer();
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      void this.attemptConnect();
    }, delayMs);
  }

  private cancelReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private teardownSocket(): void {
    if (this.socket) {
      this.socket.close();
    }
    for (const dispose of this.disposeSocket) {
      dispose();
    }
    this.disposeSocket = [];
    this.socket = null;
  }

  private backoffDelay(attempt: number): number {
    return computeBackoffDelay(attempt, { ...this.backoffOptions, random: this.random });
  }

  private setStatus(status: RealtimeConnectionStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  private handleOnline = (): void => {
    if (this.started) {
      void this.attemptConnect();
    }
  };
}
