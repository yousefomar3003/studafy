import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import { openApiValidationHook } from "./openapi/hook";
import { standardResponses } from "./openapi/responses";

import type { AppEnv } from "./middleware/requestId";

/**
 * Health endpoints. Liveness (`/healthz`) reports that the process is alive; readiness
 * (`/readyz`) reflects whether the app should receive traffic — it reports not-ready during
 * shutdown so load balancers stop routing while in-flight requests drain; AI health
 * (`/api/ai/health`) reports whether the LLM gateway's `AI_LLM_ENABLED` kill switch is on, for the
 * public status page's `ai` component to have an automatic signal at all (ST-264).
 */

const healthOkSchema = z.object({ status: z.literal("ok") }).openapi("HealthOk");

const readyOkSchema = z.object({ status: z.literal("ready") }).openapi("ReadyOk");

const readyDrainingSchema = z
  .object({ status: z.literal("shutting_down") })
  .openapi("ReadyDraining");

const aiHealthOkSchema = z
  .object({ status: z.literal("ok"), enabled: z.boolean() })
  .openapi("AiHealthOk");

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

const aiHealthRoute = createRoute({
  method: "get",
  path: "/api/ai/health",
  tags: ["Health"],
  operationId: "getAiHealth",
  summary: "AI subsystem health",
  description:
    "Reports whether the LLM gateway's AI_LLM_ENABLED kill switch is on for this deployment. " +
    "Deliberately does NOT call Anthropic — a real completion request on every probe cycle would " +
    "be a meaningful, pointless cost for a once-a-minute check, and would answer a different " +
    "question (is the provider up) than this route asks (is the feature even switched on). " +
    "Provider-level outages are detected the way docs/runbooks/ai-provider-outage.md already " +
    "describes (retry/circuit-breaker logs, Anthropic's own status page), not by this endpoint. " +
    "Its purpose is narrower: give the public status page's `ai` component the same shape of " +
    "black-box GET the other four components already have (infra/terraform/modules/monitoring's " +
    "synthetics.tf), rather than leaving it the one component nothing ever checks.",
  // Explicitly unauthenticated, same posture as /healthz and /api/mobile/config: a black-box probe
  // has no session to bear a token, and the published contract should not depend on whether a
  // deployment has AI enabled at all. /api/ai/health is in jwtAuth.ts's DEFAULT_PUBLIC_PATHS.
  security: [],
  responses: standardResponses(
    {
      200: {
        description: "The process is alive and answering for this route.",
        schema: aiHealthOkSchema,
      },
    },
    [500],
  ),
});

/**
 * Returns an OpenAPIHono, not a Hono, and that is load-bearing: OpenAPIHono.route() silently ignores
 * a plain Hono sub-app's routes when merging OpenAPI definitions. Mounted as a plain Hono, these
 * endpoints would still serve traffic while contributing nothing to the document, with no error.
 *
 * `aiLlmEnabled` is `aiLlmProvider !== null` at the call site (app.ts) — the same boolean the
 * gateway routes already derive from `AppOptions.aiLlmProvider` to decide 503 AI_LLM_DISABLED vs.
 * serving a request. Read here rather than threaded as a second, separate option, so there is one
 * place ("is the provider constructed") this fact can ever disagree with itself.
 */
export function healthRoutes(
  isReady: () => boolean | Promise<boolean>,
  aiLlmEnabled: boolean,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.openapi(healthzRoute, (c) => c.json({ status: "ok" } as const, 200));

  routes.openapi(readyzRoute, async (c) =>
    (await isReady())
      ? c.json({ status: "ready" } as const, 200)
      : c.json({ status: "shutting_down" } as const, 503),
  );

  routes.openapi(aiHealthRoute, (c) =>
    c.json({ status: "ok" as const, enabled: aiLlmEnabled }, 200),
  );

  return routes;
}
