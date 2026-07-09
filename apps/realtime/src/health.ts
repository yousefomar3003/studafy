import { Hono } from "hono";

/**
 * Health endpoints, mirroring apps/api. Liveness (`/healthz`) reports that the process is alive;
 * readiness (`/readyz`) reflects whether the gateway should accept new connections — it reports
 * not-ready during shutdown so load balancers stop routing while open sockets drain.
 */
export function healthRoutes(isReady: () => boolean): Hono {
  const routes = new Hono();

  routes.get("/healthz", (c) => c.json({ status: "ok" }));

  routes.get("/readyz", (c) =>
    isReady() ? c.json({ status: "ready" }) : c.json({ status: "shutting_down" }, 503),
  );

  return routes;
}
