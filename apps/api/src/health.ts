import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import { openApiValidationHook } from "./openapi/hook";
import { standardResponses } from "./openapi/responses";

import type { AppEnv } from "./middleware/requestId";

/**
 * Health endpoints. Liveness (`/healthz`) reports that the process is alive; readiness
 * (`/readyz`) reflects whether the app should receive traffic — it reports not-ready during
 * shutdown so load balancers stop routing while in-flight requests drain.
 */

const healthOkSchema = z.object({ status: z.literal("ok") }).openapi("HealthOk");

const readyOkSchema = z.object({ status: z.literal("ready") }).openapi("ReadyOk");

const readyDrainingSchema = z
  .object({ status: z.literal("shutting_down") })
  .openapi("ReadyDraining");

const healthzRoute = createRoute({
  method: "get",
  path: "/healthz",
  tags: ["Health"],
  operationId: "getLiveness",
  summary: "Liveness probe",
  description:
    "Reports that the process is alive. Answers unconditionally — it never checks a dependency, " +
    "because a liveness probe that fails on a downstream outage would have the orchestrator " +
    "restart a healthy process.",
  // Explicitly unauthenticated. Stated rather than inferred: this app has no authentication at all
  // yet, and an empty array says so where an omission would only imply it.
  security: [],
  responses: standardResponses(
    { 200: { description: "The process is alive.", schema: healthOkSchema } },
    [500],
  ),
});

const readyzRoute = createRoute({
  method: "get",
  path: "/readyz",
  tags: ["Health"],
  operationId: "getReadiness",
  summary: "Readiness probe",
  description:
    "Reports whether this instance should receive traffic. Answers 503 while draining so the load " +
    "balancer stops routing new requests before in-flight ones finish.",
  security: [],
  responses: standardResponses(
    {
      200: { description: "Ready for traffic.", schema: readyOkSchema },
      // A normal response, not a problem+json: draining is an expected state of a healthy process,
      // and the load balancer reads the status code. This is why standardResponses takes a map of
      // success shapes rather than a single one.
      503: {
        description: "Draining. The load balancer should stop routing here.",
        schema: readyDrainingSchema,
      },
    },
    [500],
  ),
});

/**
 * Returns an OpenAPIHono, not a Hono, and that is load-bearing: OpenAPIHono.route() silently ignores
 * a plain Hono sub-app's routes when merging OpenAPI definitions. Mounted as a plain Hono, these
 * endpoints would still serve traffic while contributing nothing to the document, with no error.
 */
export function healthRoutes(isReady: () => boolean | Promise<boolean>): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.openapi(healthzRoute, (c) => c.json({ status: "ok" } as const, 200));

  routes.openapi(readyzRoute, async (c) =>
    (await isReady())
      ? c.json({ status: "ready" } as const, 200)
      : c.json({ status: "shutting_down" } as const, 503),
  );

  return routes;
}
