import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";

import { mobileReleaseConfigSchema } from "./schemas";

import type { MobileReleaseConfig } from "./schemas";
import type { AppEnv } from "../../middleware/requestId";

/**
 * Both mounted paths answer with the identical schema and handler — one route shape, two names.
 * `operationId` is suffixed per path so the generated OpenAPI document (and any client generated
 * from it) keeps distinct, unambiguous operation names for the two.
 */
function buildMobileReleaseConfigRoute(path: "/api/mobile/config" | "/meta/mobile-versions") {
  const isCanonical = path === "/meta/mobile-versions";

  return createRoute({
    method: "get",
    path,
    tags: ["Mobile"],
    operationId: isCanonical ? "getMobileVersions" : "getMobileReleaseConfig",
    summary: "Mobile release floor and latest versions",
    description:
      "The version floor the native app enforces against itself on launch and resume: a build below " +
      "`minimum_supported_version` for its platform shows a blocking forced-update screen and cannot " +
      "proceed. Unauthenticated and un-scoped — the app calls it before a session exists — and the " +
      "same response for every caller. Values come from this service's environment " +
      "(`MOBILE_MIN_SUPPORTED_VERSION_*` / `MOBILE_LATEST_VERSION_*`); an unset one reads as `0.0.0`." +
      (isCanonical
        ? ""
        : " Also served at `/meta/mobile-versions` (ST-283), the canonical name for this same data; " +
          "kept here unchanged because the released native app already calls this path."),
    // Explicitly unauthenticated, stated not implied — same posture as the health probes and the
    // pre-signup reference-data lookups. Both paths are in jwtAuth.ts's DEFAULT_PUBLIC_PATHS.
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
}

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
 *
 * Also mounted at `/meta/mobile-versions` (ST-283) — the canonical name asked for by that ticket,
 * added as an alias rather than a rename because the already-released native app calls
 * `/api/mobile/config` (see `apps/mobile/lib/src/core/update/update_config_client.dart`); breaking
 * that path would strand any build that cannot reach the floor endpoint that tells it to update.
 * Same handler, same schema, no duplicated logic — the two paths are just two names for one route.
 */
export function mobileConfigRoutes(config: MobileReleaseConfig): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.openapi(buildMobileReleaseConfigRoute("/api/mobile/config"), (c) => c.json(config, 200));
  routes.openapi(buildMobileReleaseConfigRoute("/meta/mobile-versions"), (c) =>
    c.json(config, 200),
  );

  return routes;
}
