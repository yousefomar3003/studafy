import { Hono } from "hono";

/**
 * Health endpoints. Liveness (`/healthz`) reports that the process is alive; readiness
 * (`/readyz`) reflects whether the app should receive traffic — it reports not-ready during
 * shutdown so load balancers stop routing while in-flight requests drain.
 */
export function healthRoutes(isReady: () => boolean | Promise<boolean>): Hono {
  const routes = new Hono();

  routes.get("/healthz", (c) => c.json({ status: "ok" }));

  routes.get("/readyz", async (c) =>
    (await isReady()) ? c.json({ status: "ready" }) : c.json({ status: "shutting_down" }, 503),
  );

  return routes;
}
