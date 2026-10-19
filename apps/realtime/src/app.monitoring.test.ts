// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, mock, test } from "bun:test";

import { createApp, monitored } from "./app";
import { createConnectionTracker } from "./lifecycle";
import { snapshot } from "./metrics";
import { createRoomManager } from "./rooms";

import type { AuthClaims } from "./auth";

const SECRET = "test-secret";

describe("error monitoring", () => {
  test("an unexpected throw is reported with its route and answered with a bare 500", async () => {
    const reportError = mock();
    const error = new Error("probe crashed");
    const app = createApp({
      isReady: () => {
        throw error;
      },
      jwtSecret: SECRET,
      rooms: createRoomManager(),
      tracker: createConnectionTracker(),
      metrics: snapshot,
      reportError,
    });

    const res = await app.request("/readyz");

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
    expect(reportError).toHaveBeenCalledWith(error, { tags: { route: "/readyz" } });
  });

  test("a rejected handshake is the client's error and is not reported", async () => {
    const reportError = mock();
    const app = createApp({
      isReady: () => true,
      jwtSecret: SECRET,
      rooms: createRoomManager(),
      tracker: createConnectionTracker(),
      metrics: snapshot,
      reportError,
    });

    const res = await app.request("/ws?token=not-a-jwt");

    expect(res.status).toBe(401);
    expect(reportError).not.toHaveBeenCalled();
  });

  test("a throwing WebSocket handler is reported with the event and the caller's ids, then rethrown", () => {
    const reportError = mock();
    const error = new Error("room registry corrupted");
    const claims = { userId: "user-1", schoolId: "school-1", role: "STUDENT" } as AuthClaims;

    expect(() =>
      monitored(reportError, "message", claims, () => {
        throw error;
      }),
    ).toThrow(error);
    expect(reportError).toHaveBeenCalledWith(error, {
      tags: { ws_event: "message", school_id: "school-1" },
      userId: "user-1",
    });
  });

  test("a handler that completes is not reported", () => {
    const reportError = mock();
    const claims = { userId: "user-1", schoolId: "school-1", role: "STUDENT" } as AuthClaims;

    monitored(reportError, "close", claims, () => undefined);

    expect(reportError).not.toHaveBeenCalled();
  });
});
