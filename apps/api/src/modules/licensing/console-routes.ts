import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { FEATURE_KEYS, FEATURE_USAGE_UNITS, PERMISSIONS } from "@studafy/constants";

import { withSystemTx } from "../../db/tenant-tx";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { requireChannel } from "../../middleware/channelGuard";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";
import { AUTH_CHANNELS } from "../auth/channels";

import { paymentSchema } from "./billing-schemas";
import {
  FEATURE_STATUSES,
  createTier,
  listChangeRequestsAcrossSchools,
  listConsoleFeatures,
  listLicensesAcrossSchools,
  listTiers,
  schoolLicenseConsole,
  updateConsoleFeature,
  updateTier,
  usageAndRevenue,
} from "./console";
import {
  audienceSchema,
  changeRequestListQuerySchema,
  changeRequestSchema,
  featureUsageSchema,
  licenseStatusSchema,
  platformLicenseSchema,
  platformSchoolParamsSchema,
} from "./schemas";
import { readInSchool } from "./service";

import type { LicenseActor } from "./context";
import type { LicensingDeps } from "./service";
import type { SupportedLocale } from "../../middleware/locale";
import type { AppEnv } from "../../middleware/requestId";
import type { FeatureKey } from "@studafy/constants";
import type { Context } from "hono";

/**
 * The super admin console's catalog and cross-school reads (session 4 of
 * docs/billing/feature-licensing.md): features, tiers with features and prices, every school's
 * licenses and change requests, a school's license overview, and usage next to license revenue.
 * SUPER_ADMIN only (platform:read / platform:manage), web channel only.
 */

const TAG = "Platform";

const featureKeySchema = z
  .enum(FEATURE_KEYS as [FeatureKey, ...FeatureKey[]])
  .openapi("FeatureKey");
const featureStatusSchema = z.enum(FEATURE_STATUSES).openapi("FeatureStatus");
const unitSchema = z.enum(FEATURE_USAGE_UNITS).openapi("FeatureUsageUnit");

const consoleFeatureSchema = z
  .object({
    key: featureKeySchema,
    displayName: z.string(),
    status: featureStatusSchema,
    audience: audienceSchema,
    unit: unitSchema.nullable(),
    defaultMonthlyLimit: z.number().int().nullable(),
    nameKey: z.string(),
    tierCount: z.number().int(),
  })
  .openapi("ConsoleFeature");

const featureListSchema = z
  .object({ features: z.array(consoleFeatureSchema) })
  .openapi("ConsoleFeatureList");

const featureParamsSchema = z.object({
  featureKey: featureKeySchema.openapi({ param: { name: "featureKey", in: "path" } }),
});

const featurePatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100).optional(),
    status: featureStatusSchema.optional(),
  })
  .openapi("ConsoleFeaturePatch");

const tierFeatureSchema = z
  .object({ key: featureKeySchema, monthlyLimit: z.number().int().positive().nullable() })
  .openapi("ConsoleTierFeature");

const tierPriceSchema = z
  .object({
    currencyCode: z.string(),
    minorUnit: z.number().int(),
    amountMinor: z.number().int(),
    isActive: z.boolean(),
  })
  .openapi("ConsoleTierPrice");

const tierSchema = z
  .object({
    id: z.string().uuid(),
    code: z.string(),
    displayName: z.string(),
    description: z.string().nullable(),
    audience: audienceSchema,
    rank: z.number().int(),
    includesAllFeatures: z.boolean(),
    isActive: z.boolean(),
    features: z.array(tierFeatureSchema),
    prices: z.array(tierPriceSchema),
    inUse: z.number().int(),
  })
  .openapi("ConsoleTier");

const tierListSchema = z.object({ tiers: z.array(tierSchema) }).openapi("ConsoleTierList");

const tierPriceInputSchema = z
  .object({
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    amountMinor: z.number().int().min(0).max(100_000_000),
  })
  .openapi("ConsoleTierPriceInput");

const tierBodyShape = {
  displayName: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500).nullable().optional(),
  rank: z.number().int().min(1).max(100),
  includesAllFeatures: z.boolean(),
  isActive: z.boolean().optional(),
  features: z.array(tierFeatureSchema).max(50),
  prices: z.array(tierPriceInputSchema).max(20),
};

const createTierBodySchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/),
    audience: audienceSchema,
    ...tierBodyShape,
  })
  .openapi("ConsoleCreateTierBody");

const updateTierBodySchema = z.object(tierBodyShape).openapi("ConsoleUpdateTierBody");

const tierParamsSchema = z.object({
  planId: z
    .string()
    .uuid()
    .openapi({ param: { name: "planId", in: "path" } }),
});

const licenseListQuerySchema = z.object({
  status: licenseStatusSchema.optional(),
  expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  seatsNearlyFull: z.coerce.number().min(0).max(1).optional(),
  // An explicit enum rather than z.coerce.boolean(): Boolean("false") is true.
  unpaid: z.enum(["true", "false"]).optional(),
});

const consoleLicenseSchema = platformLicenseSchema
  .extend({
    schoolName: z.string(),
    balanceMinor: z.number().int(),
    minorUnit: z.number().int(),
    daysLeft: z.number().int(),
    seatUse: z.number(),
  })
  .openapi("ConsoleLicense");

const consoleLicenseListSchema = z
  .object({ licenses: z.array(consoleLicenseSchema) })
  .openapi("ConsoleLicenseList");

const consoleChangeRequestListSchema = z
  .object({
    requests: z.array(
      changeRequestSchema
        .extend({ schoolId: z.string().uuid(), schoolName: z.string() })
        .openapi("ConsoleChangeRequest"),
    ),
  })
  .openapi("ConsoleChangeRequestList");

const historyEntrySchema = z
  .object({
    id: z.string().uuid(),
    action: z.string(),
    targetTable: z.string(),
    targetId: z.string().uuid(),
    actorId: z.string().uuid().nullable(),
    oldValues: z.record(z.string(), z.unknown()).nullable(),
    newValues: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("LicenseHistoryEntry");

const schoolLicenseConsoleSchema = z
  .object({
    license: platformLicenseSchema.nullable(),
    usage: z.array(featureUsageSchema),
    payments: z.array(paymentSchema),
    history: z.array(historyEntrySchema),
  })
  .openapi("SchoolLicenseConsole");

const usageRevenueSchema = z
  .object({
    periodStart: z.string(),
    schools: z.array(
      z
        .object({
          schoolId: z.string().uuid(),
          schoolName: z.string(),
          usage: z.array(
            z
              .object({
                feature: featureKeySchema,
                unit: unitSchema.nullable(),
                used: z.number().int(),
              })
              .openapi("ConsoleFeatureUnits"),
          ),
          revenue: z.array(
            z
              .object({
                currencyCode: z.string(),
                minorUnit: z.number().int(),
                thisMonthMinor: z.number().int(),
                totalMinor: z.number().int(),
              })
              .openapi("ConsoleLicenseRevenue"),
          ),
        })
        .openapi("ConsoleSchoolUsageRevenue"),
    ),
  })
  .openapi("ConsoleUsageRevenue");

// ---------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------

const listFeaturesRoute = createRoute({
  method: "get",
  path: "/api/platform/features",
  operationId: "platformListFeatures",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Every registered paid feature",
  description:
    "Display name and status (the super admin's), audience, unit and default limit (code's).",
  responses: standardResponses(
    { 200: { description: "Features", schema: featureListSchema } },
    [401, 403],
  ),
});

const updateFeatureRoute = createRoute({
  method: "patch",
  path: "/api/platform/features/{featureKey}",
  operationId: "platformUpdateFeature",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Rename a feature or change its status",
  description:
    "`paused` refuses everyone (the kill switch); `hidden` is not listed but keeps working for " +
    "holders. Reaches every pod within the catalog cache's 30 seconds.",
  request: {
    params: featureParamsSchema,
    body: { required: true, content: { "application/json": { schema: featurePatchSchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The feature", schema: consoleFeatureSchema } },
    [400, 401, 403, 404],
  ),
});

const listTiersRoute = createRoute({
  method: "get",
  path: "/api/platform/tiers",
  operationId: "platformListTiers",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Feature tiers with their features, limits and monthly seat prices",
  responses: standardResponses(
    { 200: { description: "Tiers", schema: tierListSchema } },
    [401, 403],
  ),
});

const createTierRoute = createRoute({
  method: "post",
  path: "/api/platform/tiers",
  operationId: "platformCreateTier",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Create a tier",
  description:
    "A tier of one audience: rank (unique among the audience's active tiers), features with monthly " +
    "limits (null is unlimited), `includesAllFeatures`, and a monthly seat price per currency. 409 " +
    "when the code or rank is taken; 422 LICENSE_TIER_INVALID for a feature of another audience.",
  request: {
    body: { required: true, content: { "application/json": { schema: createTierBodySchema } } },
  },
  responses: standardResponses(
    { 201: { description: "The tier", schema: tierSchema } },
    [400, 401, 403, 409, 422],
  ),
});

const updateTierRoute = createRoute({
  method: "put",
  path: "/api/platform/tiers/{planId}",
  operationId: "platformUpdateTier",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Replace a tier's settings, features and prices",
  description:
    "Code and audience stay. A currency left out of `prices` is switched off, not deleted. Changes " +
    "reach every license and subscription on the tier.",
  request: {
    params: tierParamsSchema,
    body: { required: true, content: { "application/json": { schema: updateTierBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The tier", schema: tierSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

const listLicensesRoute = createRoute({
  method: "get",
  path: "/api/platform/licenses",
  operationId: "platformListAllLicenses",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Licenses across schools",
  description:
    "Filters: `status`; `expiringWithinDays` (active, ending within that many days); " +
    "`seatsNearlyFull` (some audience at or above that share of its seats, 0-1); `unpaid=true` " +
    "(an open invoice balance).",
  request: { query: licenseListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Licenses", schema: consoleLicenseListSchema } },
    [400, 401, 403],
  ),
});

const listChangeRequestsRoute = createRoute({
  method: "get",
  path: "/api/platform/licenses/change-requests",
  operationId: "platformListAllLicenseChangeRequests",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Seat change requests from every school, oldest first",
  request: { query: changeRequestListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Requests", schema: consoleChangeRequestListSchema } },
    [400, 401, 403],
  ),
});

const usageRevenueRoute = createRoute({
  method: "get",
  path: "/api/platform/licenses/usage",
  operationId: "platformLicenseUsageRevenue",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Feature usage this month per school, next to license revenue",
  responses: standardResponses(
    { 200: { description: "Usage and revenue", schema: usageRevenueSchema } },
    [401, 403],
  ),
});

const schoolConsoleRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/license-console",
  operationId: "platformGetSchoolLicenseConsole",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "A school's license, usage, payments and licensing history",
  description:
    "The current license (active, else awaiting payment, else the latest ended one), this month's " +
    "usage per feature over its seat holders, every license payment, and the latest 100 licensing " +
    "entries of the school's audit log.",
  request: { params: platformSchoolParamsSchema },
  responses: standardResponses(
    { 200: { description: "The overview", schema: schoolLicenseConsoleSchema } },
    [401, 403],
  ),
});

function platformActor(c: Context<AppEnv>): LicenseActor {
  const auth = requireAuth(c);
  return {
    kind: "platform",
    userId: auth.userId,
    homeSchoolId: auth.schoolId,
    requestId: c.get("requestId"),
    locale: (c.get("locale") ?? "en") as SupportedLocale,
  };
}

export function platformLicenseConsoleRoutes(deps: LicensingDeps): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const manage = requirePermission(PERMISSIONS.PLATFORM_MANAGE);
  const writesOnly = (c: Context<AppEnv>, next: () => Promise<void>) =>
    c.req.method === "GET" ? next() : manage(c, next);

  // Repeated per path rather than relied on from the console's other routes: this file stands alone.
  routes.use("/api/platform/features", requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/platform/features/*", requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/platform/tiers", requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/platform/tiers/*", requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/platform/licenses", requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/platform/licenses/*", requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/platform/schools/:schoolId/license-console", requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/platform/features", requirePermission(PERMISSIONS.PLATFORM_READ));
  routes.use("/api/platform/features/*", requirePermission(PERMISSIONS.PLATFORM_READ));
  routes.use("/api/platform/tiers", requirePermission(PERMISSIONS.PLATFORM_READ));
  routes.use("/api/platform/tiers/*", requirePermission(PERMISSIONS.PLATFORM_READ));
  routes.use("/api/platform/licenses", requirePermission(PERMISSIONS.PLATFORM_READ));
  routes.use("/api/platform/licenses/*", requirePermission(PERMISSIONS.PLATFORM_READ));
  routes.use(
    "/api/platform/schools/:schoolId/license-console",
    requirePermission(PERMISSIONS.PLATFORM_READ),
  );
  routes.use("/api/platform/features/*", writesOnly);
  routes.use("/api/platform/tiers", writesOnly);
  routes.use("/api/platform/tiers/*", writesOnly);

  routes.use("/api/platform/features/:featureKey", auditAction("update", "features"));
  routes.use("/api/platform/tiers", auditAction("insert", "plans"));
  routes.use("/api/platform/tiers/:planId", auditAction("update", "plans"));

  routes.openapi(listFeaturesRoute, async (c) => {
    const features = await withSystemTx(deps.database, listConsoleFeatures);
    return c.json({ features }, 200);
  });

  routes.openapi(updateFeatureRoute, async (c) => {
    const { featureKey } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = platformActor(c);
    const feature = await withSystemTx(deps.database, (tx) =>
      updateConsoleFeature(tx, featureKey, body, actor),
    );
    return c.json(feature, 200);
  });

  routes.openapi(listTiersRoute, async (c) => {
    const tiers = await withSystemTx(deps.database, listTiers);
    return c.json({ tiers }, 200);
  });

  routes.openapi(createTierRoute, async (c) => {
    const body = c.req.valid("json");
    const actor = platformActor(c);
    const tier = await withSystemTx(deps.database, (tx) => createTier(tx, body, actor));
    return c.json(tier, 201);
  });

  routes.openapi(updateTierRoute, async (c) => {
    const { planId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = platformActor(c);
    const tier = await withSystemTx(deps.database, (tx) => updateTier(tx, planId, body, actor));
    return c.json(tier, 200);
  });

  routes.openapi(listLicensesRoute, async (c) => {
    const query = c.req.valid("query");
    const licenses = await listLicensesAcrossSchools(deps.database, {
      status: query.status,
      expiringWithinDays: query.expiringWithinDays,
      seatsNearlyFull: query.seatsNearlyFull,
      unpaid: query.unpaid === "true",
    });
    return c.json({ licenses }, 200);
  });

  routes.openapi(listChangeRequestsRoute, async (c) => {
    const { status } = c.req.valid("query");
    const requests = await listChangeRequestsAcrossSchools(deps.database, status);
    return c.json({ requests }, 200);
  });

  routes.openapi(usageRevenueRoute, async (c) => {
    return c.json(await usageAndRevenue(deps.database), 200);
  });

  routes.openapi(schoolConsoleRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const overview = await readInSchool(deps, schoolId, platformActor(c), schoolLicenseConsole);
    return c.json(overview, 200);
  });

  return routes;
}
