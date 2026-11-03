import {
  captureError,
  createRedMetricsMiddleware,
  createTracingMiddleware,
  resolveRoute,
} from "@studafy/observability";
import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import { HTTPException } from "hono/http-exception";

import { TokenVerificationError, verifyToken } from "./auth";
import { healthRoutes } from "./health";
import {
  createTokenBucket,
  DEFAULT_LIMITS,
  isOriginAllowed,
  MAX_PAYLOAD_BYTES,
  RATE_LIMITED_CLOSE_CODE,
} from "./limits";
import { clientMessageSchema, REAUTH_REQUIRED_CLOSE_CODE } from "./protocol";
import { authorizeRoom } from "./room-policy";
import { roleRoomKey, schoolRoomKey, userRoomKey } from "./rooms";
import { createSessionRegistry } from "./session-guard";

import type { AuthClaims } from "./auth";
import type { ConnectionTracker } from "./lifecycle";
import type { RealtimeLimits, TokenBucket } from "./limits";
import type { FanoutMetrics } from "./metrics";
import type { ClientMessage, RoomKey, SystemMessage } from "./protocol";
import type { RoomManager } from "./rooms";
import type { SessionGuard, SessionRegistry } from "./session-guard";
import type { CaptureContext } from "@studafy/observability";
import type { Context } from "hono";
import type { WSContext } from "hono/ws";

interface Bindings {
  Variables: { claims: AuthClaims };
}

/**
 * The client reference rooms/tracker key connections by. Hono's Bun adapter builds a fresh
 * `WSContext` wrapper on every event (open/message/close), so `WSContext` itself is unusable as a
 * Map/Set key across a connection's lifetime — only `WSContext.raw` (the underlying Bun socket) is
 * stable. See node_modules/hono/dist/adapter/bun/websocket.js: `createWSContext(ws)` is called
 * fresh per event but always wraps the same `ws`.
 */
export interface RawSocket {
  send(data: string, compress?: boolean): void;
  close(code?: number, reason?: string): void;
}

/**
 * Bun's WebSocket handler for `Bun.serve`: Hono's, plus the frame-size cap (F-16). Bun closes a
 * socket that sends a bigger frame with 1009 before any handler sees it. Production and the tests
 * must both serve this, not Hono's bare `websocket`, or the cap goes untested.
 */
export const realtimeWebSocket = { ...websocket, maxPayloadLength: MAX_PAYLOAD_BYTES };

function raw(ws: WSContext): RawSocket {
  return ws.raw as RawSocket;
}

function send(ws: WSContext, message: SystemMessage): void {
  ws.send(JSON.stringify(message));
}

/**
 * Tells the client to re-authenticate and closes the socket with 4401 (docs/protocol.md#re-auth-protocol).
 * The client mints a fresh ticket and reconnects; if its session is gone, minting fails and it stops.
 */
function closeForReauth(ws: WSContext, reason: string): void {
  send(ws, { type: "system.reauth_required", reason });
  raw(ws).close(REAUTH_REQUIRED_CLOSE_CODE, reason);
}

/**
 * Re-auth protocol: the ticket proves the session was valid *at handshake time*, and lives only
 * seconds. The socket must not outlive the session it was opened for, so a timer closes it when the
 * session's access token expires (`sessionExp`). Revocation before then is the sweep's job
 * (src/session-guard.ts).
 */
function scheduleReauth(claims: AuthClaims, ws: WSContext): ReturnType<typeof setTimeout> {
  const msUntilExpiry = Math.max(0, claims.sessionExp * 1000 - Date.now());
  return setTimeout(() => closeForReauth(ws, "session expired"), msUntilExpiry);
}

export interface AppOptions {
  isReady: () => boolean;
  /** `WS_JWT_SECRET`: the key the API signs handshake tickets with. */
  jwtSecret: string;
  /** Spends tickets and checks revocation at handshake; see src/session-guard.ts. */
  sessionGuard: SessionGuard;
  /**
   * Open sockets by session, for the revocation sweep (src/session-guard.ts). index.ts passes the
   * one it sweeps; tests pass one to sweep directly.
   */
  sessions?: SessionRegistry<RawSocket>;
  rooms: RoomManager<RawSocket>;
  tracker: ConnectionTracker<RawSocket>;
  metrics: () => FanoutMetrics;
  /**
   * Browser origins allowed to open a socket; see src/limits.ts's isOriginAllowed. Empty turns the
   * check off (development only — env.ts requires a list in production).
   */
  allowedOrigins?: readonly string[];
  /** Overrides for {@link DEFAULT_LIMITS}; tests lower them to exercise each limit. */
  limits?: Partial<RealtimeLimits>;
  /**
   * Error monitoring seam. Injected by tests; defaults to @studafy/observability's captureError,
   * itself a no-op unless SENTRY_DSN is configured.
   */
  reportError?: (error: unknown, context: CaptureContext) => void;
}

type WsEvent = "open" | "message" | "close";

/**
 * Runs one WebSocket event handler, reporting anything it throws — tagged with the event and the
 * connection's tenant and user ids, never its token or message payload — and then rethrowing, so
 * the socket fails exactly as it did before monitoring existed. Exported for app.monitoring.test.ts:
 * a throw out of a live Bun WebSocket handler is an uncaught error by design, so the wrapper is
 * tested directly rather than through a real socket.
 */
export function monitored(
  reportError: NonNullable<AppOptions["reportError"]>,
  event: WsEvent,
  claims: AuthClaims,
  handler: () => void,
): void {
  try {
    handler();
  } catch (error) {
    reportError(error, {
      tags: { ws_event: event, school_id: claims.schoolId },
      userId: claims.userId,
    });
    throw error;
  }
}

/**
 * Builds the Hono application: health routes plus the `/ws` handshake. The handshake is plain
 * Hono middleware (`GET /ws?ticket=...`) that verifies the API-minted ticket, spends it, and checks
 * its session is not revoked, all *before* upgrading, so a bad ticket never reaches the WebSocket
 * layer. On success the connection auto-joins its home rooms, all derived from the ticket's claims:
 * the school-wide room (`school:{schoolId}`), one role room per role
 * (`school:{schoolId}:role:{role}`), and its user room (`school:{schoolId}:user:{userId}`). The
 * socket closes with 4401 when the session expires (`scheduleReauth`) or is revoked (the sweep).
 */
export function createApp({
  isReady,
  jwtSecret,
  sessionGuard,
  sessions = createSessionRegistry<RawSocket>(),
  rooms,
  tracker,
  metrics,
  allowedOrigins = [],
  limits: limitOverrides,
  reportError = captureError,
}: AppOptions): Hono<Bindings> {
  const app = new Hono<Bindings>();
  const limits: RealtimeLimits = { ...DEFAULT_LIMITS, ...limitOverrides };

  // Hono's own default handler, plus a report: an unexpected throw from the handshake or a health
  // route is a 500 nobody would otherwise hear about. HTTPExceptions keep their own response and
  // are not reported — this app only raises them for client errors.
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return error.getResponse();
    }
    reportError(error, { tags: { route: resolveRoute(c) } });
    console.error(error);
    return c.text("Internal Server Error", 500);
  });

  // Distributed tracing (ST-260): one SERVER span per HTTP request (the /ws handshake and health
  // routes — the upgraded WebSocket connection itself, once established, is out of scope for this
  // span-per-request model). Before RED metrics, same ordering as apps/api.
  app.use("*", createTracingMiddleware());

  // RED metrics (ST-259): Rate/Errors/Duration for the /ws handshake and health routes, on
  // @studafy/observability's own Prometheus port — never this app's own PORT. Distinct from
  // `metrics` (src/metrics.ts, mounted below via healthRoutes) — the existing JSON fan-out
  // counter debug endpoint, unchanged.
  app.use("*", createRedMetricsMiddleware());

  app.route("/", healthRoutes(isReady, metrics));

  app.get(
    "/ws",
    async (c, next) => {
      // Before the token: a page on another site must not be able to open a socket at all, even
      // with a token it somehow holds (cross-site WebSocket hijacking).
      if (!isOriginAllowed(c.req.header("origin"), allowedOrigins)) {
        return c.json({ error: "origin not allowed", code: "ORIGIN_NOT_ALLOWED" }, 403);
      }
      // The ticket is a credential for its few seconds of life: it is never logged, and no error
      // below echoes it.
      const ticket = c.req.query("ticket");
      if (!ticket) {
        return c.json({ error: "missing ticket query parameter", code: "TOKEN_MISSING" }, 401);
      }
      let claims: AuthClaims;
      try {
        claims = verifyToken(ticket, jwtSecret);
      } catch (error) {
        if (error instanceof TokenVerificationError) {
          return c.json({ error: error.message, code: error.code }, 401);
        }
        throw error;
      }
      let admission: Awaited<ReturnType<SessionGuard["admit"]>>;
      try {
        admission = await sessionGuard.admit(claims);
      } catch (error) {
        // Fail closed, as the API's denylist does: an unchecked ticket would be replayable.
        reportError(error, { tags: { route: "/ws", stage: "session_guard" } });
        return c.json({ error: "session check unavailable", code: "UNAVAILABLE" }, 503);
      }
      if (admission === "replayed") {
        return c.json({ error: "ticket already used", code: "TOKEN_INVALID" }, 401);
      }
      if (admission === "revoked") {
        return c.json({ error: "session revoked", code: "TOKEN_INVALID" }, 401);
      }
      c.set("claims", claims);
      await next();
    },
    upgradeWebSocket((c: Context<Bindings>) => {
      const claims = c.get("claims");
      const homeRooms: readonly RoomKey[] = [
        schoolRoomKey(claims.schoolId),
        ...claims.roles.map((role) => roleRoomKey(claims.schoolId, role)),
        userRoomKey(claims.schoolId, claims.userId),
      ];
      let reauthTimer: ReturnType<typeof setTimeout> | undefined;
      const controlFrames = createTokenBucket(limits.controlBurst, limits.controlRefillPerSecond);

      return {
        onOpen(_event, ws) {
          monitored(reportError, "open", claims, () => {
            const socket = raw(ws);
            tracker.add(socket);
            for (const room of homeRooms) {
              rooms.join(room, socket);
              send(ws, { type: "system.joined", room });
            }
            let closed = false;
            sessions.add(socket, {
              sessionId: claims.sessionId,
              close: (reason) => {
                if (closed) return;
                closed = true;
                closeForReauth(ws, reason);
              },
            });
            reauthTimer = scheduleReauth(claims, ws);
          });
        },
        onMessage(event, ws) {
          monitored(reportError, "message", claims, () => {
            handleClientMessage(event.data, ws, { claims, rooms, limits, controlFrames });
          });
        },
        onClose(_event, ws) {
          monitored(reportError, "close", claims, () => {
            clearTimeout(reauthTimer);
            const socket = raw(ws);
            tracker.remove(socket);
            sessions.remove(socket);
            rooms.leaveAll(socket);
          });
        },
      };
    }),
  );

  return app;
}

interface MessageContext {
  claims: AuthClaims;
  rooms: RoomManager<RawSocket>;
  limits: RealtimeLimits;
  controlFrames: TokenBucket;
}

/**
 * Handles one client frame. Every frame — valid or not — spends a control-frame token first, so a
 * flood of garbage is limited exactly like a flood of joins; an empty bucket closes the socket.
 * A join/leave must then pass the room policy (src/room-policy.ts), and a join must fit under the
 * per-socket room cap.
 */
function handleClientMessage(
  data: unknown,
  ws: WSContext,
  { claims, rooms, limits, controlFrames }: MessageContext,
): void {
  if (!controlFrames.take()) {
    send(ws, { type: "system.error", message: "rate limit exceeded" });
    raw(ws).close(RATE_LIMITED_CLOSE_CODE, "rate limit exceeded");
    return;
  }

  if (typeof data !== "string") {
    send(ws, { type: "system.error", message: "binary frames are not supported" });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    send(ws, { type: "system.error", message: "message must be valid JSON" });
    return;
  }

  const result = clientMessageSchema.safeParse(parsed);
  if (!result.success) {
    send(ws, { type: "system.error", message: result.error.message });
    return;
  }

  const message: ClientMessage = result.data;
  const decision = authorizeRoom(message.room, claims);
  if (!decision.allowed) {
    send(ws, { type: "system.error", message: decision.reason });
    return;
  }

  const socket = raw(ws);
  if (message.type === "join") {
    const joined = rooms.roomsOf(socket);
    if (!joined.has(message.room) && joined.size >= limits.maxRoomsPerSocket) {
      send(ws, { type: "system.error", message: "room limit reached" });
      return;
    }
    rooms.join(message.room, socket);
    send(ws, { type: "system.joined", room: message.room });
  } else {
    rooms.leave(message.room, socket);
    send(ws, { type: "system.left", room: message.room });
  }
}
