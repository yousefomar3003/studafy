import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";

import { countriesResponseSchema, currenciesResponseSchema } from "./schemas";
import { listCountries, listCurrencies } from "./service";

import type { Database } from "../../../db";
import type { AppEnv } from "../../../middleware/requestId";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getCountriesRoute = createRoute({
  method: "get",
  path: "/api/lookups/countries",
  tags: ["Lookups"],
  operationId: "getCountries",
  summary: "List active countries",
  description:
    "Public reference data. Returns every active row in app.countries, ordered by name. " +
    "Used to populate the country selector on the school self-registration form.",
  security: [],
  responses: standardResponses(
    { 200: { description: "Active countries.", schema: countriesResponseSchema } },
    [429, 500],
  ),
});

const getCurrenciesRoute = createRoute({
  method: "get",
  path: "/api/lookups/currencies",
  tags: ["Lookups"],
  operationId: "getCurrencies",
  summary: "List active currencies",
  description:
    "Public reference data. Returns every active row in app.currencies, ordered by name. " +
    "Used to populate the default-currency selector on the school self-registration form.",
  security: [],
  responses: standardResponses(
    { 200: { description: "Active currencies.", schema: currenciesResponseSchema } },
    [429, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route group factory
// ---------------------------------------------------------------------------

/**
 * Build the reference-data lookup route group.
 *
 * Public (no authentication), read-only. Requires a database. Exists so the public
 * registration form can populate `country_id` / `default_currency_id` with real UUIDs —
 * see apps/api/src/modules/tenancy/registration/schemas.ts.
 */
export function lookupsRoutes(db: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.openapi(getCountriesRoute, async (c) => {
    const countries = await listCountries(db);
    return c.json({ countries }, 200);
  });

  routes.openapi(getCurrenciesRoute, async (c) => {
    const currencies = await listCurrencies(db);
    return c.json({ currencies }, 200);
  });

  return routes;
}
