import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { FEATURE_AUDIENCES, FEATURE_KEYS, FEATURE_USAGE_UNITS, FEATURES } from "@studafy/constants";
import { z } from "zod";

import { requireAuth } from "../../middleware/authContext";
import { standardResponses } from "../../openapi/responses";

import { defaultDisplayName } from "./catalog";
import { getFeatureService } from "./middleware";

import type { AppEnv } from "../../middleware/requestId";

/**
 * `GET /api/me/features`: the signed-in person's paid features, for the web and mobile apps to
 * show, hide or upsell a feature without probing its routes.
 *
 * Every registered feature is listed with its verdict -- active or not, why not, where it comes
 * from, this month's usage against the limit -- except a feature the super admin has hidden, which
 * is listed only to people who hold it. The verdict is the one requireFeature enforces: same
 * resolver, same cache.
 */

const GRANT_SOURCES = ["purchase", "school_license", "trial"] as const;
const FEATURE_REASONS = [
  "school_inactive",
  "paused",
  "not_included",
  "expired",
  "limit_reached",
] as const;

const FeatureGrantContributionSchema = z
  .object({
    source: z.enum(GRANT_SOURCES),
    tier: z.string().openapi({ description: "The tier's plan code." }),
    limit: z.number().int().nullable(),
    periodEnd: z.string().datetime(),
  })
  .openapi("FeatureGrantContribution");

const MyFeatureSchema = z
  .object({
    key: z.enum(FEATURE_KEYS as [string, ...string[]]),
    name: z.string().openapi({ description: "The display name the super admin set." }),
    nameKey: z.string().openapi({ description: "The i18n key of the display name." }),
    audience: z.enum(FEATURE_AUDIENCES),
    unit: z.enum(FEATURE_USAGE_UNITS).nullable(),
    active: z.boolean(),
    source: z.enum(GRANT_SOURCES).nullable().openapi({
      description: "The source of the latest-ending grant that covers the feature.",
    }),
    sources: z.array(FeatureGrantContributionSchema).openapi({
      description: "Every live grant that includes the feature, latest period end first.",
    }),
    limit: z.number().int().nullable().openapi({
      description: "Units per calendar month (UTC): the highest of the grants. Null is unlimited.",
    }),
    used: z.number().int().nonnegative().openapi({ description: "Units used this month." }),
    periodEnd: z.string().datetime().nullable(),
    reason: z
      .enum(FEATURE_REASONS)
      .nullable()
      .openapi({
        description:
          "Why the feature is not active, or limit_reached when it is active and this month's " +
          "limit is used up. Null when active and within the limit.",
      }),
  })
  .openapi("MyFeature");

const MyFeaturesResponseSchema = z
  .object({ features: z.array(MyFeatureSchema) })
  .openapi("MyFeaturesResponse");

const myFeaturesRoute = createRoute({
  method: "get",
  path: "/api/me/features",
  tags: ["Features"],
  operationId: "getMyFeatures",
  summary: "List the caller's paid features",
  description:
    "Returns every paid feature with the caller's verdict: whether it is active, why not " +
    "(school_inactive, paused, not_included, expired), the grants it comes from, and this month's " +
    "usage against the limit. The same verdict the feature's routes enforce.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The caller's features", schema: MyFeaturesResponseSchema } },
    [401],
  ),
});

export function featureRoutes(): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>();

  routes.openapi(myFeaturesRoute, async (c) => {
    const auth = requireAuth(c);
    const service = getFeatureService(c);
    const [features, catalog] = await Promise.all([
      service.resolveFeatures(auth.schoolId, auth.userId),
      service.catalog(),
    ]);

    const listed = FEATURE_KEYS.filter(
      (key) => catalog.settings[key]?.status !== "hidden" || features[key].active,
    ).map((key) => {
      const access = features[key];
      return {
        key,
        name: catalog.settings[key]?.displayName ?? defaultDisplayName(key),
        nameKey: FEATURES[key].nameKey,
        audience: FEATURES[key].audience,
        unit: FEATURES[key].unit,
        active: access.active,
        source: access.source,
        sources: access.sources.map((entry) => ({
          source: entry.source,
          tier: entry.tierCode,
          limit: entry.limit,
          periodEnd: entry.periodEnd,
        })),
        limit: access.limit,
        used: access.used,
        periodEnd: access.periodEnd,
        reason: access.reason,
      };
    });

    return c.json({ features: listed }, 200);
  });

  return routes;
}
