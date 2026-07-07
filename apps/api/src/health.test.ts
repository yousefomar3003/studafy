// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createApp } from "./app";
import { createInflightTracker } from "./lifecycle";

const buildApp = (isReady: () => boolean) =>
  createApp({ isReady, tracker: createInflightTracker() });

describe("health routes", () => {
  test("GET /healthz returns 200 ok", async () => {
    const res = await buildApp(() => true).request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("GET /readyz returns 200 ready when the app is ready", async () => {
    const res = await buildApp(() => true).request("/readyz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready" });
  });

  test("GET /readyz returns 503 shutting_down when the app is not ready", async () => {
    const res = await buildApp(() => false).request("/readyz");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "shutting_down" });
  });
});
