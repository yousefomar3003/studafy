import { Hono } from "hono";

import type { FanoutMetrics } from "./metrics";

/**
 * Health and metrics endpoints, mirroring apps/api. Liveness (`/healthz`) reports that the
 * process is alive; readiness (`/readyz`) reflects whether the gateway should accept new
 * connections — it reports not-ready during shutdown so load balancers stop routing while open
 * sockets drain. `/metrics` exposes the outbox fan-out counters (src/metrics.ts) as JSON — the
 * same plain-counter convention apps/workers uses, with no external metrics library.
 */
export function healthRoutes(isReady: () => boolean, metrics: () => FanoutMetrics): Hono {
  const routes = new Hono();

  routes.get("/healthz", (c) => c.json({ status: "ok" }));

  routes.get("/readyz", (c) =>
    isReady() ? c.json({ status: "ready" }) : c.json({ status: "shutting_down" }, 503),
  );

  routes.get("/metrics", (c) => c.json(metrics()));

  return routes;
}
