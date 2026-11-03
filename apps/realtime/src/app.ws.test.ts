// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";

import { createApp, realtimeWebSocket } from "./app";
import { signToken, ticketPayload } from "./auth";
import { createConnectionTracker } from "./lifecycle";
import { MAX_PAYLOAD_BYTES, RATE_LIMITED_CLOSE_CODE } from "./limits";
import { snapshot } from "./metrics";
import { REAUTH_REQUIRED_CLOSE_CODE } from "./protocol";
import { createRoomManager, roleRoomKey, schoolRoomKey, userRoomKey } from "./rooms";
import { createSessionRegistry, startRevocationSweep, sweepRevokedSessions } from "./session-guard";
import { createMemorySessionGuard } from "./session-guard.testing";

import type { AppOptions, RawSocket } from "./app";
import type { TicketPayload } from "./auth";
import type { Role } from "@studafy/constants";

/**
 * Cross-tenant isolation and the re-auth protocol both hinge on the real `/ws` upgrade, which (per
 * src/app.test.ts's module doc) needs a live `Bun.serve` server — `app.request()` can't drive it.
 * Neither of these needs Redis, though, so unlike scripts/smoke-test.ts they belong in `bun test`
 * and run in CI on every push, not only when a human remembers to run the manual smoke test.
 */

const SECRET = "test-secret-at-least-thirty-two-chars";

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function startServer(options: Pick<AppOptions, "allowedOrigins" | "limits" | "reportError"> = {}) {
  const rooms = createRoomManager<RawSocket>();
  const tracker = createConnectionTracker<RawSocket>();
  const sessionGuard = createMemorySessionGuard();
  const sessions = createSessionRegistry<RawSocket>();
  const app = createApp({
    isReady: () => true,
    jwtSecret: SECRET,
    sessionGuard,
    sessions,
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
    sessionGuard,
    sessions,
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

/** A fresh, valid ticket. Each call mints a new `jti`, since a ticket opens only one socket. */
function token(
  schoolId: string,
  sub: string,
  overrides: Partial<TicketPayload> = {},
  role: Role = "STUDENT",
) {
  return signToken(
    ticketPayload({ sub, school_id: schoolId, roles: [role], ...overrides }),
    SECRET,
  );
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
  const client = await connect(`${baseUrl}/ws?ticket=${token("school-s", sub, {}, role)}`);
  await waitUntil(() => client.received.data.length >= 3, "the three home-room join acks");
  return client;
}

describe("cross-tenant room authorization (probe test)", () => {
  test("a connection only auto-joins its own school's rooms, never another school's", async () => {
    const { rooms, baseUrl } = startServer();

    const schoolA = await connect(`${baseUrl}/ws?ticket=${token("school-a", "user-a")}`);
    const schoolB = await connect(`${baseUrl}/ws?ticket=${token("school-b", "user-b")}`);
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

    const schoolA = await connect(`${baseUrl}/ws?ticket=${token("school-a", "user-a")}`);
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

    const schoolA = await connect(`${baseUrl}/ws?ticket=${token("school-a", "user-a")}`);
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
  test("a connection is warned and closed with the re-auth code when its session expires", async () => {
    const { baseUrl } = startServer();
    const nearFutureSessionExp = Math.floor(Date.now() / 1000) + 1;

    const client = await connect(
      `${baseUrl}/ws?ticket=${token("school-a", "user-a", { sexp: nearFutureSessionExp })}`,
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

  test("the ticket's own expiry bounds the handshake only, not the open socket", async () => {
    const { baseUrl } = startServer();
    const now = Math.floor(Date.now() / 1000);

    const client = await connect(
      `${baseUrl}/ws?ticket=${token("school-a", "user-a", { iat: now, exp: now + 1 })}`,
    );
    await waitUntil(() => client.received.data.length >= 3, "the three join acks");

    // Past the ticket's exp, well before the session's.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(client.received.closeCode).toBeUndefined();

    client.socket.close();
  });
});

describe("handshake ticket (F-05)", () => {
  async function handshakeStatus(httpUrl: string, ticket: string) {
    const response = await fetch(`${httpUrl}/ws?ticket=${ticket}`);
    return {
      status: response.status,
      body: (await response.json()) as { error: string; code: string },
    };
  }

  test("a ticket opens one socket; replaying it is refused", async () => {
    const { baseUrl, httpUrl } = startServer();
    const ticket = token("school-a", "user-a");

    const first = await connect(`${baseUrl}/ws?ticket=${ticket}`);
    await waitUntil(() => first.received.data.length >= 3, "the three join acks");

    const replay = await handshakeStatus(httpUrl, ticket);
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual({ error: "ticket already used", code: "TOKEN_INVALID" });
    first.socket.close();
  });

  test("a ticket for an already-revoked session is refused at handshake", async () => {
    const { httpUrl, sessionGuard } = startServer();
    const sid = crypto.randomUUID();
    sessionGuard.revoke(sid);

    const { status, body } = await handshakeStatus(httpUrl, token("school-a", "user-a", { sid }));
    expect(status).toBe(401);
    expect(body.code).toBe("TOKEN_INVALID");
  });

  test("the handshake fails closed with 503 when the session check is unavailable", async () => {
    const reportError = () => undefined;
    const { httpUrl, sessionGuard } = startServer({ reportError });
    sessionGuard.failNext(new Error("redis down"));

    const { status, body } = await handshakeStatus(httpUrl, token("school-a", "user-a"));
    expect(status).toBe(503);
    expect(body.code).toBe("UNAVAILABLE");
  });

  test("the API's own access-token audience is refused", async () => {
    const { httpUrl } = startServer();
    const { status, body } = await handshakeStatus(
      httpUrl,
      token("school-a", "user-a", { aud: "studafy-api" }),
    );
    expect(status).toBe(401);
    expect(body.code).toBe("TOKEN_INVALID");
  });

  test("a ticket issued for longer than 60 seconds is refused", async () => {
    const { httpUrl } = startServer();
    const now = Math.floor(Date.now() / 1000);
    const { status } = await handshakeStatus(
      httpUrl,
      token("school-a", "user-a", { iat: now, exp: now + 61 }),
    );
    expect(status).toBe(401);
  });

  test("a multi-role session joins one role room per role", async () => {
    const { rooms, baseUrl } = startServer();
    const ticket = signToken(
      ticketPayload({ sub: "user-t", school_id: "school-a", roles: ["INSTRUCTOR", "PARENT"] }),
      SECRET,
    );

    const client = await connect(`${baseUrl}/ws?ticket=${ticket}`);
    await waitUntil(() => client.received.data.length >= 4, "the four join acks");

    expect(rooms.members(roleRoomKey("school-a", "INSTRUCTOR")).size).toBe(1);
    expect(rooms.members(roleRoomKey("school-a", "PARENT")).size).toBe(1);
    expect(rooms.members(roleRoomKey("school-a", "STUDENT")).size).toBe(0);
    client.socket.close();
  });

  test("the ticket never reaches the console, on success or on rejection", async () => {
    const { baseUrl, httpUrl } = startServer();
    const ticket = token("school-a", "user-a");
    const lines: string[] = [];
    const originals = { log: console.log, warn: console.warn, error: console.error };
    for (const level of ["log", "warn", "error"] as const) {
      console[level] = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    }
    try {
      const client = await connect(`${baseUrl}/ws?ticket=${ticket}`);
      await waitUntil(() => client.received.data.length >= 3, "the three join acks");
      await handshakeStatus(httpUrl, ticket);
      await handshakeStatus(httpUrl, `${ticket}x`);
      client.socket.close();
    } finally {
      Object.assign(console, originals);
    }
    expect(lines.some((line) => line.includes(ticket.split(".")[2]))).toBe(false);
  });
});

/**
 * QA-14 acceptance: a revoked session's socket closes within a bounded time. The bound is the
 * sweep interval (REVOCATION_SWEEP_INTERVAL_MS, 15 s in production) plus one Redis round trip. The
 * tests run the same sweep with a 50 ms interval and assert the close lands inside that interval
 * plus a scheduling margin.
 */
describe("revocation (F-05)", () => {
  test("a sweep closes only the revoked session's sockets, with 4401 and a reauth message", async () => {
    const { baseUrl, sessionGuard, sessions } = startServer();
    const revokedSid = crypto.randomUUID();

    const victim = await connect(
      `${baseUrl}/ws?ticket=${token("school-a", "user-a", { sid: revokedSid })}`,
    );
    const bystander = await connect(`${baseUrl}/ws?ticket=${token("school-a", "user-b")}`);
    await waitUntil(() => victim.received.data.length >= 3, "victim join acks");
    await waitUntil(() => bystander.received.data.length >= 3, "bystander join acks");

    sessionGuard.revoke(revokedSid);
    expect(await sweepRevokedSessions(sessions, sessionGuard)).toBe(1);

    await waitUntil(() => victim.received.closeCode !== undefined, "the revoked socket to close");
    expect(victim.received.closeCode).toBe(REAUTH_REQUIRED_CLOSE_CODE);
    expect(JSON.parse(victim.received.data.at(-1)!)).toEqual({
      type: "system.reauth_required",
      reason: "session revoked",
    });
    expect(bystander.received.closeCode).toBeUndefined();
    bystander.socket.close();
  });

  test("the periodic sweep closes a revoked socket within one interval", async () => {
    const { baseUrl, sessionGuard, sessions } = startServer();
    const intervalMs = 50;
    const stop = startRevocationSweep({
      registry: sessions,
      guard: sessionGuard,
      intervalMs,
      onError: (error) => {
        throw error;
      },
    });
    try {
      const sid = crypto.randomUUID();
      const client = await connect(`${baseUrl}/ws?ticket=${token("school-a", "user-a", { sid })}`);
      await waitUntil(() => client.received.data.length >= 3, "the three join acks");

      const revokedAt = Date.now();
      sessionGuard.revoke(sid);
      await waitUntil(() => client.received.closeCode !== undefined, "the socket to close", 2000);

      expect(client.received.closeCode).toBe(REAUTH_REQUIRED_CLOSE_CODE);
      expect(Date.now() - revokedAt).toBeLessThan(intervalMs + 250);
    } finally {
      stop();
    }
  });

  test("a closed socket leaves the registry, so sweeps do not grow with churn", async () => {
    const { baseUrl, sessions } = startServer();
    const client = await connect(`${baseUrl}/ws?ticket=${token("school-a", "user-a")}`);
    await waitUntil(() => sessions.sessions().length === 1, "the session to register");
    client.socket.close();
    await waitUntil(() => sessions.sessions().length === 0, "the session to deregister");
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
      const response = await fetch(`${httpUrl}/ws?ticket=${token("school-s", "user-u")}`, {
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
        connect(`${baseUrl}/ws?ticket=${token("school-s", "user-u")}`, {
          Origin: "https://evil.example",
        }),
      ).rejects.toThrow();
    });

    test("a listed origin opens a socket", async () => {
      const { baseUrl } = startServer({ allowedOrigins });
      const client = await connect(`${baseUrl}/ws?ticket=${token("school-s", "user-u")}`, {
        Origin: "https://app.studafy.com",
      });
      await waitUntil(() => client.received.data.length >= 3, "the three home-room join acks");
      client.socket.close();
    });
  });
});
