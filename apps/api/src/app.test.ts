// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createApp } from "./app";
import {
  RATE_LIMIT_EXEMPT_PATHS,
  ROUTE_CLASS_MAP,
  DEFAULT_ROUTE_CLASS,
  resolveRouteClass,
} from "./config/rateLimits";
import { createInflightTracker } from "./lifecycle";
import { createLogger } from "./logger";

// A logger writing nowhere: these tests assert on responses, and a run must not emit NDJSON.
const silentLogger = () => createLogger({ destination: () => undefined });

const buildApp = (isReady: () => boolean) =>
  createApp({ isReady, tracker: createInflightTracker(), logger: silentLogger() });

describe("security headers", () => {
  // The full matrix is asserted in tests/security/security-headers.test.ts. This case stays here
  // because it is the wiring check: it fails if securityHeadersMiddleware is ever dropped from
  // createApp, which is the regression docs/runbooks/edge-security.md depends on not happening.
  test("every response sets Strict-Transport-Security", async () => {
    const res = await buildApp(() => true).request("/healthz");
    expect(res.headers.get("Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
  });
});

describe("realtime handoff on fly.io", () => {
  test("/ws answers with a fly-replay to the realtime app when one is named", async () => {
    const app = createApp({
      isReady: () => true,
      tracker: createInflightTracker(),
      logger: silentLogger(),
      realtimeFlyApp: "studafy-core-realtime",
    });
    const res = await app.request("/ws?token=t");
    expect(res.headers.get("fly-replay")).toBe("app=studafy-core-realtime");
  });

  test("/ws is not a route when no realtime app is named", async () => {
    const res = await buildApp(() => true).request("/ws");
    expect(res.headers.get("fly-replay")).toBeNull();
    expect(res.status).toBe(404);
  });
});

describe("rate limiter coverage", () => {
  test("every registered non-health route has a resolvable route class", () => {
    const app = buildApp(() => true);

    for (const route of app.routes) {
      const fullPath = (route.basePath + route.path).replace(/\/+/g, "/");
      if (RATE_LIMIT_EXEMPT_PATHS.includes(fullPath)) continue;

      const routeClass = resolveRouteClass(fullPath);
      expect(routeClass).toBeDefined();
    }
  });

  test("ROUTE_CLASS_MAP values are valid route classes with budgets", () => {
    for (const [, cls] of Object.entries(ROUTE_CLASS_MAP)) {
      expect(["auth", "auth-strict", "ai", "default"]).toContain(cls);
    }
  });

  test("DEFAULT_ROUTE_CLASS has a defined budget", () => {
    expect(["auth", "auth-strict", "ai", "default"]).toContain(DEFAULT_ROUTE_CLASS);
  });
});
