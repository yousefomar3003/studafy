import { OpenAPIHono } from "@hono/zod-openapi";

import { openApiValidationHook } from "../../../openapi/hook";

import { categoryRoutes } from "./routes/category-routes";
import { schemeRoutes } from "./routes/scheme-routes";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";

export function gradebookConfigRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.route("/", categoryRoutes(database));
  routes.route("/", schemeRoutes(database));

  return routes;
}
