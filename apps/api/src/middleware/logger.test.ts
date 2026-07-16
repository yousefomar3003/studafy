// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { createApp } from "../app";
import { createInflightTracker } from "../lifecycle";
import { createLogger } from "../logger";

import type { AppEnv } from "./requestId";

const buildApp = (routes?: (app: Hono<AppEnv>) => void) => {
  const lines: string[] = [];
  const app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: (line) => lines.push(line) }),
  });
  routes?.(app);
  return { app, lines };
};

const records = (lines: string[]): Record<string, unknown>[] =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>);

describe("logger middleware", () => {
  test("logs request received for non-health routes", async () => {
    const { app, lines } = buildApp((a) => {
      a.get("/api/test", (c) => c.json({ ok: true }));
    });

    await app.request("/api/test");

    const received = records(lines).filter((record) => record.msg === "request received");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      method: "GET",
      path: "/api/test",
    });
  });

  test("does not log health check routes", async () => {
    const { app, lines } = buildApp();

    await app.request("/healthz");

    const received = records(lines).filter((record) => record.msg === "request received");
    expect(received).toHaveLength(0);
  });

  test("includes user agent in request logs", async () => {
    const { app, lines } = buildApp((a) => {
      a.get("/api/test", (c) => c.json({ ok: true }));
    });

    await app.request("/api/test", {
      headers: { "User-Agent": "TestClient/1.0" },
    });

    const received = records(lines).filter((record) => record.msg === "request received");
    expect(received[0]).toMatchObject({
      user_agent: "TestClient/1.0",
    });
  });

  test("includes accept language in request logs", async () => {
    const { app, lines } = buildApp((a) => {
      a.get("/api/test", (c) => c.json({ ok: true }));
    });

    await app.request("/api/test", {
      headers: { "Accept-Language": "ar,en;q=0.9" },
    });

    const received = records(lines).filter((record) => record.msg === "request received");
    expect(received[0]).toMatchObject({
      accept_language: "ar,en;q=0.9",
    });
  });

  test("includes query parameters in request logs", async () => {
    const { app, lines } = buildApp((a) => {
      a.get("/api/test", (c) => c.json({ ok: true }));
    });

    await app.request("/api/test?page=1&limit=10");

    const received = records(lines).filter((record) => record.msg === "request received");
    expect(received[0]).toMatchObject({
      query: { page: "1", limit: "10" },
    });
  });
});
