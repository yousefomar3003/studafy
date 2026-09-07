import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";

import { mobileReleaseConfigSchema } from "./schemas";

import type { MobileReleaseConfig } from "./schemas";
import type { AppEnv } from "../../middleware/requestId";

const getMobileReleaseConfigRoute = createRoute({
  method: "get",
  path: "/api/mobile/config",
  tags: ["Mobile"],
  operationId: "getMobileReleaseConfig",
  summary: "Mobile release floor and latest versions",
  description:
    "The version floor the native app enforces against itself on launch and resume: a build below " +
    "`minimum_supported_version` for its platform shows a blocking forced-update screen and cannot " +
    "proceed. Unauthenticated and un-scoped — the app calls it before a session exists — and the " +
    "same response for every caller. Values come from this service's environment " +
    "(`MOBILE_MIN_SUPPORTED_VERSION_*` / `MOBILE_LATEST_VERSION_*`); an unset one reads as `0.0.0`.",
  // Explicitly unauthenticated, stated not implied — same posture as the health probes and the
  // pre-signup reference-data lookups. `/api/mobile/config` is in jwtAuth.ts's DEFAULT_PUBLIC_PATHS.
  security: [],
  responses: standardResponses(
    {
      200: {
        description: "The current floor and latest version for each store platform.",
        schema: mobileReleaseConfigSchema,
      },
    },
    [500],
  ),
});

/**
 * Mobile release lane support (ST-257): the forced-update floor endpoint.
 *
 * A pure echo of the configured versions — the ordering comparison ("is this build below the
 * floor?") is the client's, in `apps/mobile/lib/src/core/update`, because that is the side holding
 * a version to test. Mounted unconditionally like the health routes: the published contract does
 * not depend on whether a deployment has set the variables, and an unset variable is a valid
 * state (`0.0.0`, i.e. "no floor"), not a missing one.
 *
 * Operational note: raising the floor is an environment change on this service, never an app
 * release. See docs/runbooks/mobile-release.md#forced-update-floor.
 */
export function mobileConfigRoutes(config: MobileReleaseConfig): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.openapi(getMobileReleaseConfigRoute, (c) => c.json(config, 200));

  return routes;
}
