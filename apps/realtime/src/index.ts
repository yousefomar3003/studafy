import { websocket } from "hono/bun";

import { createApp } from "./app";
import { createRedisSubscriber } from "./connection";
import { loadEnv } from "./env";
import { createConnectionTracker, gracefulShutdown } from "./lifecycle";
import { snapshot } from "./metrics";
import { subscribeToOutboxEvents } from "./outbox-fanout";
import { createRoomManager } from "./rooms";
import { subscribeToRooms } from "./subscriber";

import type { RawSocket } from "./app";
import type { EventEnvelope } from "./protocol";
import type { RoomManager } from "./rooms";

// Fail fast: an invalid environment throws EnvValidationError here, before the server binds a
// port or opens a Redis connection.
const env = loadEnv();

const rooms: RoomManager<RawSocket> = createRoomManager();
const tracker = createConnectionTracker<RawSocket>();

function broadcast(envelope: EventEnvelope): void {
  const message = JSON.stringify(envelope);
  for (const member of rooms.members(envelope.room)) {
    member.send(message);
  }
}

// Two dedicated connections, not one shared: a subscribed ioredis client can only run pub/sub
// commands, and separating them means subscribeToRooms's `school:*:role:*` pattern and
// subscribeToOutboxEvents's `events:*:{event_name}` patterns never have to filter each other's
// pmessages off the same "pmessage" event stream.
const redisSubscriber = createRedisSubscriber(env);
const unsubscribeRooms = subscribeToRooms(redisSubscriber, broadcast);

const outboxSubscriber = createRedisSubscriber(env);
const unsubscribeOutbox = subscribeToOutboxEvents(outboxSubscriber, broadcast);

const unsubscribe = async (): Promise<void> => {
  await Promise.all([unsubscribeRooms(), unsubscribeOutbox()]);
};

const state = { ready: true };
const app = createApp({
  isReady: () => state.ready,
  jwtSecret: env.WS_JWT_SECRET,
  rooms,
  tracker,
  metrics: snapshot,
});

const server = Bun.serve({
  port: env.PORT,
  hostname: env.HOST,
  fetch: app.fetch,
  websocket,
});

console.log(
  `Realtime gateway listening on ws://${server.hostname}:${server.port} (${env.NODE_ENV})`,
);

let shuttingDown = false;

const shutdown = (signal: string) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  void gracefulShutdown({
    onStart: () => {
      state.ready = false;
      console.log(`Received ${signal}, closing ${tracker.size()} open connection(s)…`);
    },
    unsubscribe,
    tracker,
  }).then(() => {
    server.stop();
    redisSubscriber.disconnect();
    outboxSubscriber.disconnect();
    console.log("Shutdown complete.");
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
