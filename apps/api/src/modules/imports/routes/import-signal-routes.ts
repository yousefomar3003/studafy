import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import { unmappedHeaderSignalSchema } from "../schemas";
import { unmappedHeaderSignal } from "../signal-service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";

const unmappedHeaderSignalRoute = createRoute({
  method: "get",
  path: "/api/platform/import-signals/unmapped-headers",
  tags: ["Platform"],
  operationId: "getUnmappedImportHeaderSignal",
  summary: "Unmapped import headers across schools",
  description:
    "Which column headers schools' student imports bring that no Studafy field reads, normalized " +
    "and counted across schools. Header text and counts only: no cell value, no school name, and " +
    "a header only once min_schools schools have brought it.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The signal.", schema: unmappedHeaderSignalSchema } },
    [401, 403, 500],
  ),
});

/** The platform console's read of student-import product signal (docs/modules/student-import-mapping-guide.md). */
export function importSignalRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/platform/import-signals/*", requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/platform/import-signals/*", requirePermission(PERMISSIONS.PLATFORM_READ));

  routes.openapi(unmappedHeaderSignalRoute, async (c) => {
    const signal = await unmappedHeaderSignal(database, c.get("requestId"));
    return c.json(signal, 200);
  });

  return routes;
}
