/**
 * Realtime handshake contract (QA-14, F-05): the API's real ticket issuer against the gateway's real
 * verifier, in both directions.
 *
 * The gateway modules are imported from apps/realtime by path, not re-implemented here, so this file
 * fails the moment either side changes the contract alone: claim names, audience, issuer, lifetime,
 * signing algorithm, or the query parameter the handshake reads. The last describe block runs the
 * whole journey: an access token minted by the API's key store calls GET /api/realtime/ticket
 * through the production JWT middleware, and the ticket it gets back opens a socket on the
 * gateway's production handshake.
 */

import { REALTIME_TICKET } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp as createGatewayApp, realtimeWebSocket } from "../../../realtime/src/app";
import { TokenVerificationError, verifyToken } from "../../../realtime/src/auth";
import { createConnectionTracker } from "../../../realtime/src/lifecycle";
import { snapshot } from "../../../realtime/src/metrics";
import { createRoomManager, roleRoomKey, userRoomKey } from "../../../realtime/src/rooms";
import { createMemorySessionGuard } from "../../../realtime/src/session-guard.testing";
import { createApp } from "../../src/app";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { AUTH_CHANNELS, KeyStore, signAccessToken } from "../../src/modules/auth";
import { verifyAccessToken } from "../../src/modules/auth/jwt/verify";
import { mintRealtimeTicket } from "../../src/modules/realtime";

import type { RawSocket } from "../../../realtime/src/app";

const SECRET = "contract-test-secret-of-at-least-32-chars";
const ISSUER = "studafy-test";
const AUDIENCE = "studafy-api-test";
const SCHOOL = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const session = {
  userId: USER,
  schoolId: SCHOOL,
  roles: ["INSTRUCTOR", "PARENT"] as const,
  accessTokenJti: "33333333-3333-4333-8333-333333333333",
  accessTokenExp: Math.floor(Date.now() / 1000) + 900,
};

let keyStore: KeyStore;

beforeAll(async () => {
  keyStore = new KeyStore(60_000);
  await keyStore.init();
});

afterAll(() => keyStore.destroy());

describe("API issuer → gateway verifier", () => {
  test("a minted ticket verifies, and carries the session it was minted for", async () => {
    const { ticket, expiresAt } = await mintRealtimeTicket(session, SECRET);
    const claims = verifyToken(ticket, SECRET);

    expect(claims).toMatchObject({
      userId: USER,
      schoolId: SCHOOL,
      roles: ["INSTRUCTOR", "PARENT"],
      sessionId: session.accessTokenJti,
      sessionExp: session.accessTokenExp,
    });
    expect(claims.exp * 1000).toBe(expiresAt.getTime());
  });

  test("the lifetime the API mints with is inside what the gateway accepts, and at most 60 s", async () => {
    const now = Date.now();
    const { ticket } = await mintRealtimeTicket(session, SECRET, () => now);
    const payload = JSON.parse(Buffer.from(ticket.split(".")[1]!, "base64url").toString()) as {
      iat: number;
      exp: number;
      aud: string;
      iss: string;
    };

    expect(payload.exp - payload.iat).toBe(REALTIME_TICKET.ttlSeconds);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(REALTIME_TICKET.maxTtlSeconds);
    expect(REALTIME_TICKET.maxTtlSeconds).toBeLessThanOrEqual(60);
    expect(payload).toMatchObject({ aud: "studafy-realtime", iss: "studafy-api" });

    // Still good just before expiry; refused as expired (the re-auth code) just after.
    expect(() => verifyToken(ticket, SECRET, now + 29_000)).not.toThrow();
    expect(() => verifyToken(ticket, SECRET, now + 31_000)).toThrow(
      expect.objectContaining({ code: "TOKEN_EXPIRED" }),
    );
  });

  test("every ticket has its own jti, so single use can be enforced", async () => {
    const [a, b] = await Promise.all([
      mintRealtimeTicket(session, SECRET),
      mintRealtimeTicket(session, SECRET),
    ]);
    expect(verifyToken(a.ticket, SECRET).ticketId).not.toBe(verifyToken(b.ticket, SECRET).ticketId);
  });

  test("the gateway refuses a ticket signed with any other key", async () => {
    const { ticket } = await mintRealtimeTicket(session, "a-different-secret-of-32-characters!");
    expect(() => verifyToken(ticket, SECRET)).toThrow(TokenVerificationError);
  });
});

describe("audience separation", () => {
  test("the gateway refuses the API's own access token, so a session token cannot open a socket", async () => {
    const accessToken = await signAccessToken(
      keyStore,
      {
        sub: USER,
        school_id: SCHOOL,
        roles: ["INSTRUCTOR"],
        entitlements_ver: 1,
        channel: AUTH_CHANNELS.WEB,
        subscription_status: "active",
      },
      { issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 900 },
    );
    expect(() => verifyToken(accessToken, SECRET)).toThrow(
      expect.objectContaining({ code: "TOKEN_INVALID" }),
    );
  });

  test("the API refuses a ticket as an access token", async () => {
    const { ticket } = await mintRealtimeTicket(session, SECRET);
    await expect(
      verifyAccessToken(keyStore, ticket, { issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toThrow();
  });
});

describe("end to end: GET /api/realtime/ticket → gateway /ws", () => {
  test("a session's ticket opens a socket joined to that session's home rooms; the access token does not", async () => {
    const api = createApp({
      isReady: () => true,
      tracker: createInflightTracker(),
      logger: createLogger({ destination: () => undefined }),
      database: null,
      keyStore,
      jwtIssuer: ISSUER,
      jwtAudience: AUDIENCE,
      realtimeTicketSecret: SECRET,
    });
    const rooms = createRoomManager<RawSocket>();
    const gateway = createGatewayApp({
      isReady: () => true,
      jwtSecret: SECRET,
      sessionGuard: createMemorySessionGuard(),
      rooms,
      tracker: createConnectionTracker<RawSocket>(),
      metrics: snapshot,
    });
    const server = Bun.serve({ port: 0, fetch: gateway.fetch, websocket: realtimeWebSocket });

    try {
      const accessToken = await signAccessToken(
        keyStore,
        {
          sub: USER,
          school_id: SCHOOL,
          roles: ["INSTRUCTOR"],
          entitlements_ver: 1,
          channel: AUTH_CHANNELS.WEB,
          subscription_status: "active",
        },
        { issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 900 },
      );

      const response = await api.request("/api/realtime/ticket", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const { ticket } = (await response.json()) as { ticket: string; expires_at: string };
      expect(ticket).not.toBe(accessToken);

      const received: string[] = [];
      const socket = new WebSocket(`ws://localhost:${server.port}/ws?ticket=${ticket}`);
      socket.addEventListener("message", (event) => received.push(String(event.data)));
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error("handshake refused")));
      });
      const deadline = Date.now() + 5_000;
      while (received.length < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(rooms.members(roleRoomKey(SCHOOL, "INSTRUCTOR")).size).toBe(1);
      expect(rooms.members(userRoomKey(SCHOOL, USER)).size).toBe(1);
      socket.close();

      // The pre-QA-14 client behaviour: the access token itself, in either parameter.
      for (const query of [`ticket=${accessToken}`, `token=${accessToken}`]) {
        const refused = await fetch(`http://localhost:${server.port}/ws?${query}`);
        expect(refused.status).toBe(401);
      }

      // No session, no ticket.
      expect((await api.request("/api/realtime/ticket")).status).toBe(401);
    } finally {
      server.stop(true);
    }
  });
});
