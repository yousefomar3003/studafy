import { Hono } from "hono";

import { healthRoutes } from "./health";

import type { InflightTracker } from "./lifecycle";

export interface AppOptions {
  isReady: () => boolean | Promise<boolean>;
  tracker: InflightTracker;
}

/**
 * Build the Hono application. It is deliberately free of any port binding so it can be exercised
 * directly via `app.request(...)` in tests. Every request is counted by the in-flight tracker so
 * shutdown can drain active work.
 */
export function createApp({ isReady, tracker }: AppOptions): Hono {
  const app = new Hono();

  app.use("*", async (_c, next) => {
    tracker.begin();
    try {
      await next();
    } finally {
      tracker.end();
    }
  });

  // The ALB in front of this service (infra/terraform/modules/edge) terminates TLS and forwards
  // plaintext to us; its listener actions can't inject response headers, so HSTS has to be set
  // here or nowhere. See docs/runbooks/edge-security.md.
  app.use("*", async (c, next) => {
    await next();
    c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  });

  app.route("/", healthRoutes(isReady));

  return app;
}
