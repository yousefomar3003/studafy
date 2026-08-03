import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";

import { TokenVerificationError, verifyToken } from "./auth";
import { healthRoutes } from "./health";
import { clientMessageSchema } from "./protocol";
import { parseRoomKey, roomKey } from "./rooms";

import type { AuthClaims } from "./auth";
import type { ConnectionTracker } from "./lifecycle";
import type { FanoutMetrics } from "./metrics";
import type { ClientMessage, SystemMessage } from "./protocol";
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
 * auto-joins its home room (`school:{schoolId}:role:{role}`, derived from the token's claims).
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
        return c.json({ error: "missing token query parameter" }, 401);
      }
      try {
        c.set("claims", verifyToken(token, jwtSecret));
      } catch (error) {
        if (error instanceof TokenVerificationError) {
          return c.json({ error: error.message }, 401);
        }
        throw error;
      }
      await next();
    },
    upgradeWebSocket((c: Context<Bindings>) => {
      const claims = c.get("claims");
      const homeRoom = roomKey(claims.schoolId, claims.role);

      return {
        onOpen(_event, ws) {
          const socket = raw(ws);
          tracker.add(socket);
          rooms.join(homeRoom, socket);
          send(ws, { type: "system.joined", room: homeRoom });
        },
        onMessage(event, ws) {
          handleClientMessage(event.data, ws, claims, rooms);
        },
        onClose(_event, ws) {
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
