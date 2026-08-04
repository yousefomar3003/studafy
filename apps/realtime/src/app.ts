import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";

import { TokenVerificationError, verifyToken } from "./auth";
import { healthRoutes } from "./health";
import { clientMessageSchema, REAUTH_REQUIRED_CLOSE_CODE } from "./protocol";
import { parseRoomKey, roleRoomKey, schoolRoomKey, userRoomKey } from "./rooms";

import type { AuthClaims } from "./auth";
import type { ConnectionTracker } from "./lifecycle";
import type { FanoutMetrics } from "./metrics";
import type { ClientMessage, RoomKey, SystemMessage } from "./protocol";
import type { RoomManager } from "./rooms";
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

function raw(ws: WSContext): RawSocket {
  return ws.raw as RawSocket;
}

function send(ws: WSContext, message: SystemMessage): void {
  ws.send(JSON.stringify(message));
}

/**
 * Re-auth protocol: `verifyToken` only proves the token was valid *at handshake time*. Without
 * this, a socket that connected with a token carrying an `exp` would stay a member of its rooms
 * indefinitely after that `exp` passes, since nothing re-checks it. If the claims carry an `exp`,
 * schedule a timer for exactly that instant that warns the client (`system.reauth_required`) and
 * closes the socket (see docs/protocol.md#re-auth-protocol) so it must reconnect with a fresh
 * token rather than staying authorized past its stated expiry. Tokens without `exp` never expire,
 * so there is nothing to schedule.
 */
function scheduleReauth(
  claims: AuthClaims,
  ws: WSContext,
): ReturnType<typeof setTimeout> | undefined {
  if (claims.exp === undefined) {
    return undefined;
  }
  const msUntilExpiry = Math.max(0, claims.exp * 1000 - Date.now());
  return setTimeout(() => {
    send(ws, { type: "system.reauth_required", reason: "token expired" });
    raw(ws).close(REAUTH_REQUIRED_CLOSE_CODE, "token expired");
  }, msUntilExpiry);
}

export interface AppOptions {
  isReady: () => boolean;
  jwtSecret: string;
  rooms: RoomManager<RawSocket>;
  tracker: ConnectionTracker<RawSocket>;
  metrics: () => FanoutMetrics;
}

/**
 * Builds the Hono application: health routes plus the `/ws` handshake. The handshake is plain
 * Hono middleware (`GET /ws?token=...`) that verifies the JWT stub and rejects with 401 *before*
 * upgrading — an invalid token never reaches the WebSocket layer. On a valid token the connection
 * auto-joins its three home rooms, all derived from the token's claims: the school-wide room
 * (`school:{schoolId}`), its role room (`school:{schoolId}:role:{role}`), and its user room
 * (`school:{schoolId}:user:{userId}`). A token carrying `exp` also gets a re-auth timer (see
 * `scheduleReauth`) so authorization doesn't silently outlive what the token actually granted.
 */
export function createApp({
  isReady,
  jwtSecret,
  rooms,
  tracker,
  metrics,
}: AppOptions): Hono<Bindings> {
  const app = new Hono<Bindings>();

  app.route("/", healthRoutes(isReady, metrics));

  app.get(
    "/ws",
    async (c, next) => {
      const token = c.req.query("token");
      if (!token) {
        return c.json({ error: "missing token query parameter", code: "TOKEN_MISSING" }, 401);
      }
      try {
        c.set("claims", verifyToken(token, jwtSecret));
      } catch (error) {
        if (error instanceof TokenVerificationError) {
          return c.json({ error: error.message, code: error.code }, 401);
        }
        throw error;
      }
      await next();
    },
    upgradeWebSocket((c: Context<Bindings>) => {
      const claims = c.get("claims");
      const homeRooms: readonly RoomKey[] = [
        schoolRoomKey(claims.schoolId),
        roleRoomKey(claims.schoolId, claims.role),
        userRoomKey(claims.schoolId, claims.userId),
      ];
      let reauthTimer: ReturnType<typeof setTimeout> | undefined;

      return {
        onOpen(_event, ws) {
          const socket = raw(ws);
          tracker.add(socket);
          for (const room of homeRooms) {
            rooms.join(room, socket);
            send(ws, { type: "system.joined", room });
          }
          reauthTimer = scheduleReauth(claims, ws);
        },
        onMessage(event, ws) {
          handleClientMessage(event.data, ws, claims, rooms);
        },
        onClose(_event, ws) {
          clearTimeout(reauthTimer);
          const socket = raw(ws);
          tracker.remove(socket);
          rooms.leaveAll(socket);
        },
      };
    }),
  );

  return app;
}

/** Handles a `ClientMessage` frame: join/leave, restricted to rooms in the caller's own school. */
function handleClientMessage(
  data: unknown,
  ws: WSContext,
  claims: AuthClaims,
  rooms: RoomManager<RawSocket>,
): void {
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
  if (parseRoomKey(message.room).schoolId !== claims.schoolId) {
    send(ws, { type: "system.error", message: "cannot join a room outside your own school" });
    return;
  }

  const socket = raw(ws);
  if (message.type === "join") {
    rooms.join(message.room, socket);
    send(ws, { type: "system.joined", room: message.room });
  } else {
    rooms.leave(message.room, socket);
    send(ws, { type: "system.left", room: message.room });
  }
}
