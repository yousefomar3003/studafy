/**
 * The ERPNext site agent's API (docs/plans/erpnext-fly.md, "Contract between the pieces").
 *
 * Called only by the agent on the ERPNext machine, over the private network, with the shared
 * `ERPNEXT_AGENT_TOKEN` as a bearer token. Mounted only when that token is configured (app.ts), so
 * a deployment without it answers 404. Platform scope: no user and no tenant -- service.ts reads
 * across schools the way the platform console does.
 *
 * Kept out of the OpenAPI document (`hide: true`) and so out of the generated clients: this is an
 * internal machine contract, not part of the public API. The routes are still OpenAPIHono routes, so
 * the bodies and path ids are validated by zod with the same problem+json errors as everywhere else.
 *
 * /api/internal/erpnext is in jwtAuth's and csrf's exemption lists: the token here is not a user JWT,
 * and there is no cookie for a cross-site page to ride on. The rate limiter classes it in
 * config/rateLimits.ts.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { secretsMatch } from "../../../lib/security/secret-compare";
import { auditAction } from "../../../middleware/auditEmitter";
import { openApiValidationHook } from "../../../openapi/hook";
import { requestIdHeaders, standardResponses } from "../../../openapi/responses";

import { applySiteTransition, listIdleSites, listPendingSites, listWakeSites } from "./service";

import type { SiteTransition } from "./service";
import type { Database, DatabasePools } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";

export const ERPNEXT_AGENT_BASE_PATH = "/api/internal/erpnext";

const siteIdParamSchema = z.object({
  id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
});

const pendingSiteSchema = z.object({
  id: z.uuid(),
  school_id: z.uuid(),
  site_name: z.string(),
  company_name: z.string(),
  company_abbr: z.string(),
  currency_code: z.string(),
  country_code: z.string(),
});

const siteRefSchema = z.object({ id: z.uuid(), site_name: z.string() });

const pendingListSchema = z.object({ sites: z.array(pendingSiteSchema) });
const siteRefListSchema = z.object({ sites: z.array(siteRefSchema) });

const failedBodySchema = z.object({ error: z.string().min(1).max(2000) });

// Not in the document, so these fields only describe the contract to a reader of this file.
const internal: { hide: true; tags: string[] } = { hide: true, tags: ["Internal"] };

const noContent = {
  204: { description: "Recorded.", headers: requestIdHeaders },
};

const pendingRoute = createRoute({
  ...internal,
  method: "get",
  path: "/api/internal/erpnext/sites/pending",
  operationId: "listErpNextPendingSites",
  summary: "Sites the agent should create",
  responses: standardResponses(
    { 200: { description: "Oldest first, at most 5.", schema: pendingListSchema } },
    [401, 429, 500],
  ),
});

const createdRoute = createRoute({
  ...internal,
  method: "post",
  path: "/api/internal/erpnext/sites/{id}/created",
  operationId: "reportErpNextSiteCreated",
  summary: "The agent created a site",
  request: { params: siteIdParamSchema },
  responses: { ...noContent, ...standardResponses({}, [400, 401, 404, 429, 500]) },
});

const failedRoute = createRoute({
  ...internal,
  method: "post",
  path: "/api/internal/erpnext/sites/{id}/failed",
  operationId: "reportErpNextSiteFailed",
  summary: "The agent failed to create a site",
  request: {
    params: siteIdParamSchema,
    body: { required: true, content: { "application/json": { schema: failedBodySchema } } },
  },
  responses: { ...noContent, ...standardResponses({}, [400, 401, 404, 429, 500]) },
});

const wakeRoute = createRoute({
  ...internal,
  method: "get",
  path: "/api/internal/erpnext/sites/wake",
  operationId: "listErpNextWakeSites",
  summary: "Sleeping sites to wake",
  responses: standardResponses(
    { 200: { description: "Sites to wake.", schema: siteRefListSchema } },
    [401, 429, 500],
  ),
});

const wokenRoute = createRoute({
  ...internal,
  method: "post",
  path: "/api/internal/erpnext/sites/{id}/woken",
  operationId: "reportErpNextSiteWoken",
  summary: "The agent enabled a site's scheduler",
  request: { params: siteIdParamSchema },
  responses: { ...noContent, ...standardResponses({}, [400, 401, 404, 429, 500]) },
});

const idleRoute = createRoute({
  ...internal,
  method: "get",
  path: "/api/internal/erpnext/sites/idle",
  operationId: "listErpNextIdleSites",
  summary: "Awake sites idle for 30 days",
  responses: standardResponses(
    { 200: { description: "Sites to put to sleep.", schema: siteRefListSchema } },
    [401, 429, 500],
  ),
});

const sleptRoute = createRoute({
  ...internal,
  method: "post",
  path: "/api/internal/erpnext/sites/{id}/slept",
  operationId: "reportErpNextSiteSlept",
  summary: "The agent disabled a site's scheduler",
  request: { params: siteIdParamSchema },
  responses: { ...noContent, ...standardResponses({}, [400, 401, 404, 429, 500]) },
});

export interface ErpNextAgentRoutesOptions {
  database: Database | DatabasePools;
  /** ERPNEXT_AGENT_TOKEN. The caller mounts these routes only when it is set. */
  token: string;
}

/** The bearer token of an `Authorization: Bearer <token>` header, or undefined. */
function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return undefined;
  return rest.join(" ").trim() || undefined;
}

export function erpNextAgentRoutes({
  database,
  token,
}: ErpNextAgentRoutesOptions): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Authenticate before anything else, validation included: an unauthenticated caller learns
  // nothing about the shapes these routes accept. Constant time (QA-092).
  routes.use(`${ERPNEXT_AGENT_BASE_PATH}/*`, async (c, next) => {
    if (!secretsMatch(bearerToken(c.req.header("Authorization")), token)) {
      c.get("log")?.warn({ reason: "erpnext_agent_token" }, "authentication failed");
      throw new CodedHttpException(401, ERROR_CODES.AUTH_TOKEN_INVALID, "Invalid agent token");
    }
    await next();
  });

  // Each report updates the school's site row and writes an audit row in that school (service.ts).
  routes.use(
    "/api/internal/erpnext/sites/:id/created",
    auditAction("update", "erpnext_site_configs"),
  );
  routes.use(
    "/api/internal/erpnext/sites/:id/failed",
    auditAction("update", "erpnext_site_configs"),
  );
  routes.use(
    "/api/internal/erpnext/sites/:id/woken",
    auditAction("update", "erpnext_site_configs"),
  );
  routes.use(
    "/api/internal/erpnext/sites/:id/slept",
    auditAction("update", "erpnext_site_configs"),
  );

  const report = async (
    id: string,
    transition: SiteTransition,
    meta: { requestId: string; userAgent: string | undefined },
    error?: string,
  ): Promise<void> => {
    const found = await applySiteTransition(database, id, transition, { ...meta, error });
    if (!found) {
      throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Site not found");
    }
  };

  routes.openapi(pendingRoute, async (c) =>
    c.json({ sites: await listPendingSites(database) }, 200),
  );

  routes.openapi(wakeRoute, async (c) => c.json({ sites: await listWakeSites(database) }, 200));

  routes.openapi(idleRoute, async (c) => c.json({ sites: await listIdleSites(database) }, 200));

  routes.openapi(createdRoute, async (c) => {
    const { id } = c.req.valid("param");
    await report(id, "created", {
      requestId: c.get("requestId"),
      userAgent: c.req.header("user-agent"),
    });
    return c.body(null, 204);
  });

  routes.openapi(failedRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { error } = c.req.valid("json");
    await report(
      id,
      "failed",
      { requestId: c.get("requestId"), userAgent: c.req.header("user-agent") },
      error,
    );
    return c.body(null, 204);
  });

  routes.openapi(wokenRoute, async (c) => {
    const { id } = c.req.valid("param");
    await report(id, "woken", {
      requestId: c.get("requestId"),
      userAgent: c.req.header("user-agent"),
    });
    return c.body(null, 204);
  });

  routes.openapi(sleptRoute, async (c) => {
    const { id } = c.req.valid("param");
    await report(id, "slept", {
      requestId: c.get("requestId"),
      userAgent: c.req.header("user-agent"),
    });
    return c.body(null, 204);
  });

  return routes;
}
