import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { FEATURE_AUDIENCES, FEATURE_KEYS, FEATURE_USAGE_UNITS, FEATURES } from "@studafy/constants";
import { z } from "zod";

import { requireAuth } from "../../middleware/authContext";
import { standardResponses } from "../../openapi/responses";

import { defaultDisplayName } from "./catalog";
import { schoolOffersFeature } from "./license-context";
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

const FeatureRenewalStopSchema = z
  .object({
    provider: z.string().nullable().openapi({
      description: "app_store, google_play, tap or stripe; null when it could not be told.",
    }),
    action: z.enum(["cancel_at_period_end", "notify_user"]).openapi({
      description:
        "cancel_at_period_end: Studafy turned renewal off. notify_user: the App Store does not " +
        "let a server do it, so the person must turn renewal off in their Apple ID settings.",
    }),
    status: z.string(),
  })
  .openapi("FeatureRenewalStop");

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
    schoolSeat: z.boolean().openapi({
      description:
        "The caller holds a seat of this feature's audience on the school's license in force. A " +
        "seat holder is never offered a personal purchase.",
    }),
    schoolOffers: z.boolean().openapi({
      description:
        "The school's license in force sells seats of this feature's audience whose tier " +
        "includes it: an uncovered person should ask the school for a seat, not buy it.",
    }),
    renewalStop: FeatureRenewalStopSchema.nullable().openapi({
      description:
        "The personal subscription of this feature's audience whose renewal the caller's seat " +
        "turned off (it runs to its period end, then the seat carries on), or null.",
    }),
  })
  .openapi("MyFeature");

const MyFeaturesResponseSchema = z
  .object({
    schoolName: z.string().openapi({ description: 'For "Provided by <school>".' }),
    features: z.array(MyFeatureSchema),
  })
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
    "usage against the limit -- the same verdict the feature's routes enforce -- plus what the " +
    "school's license means for it: whether the caller holds a seat, whether the school sells one " +
    "that includes it, and a personal renewal the seat turned off.",
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
    const [features, catalog, license] = await Promise.all([
      service.resolveFeatures(auth.schoolId, auth.userId),
      service.catalog(),
      service.licenseContext(auth.schoolId, [auth.userId]),
    ]);
    const seated = new Set(license.seats[auth.userId] ?? []);
    const stops = license.renewalStops[auth.userId] ?? [];

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
        schoolSeat: seated.has(FEATURES[key].audience),
        schoolOffers: schoolOffersFeature(catalog, license.offeredTiers, key),
        renewalStop: (() => {
          const stop = stops.find((s) => s.audience === FEATURES[key].audience);
          return stop
            ? { provider: stop.provider, action: stop.action, status: stop.status }
            : null;
        })(),
      };
    });

    return c.json({ schoolName: license.schoolName, features: listed }, 200);
  });

  return routes;
}
