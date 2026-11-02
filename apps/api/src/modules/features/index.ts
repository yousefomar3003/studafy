/**
 * Paid features (docs/billing/feature-licensing.md): the catalog, the resolver, the usage meter,
 * requireFeature and GET /api/me/features.
 *
 * A feature is a key in packages/constants/src/features.ts. Routes guard it with
 * `requireFeature("<key>", { meter })`; clients read GET /api/me/features. Who holds it comes from
 * grants (./grants.ts): the AI add-on, personal subscriptions, and from session 2 license seats.
 */

export {
  CATALOG_TTL_MS,
  createFeatureCatalogSource,
  readFeatureCatalog,
  syncFeatureCatalog,
  type FeatureCatalog,
  type FeatureCatalogSource,
  type FeatureSettings,
  type FeatureStatus,
  type Tier,
} from "./catalog";
export {
  AI_ADDON_TIER_CODE,
  GRANT_SOURCES,
  aiAddonGrants,
  collectGrants,
  licenseSeatGrants,
  userSubscriptionGrants,
  type GrantSourceAdapter,
  type PersonEntitlements,
} from "./grants";
export {
  FEATURE_REFUSAL_CODES,
  getFeatureGate,
  getFeatureService,
  provideFeatures,
  requireFeature,
  type FeatureGateContext,
  type FeatureRefusalCodes,
  type RequireFeatureOptions,
} from "./middleware";
export {
  resolveFeatureAccess,
  tierIncludes,
  usagePeriodStart,
  type FeatureAccess,
  type FeatureAccessMap,
  type FeatureGrant,
  type FeatureReason,
  type GrantSource,
} from "./resolve";
export { featureRoutes } from "./routes";
export {
  createFeatureService,
  type FeatureService,
  type FeatureSubject,
  type ResolvedFeatures,
} from "./service";
export { createFeatureUsageMeter, type FeatureUsageMeter } from "./usage";
