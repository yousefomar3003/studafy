import { Hono } from "hono";

import { healthRoutes } from "./health";

import type { InflightTracker } from "./lifecycle";

export interface AppOptions {
  isReady: () => boolean;
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

  app.route("/", healthRoutes(isReady));

  return app;
}
