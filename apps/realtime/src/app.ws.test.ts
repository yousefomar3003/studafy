// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";

import { createApp, realtimeWebSocket } from "./app";
import { signToken } from "./auth";
import { createConnectionTracker } from "./lifecycle";
import { MAX_PAYLOAD_BYTES, RATE_LIMITED_CLOSE_CODE } from "./limits";
import { snapshot } from "./metrics";
import { REAUTH_REQUIRED_CLOSE_CODE } from "./protocol";
import { createRoomManager, roleRoomKey, schoolRoomKey, userRoomKey } from "./rooms";

import type { AppOptions, RawSocket } from "./app";
import type { Role } from "@studafy/constants";

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

function startServer(options: Pick<AppOptions, "allowedOrigins" | "limits"> = {}) {
  const rooms = createRoomManager<RawSocket>();
  const tracker = createConnectionTracker<RawSocket>();
  const app = createApp({
    isReady: () => true,
    jwtSecret: SECRET,
    rooms,
    tracker,
    metrics: snapshot,
    ...options,
  });
  // The same handler index.ts serves, so the frame-size cap is exercised too.
  server = Bun.serve({ port: 0, fetch: app.fetch, websocket: realtimeWebSocket });
  return {
    rooms,
    tracker,
    baseUrl: `ws://localhost:${server.port}`,
    httpUrl: `http://localhost:${server.port}`,
  };
}

interface Received {
  data: string[];
  closeCode: number | undefined;
}

function connect(
  url: string,
  headers?: Record<string, string>,
): Promise<{ socket: WebSocket; received: Received }> {
  return new Promise((resolve, reject) => {
    // Bun's WebSocket accepts handshake headers (e.g. Origin) as a second-argument option.
    const socket = headers ? new WebSocket(url, { headers }) : new WebSocket(url);
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

function token(schoolId: string, sub: string, exp?: number, role: Role = "STUDENT") {
  return signToken({ sub, schoolId, role, exp }, SECRET);
}

/** Sends one control message and waits for the reply that mentions `room` or is an error. */
async function sendAndAwait(
  client: { socket: WebSocket; received: Received },
  message: object,
): Promise<string> {
  const before = client.received.data.length;
  client.socket.send(JSON.stringify(message));
  await waitUntil(() => client.received.data.length > before, "a reply to the control message");
  return client.received.data.at(before)!;
}

async function connectHome(baseUrl: string, sub = "user-u", role: Role = "STUDENT") {
  const client = await connect(`${baseUrl}/ws?token=${token("school-s", sub, undefined, role)}`);
  await waitUntil(() => client.received.data.length >= 3, "the three home-room join acks");
  return client;
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

describe("in-school room authorization (F-04)", () => {
  test("a socket for user U cannot join another user's room in the same school", async () => {
    const { rooms, baseUrl } = startServer();
    const victim = await connectHome(baseUrl, "user-v");
    const attacker = await connectHome(baseUrl, "user-u");

    const victimRoom = userRoomKey("school-s", "user-v");
    const reply = await sendAndAwait(attacker, { type: "join", room: victimRoom });

    expect(JSON.parse(reply)).toEqual({
      type: "system.error",
      message: "not authorized for this room",
    });
    expect(rooms.members(victimRoom).size).toBe(1);

    victim.socket.close();
    attacker.socket.close();
  });

  test("a socket cannot join a role room for a role it does not hold", async () => {
    const { rooms, baseUrl } = startServer();
    const student = await connectHome(baseUrl);

    for (const role of ["INSTRUCTOR", "ORG_ADMIN", "SUPER_ADMIN"] as const) {
      const room = roleRoomKey("school-s", role);
      const reply = await sendAndAwait(student, { type: "join", room });
      expect(JSON.parse(reply)).toEqual({
        type: "system.error",
        message: "not authorized for this room",
      });
      expect(rooms.members(room).size).toBe(0);
    }

    student.socket.close();
  });

  test("a socket may leave and rejoin each of its own rooms (one per kind)", async () => {
    const { rooms, baseUrl } = startServer();
    const client = await connectHome(baseUrl, "user-u", "INSTRUCTOR");

    for (const room of [
      schoolRoomKey("school-s"),
      roleRoomKey("school-s", "INSTRUCTOR"),
      userRoomKey("school-s", "user-u"),
    ]) {
      expect(JSON.parse(await sendAndAwait(client, { type: "leave", room }))).toEqual({
        type: "system.left",
        room,
      });
      expect(rooms.members(room).size).toBe(0);
      expect(JSON.parse(await sendAndAwait(client, { type: "join", room }))).toEqual({
        type: "system.joined",
        room,
      });
      expect(rooms.members(room).size).toBe(1);
    }

    client.socket.close();
  });

  test("an unknown room kind is rejected", async () => {
    const { rooms, baseUrl } = startServer();
    const client = await connectHome(baseUrl);

    const room = "school:school-s:class:class-1";
    const reply = JSON.parse(await sendAndAwait(client, { type: "join", room })) as {
      type: string;
    };
    expect(reply.type).toBe("system.error");
    expect(rooms.members(room).size).toBe(0);

    client.socket.close();
  });
});

describe("gateway limits (F-16)", () => {
  test("a frame over the 16 KB cap closes the socket before any handler sees it", async () => {
    const { tracker, baseUrl } = startServer();
    const client = await connectHome(baseUrl);
    const repliesBefore = client.received.data.length;

    client.socket.send("x".repeat(MAX_PAYLOAD_BYTES + 1));
    await waitUntil(() => client.received.closeCode !== undefined, "the socket to close");
    // Bun drops the connection without a close frame, so the client sees 1006 (abnormal), not 1009.
    expect([1006, 1009]).toContain(client.received.closeCode!);
    // The oversized frame never reached handleClientMessage (which would have answered it), and
    // the gateway has forgotten the connection.
    expect(client.received.data.length).toBe(repliesBefore);
    await waitUntil(() => tracker.size() === 0, "the gateway to drop the connection");
  });

  test("a frame at the cap is still delivered to the handler", async () => {
    const { baseUrl } = startServer();
    const client = await connectHome(baseUrl);

    const reply = await sendAndAwait(client, {
      type: "join",
      room: `school:school-s:user:${"u".repeat(MAX_PAYLOAD_BYTES - 64)}`,
    });
    expect(JSON.parse(reply)).toEqual({
      type: "system.error",
      message: "not authorized for this room",
    });
    expect(client.received.closeCode).toBeUndefined();

    client.socket.close();
  });

  test("a join past the per-socket room cap is refused; re-joining a current room is not", async () => {
    // A cap of 3 is exactly the home rooms: the socket is full as soon as it opens.
    const { rooms, baseUrl } = startServer({ limits: { maxRoomsPerSocket: 3 } });
    const client = await connectHome(baseUrl);
    const school = schoolRoomKey("school-s");

    expect(JSON.parse(await sendAndAwait(client, { type: "join", room: school }))).toEqual({
      type: "system.joined",
      room: school,
    });
    expect(rooms.members(school).size).toBe(1);

    // Lower than the home rooms: after one leave the socket is still at the cap of 2.
    server?.stop(true);
    const lowered = startServer({ limits: { maxRoomsPerSocket: 2 } });
    const capped = await connectHome(lowered.baseUrl);
    await sendAndAwait(capped, { type: "leave", room: school });
    const reply = await sendAndAwait(capped, { type: "join", room: school });
    expect(JSON.parse(reply)).toEqual({ type: "system.error", message: "room limit reached" });
    expect(lowered.rooms.members(school).size).toBe(0);

    capped.socket.close();
  });

  test("a socket that exceeds the control-frame rate limit is closed with 1008", async () => {
    const { baseUrl } = startServer({
      limits: { controlBurst: 3, controlRefillPerSecond: 0.001 },
    });
    const client = await connectHome(baseUrl);
    const room = schoolRoomKey("school-s");

    for (let i = 0; i < 3; i += 1) {
      expect(JSON.parse(await sendAndAwait(client, { type: "join", room }))).toEqual({
        type: "system.joined",
        room,
      });
    }
    client.socket.send(JSON.stringify({ type: "join", room }));

    await waitUntil(() => client.received.closeCode !== undefined, "the socket to close");
    expect(client.received.closeCode).toBe(RATE_LIMITED_CLOSE_CODE);
    expect(client.received.data.at(-1)).toContain("rate limit exceeded");
  });

  describe("Origin allowlist", () => {
    const allowedOrigins = ["https://app.studafy.com"];

    test("a handshake from an unlisted origin gets 403 before the token is even read", async () => {
      const { httpUrl } = startServer({ allowedOrigins });
      const response = await fetch(`${httpUrl}/ws?token=${token("school-s", "user-u")}`, {
        headers: { Origin: "https://evil.example" },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "origin not allowed",
        code: "ORIGIN_NOT_ALLOWED",
      });
    });

    test("an unlisted origin cannot open a socket", async () => {
      const { baseUrl } = startServer({ allowedOrigins });
      await expect(
        connect(`${baseUrl}/ws?token=${token("school-s", "user-u")}`, {
          Origin: "https://evil.example",
        }),
      ).rejects.toThrow();
    });

    test("a listed origin opens a socket", async () => {
      const { baseUrl } = startServer({ allowedOrigins });
      const client = await connect(`${baseUrl}/ws?token=${token("school-s", "user-u")}`, {
        Origin: "https://app.studafy.com",
      });
      await waitUntil(() => client.received.data.length >= 3, "the three home-room join acks");
      client.socket.close();
    });
  });
});
