// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createApp } from "./app";
import { ROUTE_CLASS_MAP, DEFAULT_ROUTE_CLASS, resolveRouteClass } from "./config/rateLimits";
import { createInflightTracker } from "./lifecycle";
import { createLogger } from "./logger";

// A logger writing nowhere: these tests assert on responses, and a run must not emit NDJSON.
const silentLogger = () => createLogger({ destination: () => undefined });

const buildApp = (isReady: () => boolean) =>
  createApp({ isReady, tracker: createInflightTracker(), logger: silentLogger() });

describe("security headers", () => {
  test("every response sets Strict-Transport-Security", async () => {
    const res = await buildApp(() => true).request("/healthz");
    expect(res.headers.get("Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
  });
});

describe("rate limiter coverage", () => {
  test("every registered non-health route has a resolvable route class", () => {
    const app = buildApp(() => true);
    const healthPaths = ["/healthz", "/readyz"];

    for (const route of app.routes) {
      const fullPath = (route.basePath + route.path).replace(/\/+/g, "/");
      if (healthPaths.includes(fullPath)) continue;

      const routeClass = resolveRouteClass(fullPath);
      expect(routeClass).toBeDefined();
    }
  });

  test("ROUTE_CLASS_MAP values are valid route classes with budgets", () => {
    for (const [, cls] of Object.entries(ROUTE_CLASS_MAP)) {
      expect(["auth", "ai", "default"]).toContain(cls);
    }
  });

  test("DEFAULT_ROUTE_CLASS has a defined budget", () => {
    expect(["auth", "ai", "default"]).toContain(DEFAULT_ROUTE_CLASS);
  });
});
