// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";
import { websocket } from "hono/bun";

import { createApp } from "./app";
import { signToken } from "./auth";
import { createConnectionTracker } from "./lifecycle";
import { snapshot } from "./metrics";
import { REAUTH_REQUIRED_CLOSE_CODE } from "./protocol";
import { createRoomManager, roleRoomKey, schoolRoomKey, userRoomKey } from "./rooms";

import type { RawSocket } from "./app";

/**
 * Cross-tenant isolation and the re-auth protocol both hinge on the real `/ws` upgrade, which (per
 * src/app.test.ts's module doc) needs a live `Bun.serve` server — `app.request()` can't drive it.
 * Neither of these needs Redis, though, so unlike scripts/smoke-test.ts they belong in `bun test`
 * and run in CI on every push, not only when a human remembers to run the manual smoke test.
 */

const SECRET = "test-secret";

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function startServer() {
  const rooms = createRoomManager<RawSocket>();
  const tracker = createConnectionTracker<RawSocket>();
  const app = createApp({
    isReady: () => true,
    jwtSecret: SECRET,
    rooms,
    tracker,
    metrics: snapshot,
  });
  server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
  return { rooms, tracker, baseUrl: `ws://localhost:${server.port}` };
}

interface Received {
  data: string[];
  closeCode: number | undefined;
}

function connect(url: string): Promise<{ socket: WebSocket; received: Received }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const received: Received = { data: [], closeCode: undefined };
    socket.addEventListener("message", (event) => {
      received.data.push(String(event.data));
    });
    socket.addEventListener("close", (event) => {
      received.closeCode = event.code;
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
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function token(schoolId: string, sub: string, exp?: number) {
  return signToken({ sub, schoolId, role: "STUDENT", exp }, SECRET);
}

describe("cross-tenant room authorization (probe test)", () => {
  test("a connection only auto-joins its own school's rooms, never another school's", async () => {
    const { rooms, baseUrl } = startServer();

    const schoolA = await connect(`${baseUrl}/ws?token=${token("school-a", "user-a")}`);
    const schoolB = await connect(`${baseUrl}/ws?token=${token("school-b", "user-b")}`);
    await waitUntil(() => schoolA.received.data.length >= 3, "school A's three join acks");
    await waitUntil(() => schoolB.received.data.length >= 3, "school B's three join acks");

    expect(rooms.members(schoolRoomKey("school-a")).size).toBe(1);
    expect(rooms.members(roleRoomKey("school-a", "STUDENT")).size).toBe(1);
    expect(rooms.members(userRoomKey("school-a", "user-a")).size).toBe(1);

    // The defining probe: school A's rooms stay at exactly one member (itself) even after school
    // B connects and joins its own, differently-named rooms — a school-B connection can never land
    // in a school-A room membership set.
    expect(rooms.members(schoolRoomKey("school-b")).size).toBe(1);
    expect(rooms.members(roleRoomKey("school-b", "STUDENT")).size).toBe(1);
    expect(rooms.members(userRoomKey("school-b", "user-b")).size).toBe(1);

    schoolA.socket.close();
    schoolB.socket.close();
  });

  test("explicitly joining another school's room is rejected with system.error", async () => {
    const { rooms, baseUrl } = startServer();

    const schoolA = await connect(`${baseUrl}/ws?token=${token("school-a", "user-a")}`);
    await waitUntil(() => schoolA.received.data.length >= 3, "school A's three join acks");

    const foreignRoom = schoolRoomKey("school-b");
    schoolA.socket.send(JSON.stringify({ type: "join", room: foreignRoom }));

    await waitUntil(
      () => schoolA.received.data.some((msg) => msg.includes("system.error")),
      "a system.error rejecting the cross-school join",
    );
    const errorMsg = schoolA.received.data.find((msg) => msg.includes("system.error"));
    expect(errorMsg).toContain("cannot join a room outside your own school");
    expect(rooms.members(foreignRoom).size).toBe(0);

    schoolA.socket.close();
  });

  test("explicitly leaving another school's room is rejected with system.error", async () => {
    const { baseUrl } = startServer();

    const schoolA = await connect(`${baseUrl}/ws?token=${token("school-a", "user-a")}`);
    await waitUntil(() => schoolA.received.data.length >= 3, "school A's three join acks");

    schoolA.socket.send(
      JSON.stringify({ type: "leave", room: roleRoomKey("school-b", "STUDENT") }),
    );

    await waitUntil(
      () => schoolA.received.data.some((msg) => msg.includes("system.error")),
      "a system.error rejecting the cross-school leave",
    );

    schoolA.socket.close();
  });
});

describe("re-auth protocol", () => {
  test("a connection is warned and closed with the re-auth code when its token expires", async () => {
    const { baseUrl } = startServer();
    const nearFutureExp = Math.floor(Date.now() / 1000) + 1;

    const client = await connect(
      `${baseUrl}/ws?token=${token("school-a", "user-a", nearFutureExp)}`,
    );
    await waitUntil(() => client.received.data.length >= 3, "the three join acks");

    await waitUntil(
      () => client.received.data.some((msg) => msg.includes("system.reauth_required")),
      "a system.reauth_required warning",
      3000,
    );
    await waitUntil(() => client.received.closeCode !== undefined, "the socket to close", 3000);

    expect(client.received.closeCode).toBe(REAUTH_REQUIRED_CLOSE_CODE);
  });

  test("a token with no exp never triggers a re-auth close", async () => {
    const { baseUrl } = startServer();

    const client = await connect(`${baseUrl}/ws?token=${token("school-a", "user-a")}`);
    await waitUntil(() => client.received.data.length >= 3, "the three join acks");

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.received.closeCode).toBeUndefined();

    client.socket.close();
  });
});
