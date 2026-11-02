import { websocket } from "hono/bun";
import IORedis from "ioredis";

import { createApp } from "../src/app";
import { signToken } from "../src/auth";
import { createRedisSubscriber } from "../src/connection";
import { loadEnv } from "../src/env";
import { createConnectionTracker } from "../src/lifecycle";
import { snapshot } from "../src/metrics";
import { subscribeToOutboxEvents } from "../src/outbox-fanout";
import { createRoomManager } from "../src/rooms";
import { subscribeToRooms } from "../src/subscriber";

import type { RawSocket } from "../src/app";
import type { EventEnvelope } from "../src/protocol";

/**
 * Manual, Redis-required smoke test covering two acceptance criteria end-to-end: (1) "client
 * connects with a valid token stub and joins rooms; a message published to Redis fans out to room
 * members", and (2) ST-146's "grades.published reaches connected affected clients <2s end-to-end"
 * — published directly to the outbox-relay's own channel shape (`events:{schoolId}:{event_name}`,
 * a raw payload, no envelope), exactly as apps/workers/src/queues/outbox-relay/relay.ts publishes
 * it. Not part of `bun test` — it needs a real Redis instance (`REDIS_URL`, defaults to
 * redis://localhost:6379) and drives the WebSocket upgrade end-to-end, which apps/realtime's unit
 * tests deliberately don't (see src/app.test.ts). Run with `bun run smoke-test`.
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
  const app = createApp({
    isReady: () => true,
    jwtSecret: env.WS_JWT_SECRET,
    rooms,
    tracker,
    metrics: snapshot,
  });

  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
  const baseUrl = `ws://localhost:${server.port}`;

  const broadcast = (evt: EventEnvelope): void => {
    const message = JSON.stringify(evt);
    for (const member of rooms.members(evt.room)) {
      member.send(message);
    }
  };

  const redisSubscriber = createRedisSubscriber(env);
  const unsubscribeRooms = subscribeToRooms(redisSubscriber, broadcast);
  const outboxSubscriber = createRedisSubscriber(env);
  const unsubscribeOutbox = subscribeToOutboxEvents(outboxSubscriber, broadcast);
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

    console.log("Connecting client C (smoke-school/PARENT)…");
    const parentToken = signToken(
      { sub: "parent-1", schoolId: "smoke-school", role: "PARENT" },
      env.WS_JWT_SECRET,
    );
    const clientC = await connect(`${baseUrl}/ws?token=${parentToken}`);
    await waitUntil(() => clientC.received.data.length >= 1, "client C handshake ack");

    const gradesPayload = {
      submissionId: "smoke-submission",
      gradebookId: "smoke-gradebook",
      studentId: "smoke-student",
      approvedByUserId: "smoke-teacher",
    };
    console.log('Publishing to outbox channel "events:smoke-school:grades.published"…');
    const publishedAt = Date.now();
    await publisher.publish("events:smoke-school:grades.published", JSON.stringify(gradesPayload));

    await waitUntil(
      () => clientA.received.data.some((msg) => msg.includes("smoke-submission")),
      "client A (STUDENT) to receive the routed grades.published fan-out",
    );
    await waitUntil(
      () => clientC.received.data.some((msg) => msg.includes("smoke-submission")),
      "client C (PARENT) to receive the routed grades.published fan-out",
    );
    const elapsedMs = Date.now() - publishedAt;
    console.log(
      `Both STUDENT and PARENT rooms received the outbox-relayed grades.published event in ${elapsedMs}ms. Outbox fan-out works.`,
    );

    clientA.socket.close();
    clientB.socket.close();
    clientC.socket.close();
  } finally {
    await Promise.all([unsubscribeRooms(), unsubscribeOutbox()]);
    redisSubscriber.disconnect();
    outboxSubscriber.disconnect();
    publisher.disconnect();
    server.stop();
  }

  console.log("Smoke test passed.");
}

main().catch((error: unknown) => {
  console.error("Smoke test failed:", error);
  process.exit(1);
});
