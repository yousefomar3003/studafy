import { websocket } from "hono/bun";
import IORedis from "ioredis";

import { createApp } from "../src/app";
import { signToken } from "../src/auth";
import { createRedisSubscriber } from "../src/connection";
import { loadEnv } from "../src/env";
import { createConnectionTracker } from "../src/lifecycle";
import { createRoomManager } from "../src/rooms";
import { subscribeToRooms } from "../src/subscriber";

import type { RawSocket } from "../src/app";
import type { EventEnvelope } from "../src/protocol";

/**
 * Manual, Redis-required smoke test for the acceptance criterion "client connects with a valid
 * token stub and joins rooms; a message published to Redis fans out to room members." Not part of
 * `bun test` — it needs a real Redis instance (`REDIS_URL`, defaults to redis://localhost:6379)
 * and drives the WebSocket upgrade end-to-end, which apps/realtime's unit tests deliberately don't
 * (see src/app.test.ts). Run with `bun run smoke-test`.
 */

interface Received {
  data: string[];
}

function connect(url: string): Promise<{ socket: WebSocket; received: Received }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const received: Received = { data: [] };
    socket.addEventListener("message", (event) => {
      received.data.push(String(event.data));
    });
    socket.addEventListener("open", () => resolve({ socket, received }));
    socket.addEventListener("error", () => reject(new Error(`failed to connect to ${url}`)));
  });
}

async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function envelope(room: string, text: string): EventEnvelope {
  return {
    id: crypto.randomUUID(),
    type: "announcement.posted",
    room,
    payload: { text },
    publishedAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const env = loadEnv();

  const rooms = createRoomManager<RawSocket>();
  const tracker = createConnectionTracker<RawSocket>();
  const app = createApp({ isReady: () => true, jwtSecret: env.WS_JWT_SECRET, rooms, tracker });

  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
  const baseUrl = `ws://localhost:${server.port}`;

  const redisSubscriber = createRedisSubscriber(env);
  const unsubscribe = subscribeToRooms(redisSubscriber, (evt) => {
    const message = JSON.stringify(evt);
    for (const member of rooms.members(evt.room)) {
      member.send(message);
    }
  });
  const publisher = new IORedis(env.REDIS_URL, { lazyConnect: true });
  await publisher.connect();

  try {
    const studentRoom = "school:smoke-school:role:STUDENT";
    const instructorRoom = "school:smoke-school:role:INSTRUCTOR";

    const studentToken = signToken(
      { sub: "student-1", schoolId: "smoke-school", role: "STUDENT" },
      env.WS_JWT_SECRET,
    );
    const otherSchoolToken = signToken(
      { sub: "student-2", schoolId: "other-school", role: "STUDENT" },
      env.WS_JWT_SECRET,
    );

    console.log("Connecting client A (smoke-school/STUDENT)…");
    const clientA = await connect(`${baseUrl}/ws?token=${studentToken}`);
    await waitUntil(() => clientA.received.data.length >= 1, "client A handshake ack");
    console.log(
      "Connecting client B (other-school/STUDENT, must not receive smoke-school fan-out)…",
    );
    const clientB = await connect(`${baseUrl}/ws?token=${otherSchoolToken}`);
    await waitUntil(() => clientB.received.data.length >= 1, "client B handshake ack");

    console.log(`Publishing to Redis channel "${studentRoom}"…`);
    await publisher.publish(studentRoom, JSON.stringify(envelope(studentRoom, "hello students")));

    await waitUntil(
      () => clientA.received.data.some((msg) => msg.includes("hello students")),
      "client A to receive the fanned-out message",
    );
    console.log("Client A received the fanned-out message. Fan-out works.");

    if (clientB.received.data.some((msg) => msg.includes("hello students"))) {
      throw new Error(
        "client B (a different school) incorrectly received another school's room message",
      );
    }
    console.log("Client B correctly did not receive another school's room message.");

    console.log(`Client A explicitly joining "${instructorRoom}"…`);
    clientA.socket.send(JSON.stringify({ type: "join", room: instructorRoom }));
    await waitUntil(
      () =>
        clientA.received.data.some(
          (msg) => msg.includes('"system.joined"') && msg.includes(instructorRoom),
        ),
      "client A to ack joining the instructor room",
    );

    await publisher.publish(
      instructorRoom,
      JSON.stringify(envelope(instructorRoom, "hello instructors")),
    );
    await waitUntil(
      () => clientA.received.data.some((msg) => msg.includes("hello instructors")),
      "client A to receive the second room's fanned-out message",
    );
    console.log(
      "Client A received the second room's message after an explicit join. Room abstraction works.",
    );

    clientA.socket.close();
    clientB.socket.close();
  } finally {
    await unsubscribe();
    redisSubscriber.disconnect();
    publisher.disconnect();
    server.stop();
  }

  console.log("Smoke test passed.");
}

main().catch((error: unknown) => {
  console.error("Smoke test failed:", error);
  process.exit(1);
});
