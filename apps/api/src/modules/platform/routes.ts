import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { requireChannel } from "../../middleware/channelGuard";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";
import { AUTH_CHANNELS } from "../auth/channels";
import {
  pauseAiSubscriptionsForSchoolSuspension,
  resumeAiSubscriptionsForSchoolReactivation,
} from "../subscriptions/services/school-suspension-service";

import {
  featureFlagParamSchema,
  financeSchema,
  inquiryIdParamSchema,
  inquiryListQuerySchema,
  inquiryListResponseSchema,
  inquirySchema,
  overviewSchema,
  planIdParamSchema,
  planListResponseSchema,
  planPriceParamSchema,
  planSchema,
  platformSettingListSchema,
  platformSettingSchema,
  schoolDetailSchema,
  schoolIdParamSchema,
  schoolListQuerySchema,
  schoolListResponseSchema,
  schoolMemberListQuerySchema,
  schoolMemberListResponseSchema,
  setFeatureFlagBodySchema,
  settingKeyParamSchema,
  updatePlanBodySchema,
  updatePlanPriceBodySchema,
  updatePlatformSettingBodySchema,
  updateSchoolStatusBodySchema,
  updateSchoolStatusResponseSchema,
  updateInquiryBodySchema,
  userLookupQuerySchema,
  userLookupResponseSchema,
} from "./schemas";
import {
  changeSchoolStatus,
  getPlatformFinance,
  getPlatformOverview,
  getSchoolDetail,
  listInquiries,
  listPlans,
  listPlatformSettings,
  listSchoolMembers,
  listSchools,
  lookupUserByEmail,
  setSchoolFeatureFlag,
  updateInquiry,
  updatePlan,
  updatePlanPrice,
  updatePlatformSetting,
} from "./service";

import type { Actor } from "./service";
import type { Database } from "../../db/client";
import type { Logger } from "../../logger";
import type { AppEnv } from "../../middleware/requestId";
import type { RedisClient } from "../../redis";
import type { PaymentProviderPort } from "../subscriptions/ports/payment-provider";
import type { Context } from "hono";

const TAG = "Platform";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const overviewRoute = createRoute({
  method: "get",
  path: "/api/platform/overview",
  tags: [TAG],
  operationId: "getPlatformOverview",
  summary: "Platform-wide totals",
  description:
    "Schools by lifecycle status, platform user and student totals, subscriptions by status and " +
    "plan, trials ending soon and live AI subscriptions. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "Platform overview.", schema: overviewSchema } },
    [401, 403, 429, 500],
  ),
});

const financeRoute = createRoute({
  method: "get",
  path: "/api/platform/finance",
  tags: [TAG],
  operationId: "getPlatformFinance",
  summary: "Studafy's own revenue and billing health",
  description:
    "Estimated monthly recurring revenue per currency (list price), renewal charges over the " +
    "last 30 days, schools whose billing needs attention, and the latest failed renewals. Review " +
    "tenants are excluded. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "Platform finance.", schema: financeSchema } },
    [401, 403, 429, 500],
  ),
});

const listSchoolsRoute = createRoute({
  method: "get",
  path: "/api/platform/schools",
  tags: [TAG],
  operationId: "listPlatformSchools",
  summary: "List every school on the platform",
  description:
    "Paged list of schools with subscription and headcount, filterable by lifecycle status and " +
    "by a name/slug/email search. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  request: { query: schoolListQuerySchema },
  responses: standardResponses(
    { 200: { description: "One page of schools.", schema: schoolListResponseSchema } },
    [400, 401, 403, 429, 500],
  ),
});

const getSchoolRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}",
  tags: [TAG],
  operationId: "getPlatformSchool",
  summary: "One school's platform record",
  description:
    "The school, its subscription, headcount by role, feature-flag overrides and the lifecycle " +
    "states it may move to. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  request: { params: schoolIdParamSchema },
  responses: standardResponses(
    { 200: { description: "School detail.", schema: schoolDetailSchema } },
    [400, 401, 403, 404, 429, 500],
  ),
});

const listSchoolMembersRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/members",
  tags: [TAG],
  operationId: "listPlatformSchoolMembers",
  summary: "One school's members",
  description:
    "Paged accounts of one school with their roles, filterable by role and account status and " +
    "by a name/email/admission-number/employee-number search. Students carry their admission " +
    "number, classes and guardians; parents their linked children. Also returns unfiltered " +
    "counts per role. Audited as a read in the school and in the operator's own school. " +
    "SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  request: { params: schoolIdParamSchema, query: schoolMemberListQuerySchema },
  responses: standardResponses(
    { 200: { description: "One page of members.", schema: schoolMemberListResponseSchema } },
    [400, 401, 403, 404, 429, 500],
  ),
});

const updateSchoolStatusRoute = createRoute({
  method: "patch",
  path: "/api/platform/schools/{schoolId}/status",
  tags: [TAG],
  operationId: "updatePlatformSchoolStatus",
  summary: "Activate, suspend, reactivate or archive a school",
  description:
    "Moves a school along its lifecycle (pending → active/archived, active → suspended/archived, " +
    "suspended → active/archived; archived is terminal). Suspending or archiving pauses students' " +
    "AI subscriptions; reactivating resumes them. Re-sending the current status retries that " +
    "billing step. Audited in the affected school and in the operator's own school.",
  security: [{ bearerAuth: [] }],
  request: {
    params: schoolIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updateSchoolStatusBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "Status changed.", schema: updateSchoolStatusResponseSchema } },
    [400, 401, 403, 404, 409, 429, 500],
  ),
});

const setFeatureFlagRoute = createRoute({
  method: "put",
  path: "/api/platform/schools/{schoolId}/feature-flags/{flagName}",
  tags: [TAG],
  operationId: "setPlatformSchoolFeatureFlag",
  summary: "Override a feature flag for one school",
  description:
    "Pins a flag on or off for one school, or removes the override with `enabled: null`. Takes " +
    "effect within the flag cache TTL. Audited.",
  security: [{ bearerAuth: [] }],
  request: {
    params: featureFlagParamSchema,
    body: { required: true, content: { "application/json": { schema: setFeatureFlagBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "Updated school detail.", schema: schoolDetailSchema } },
    [400, 401, 403, 404, 429, 500],
  ),
});

const listPlansRoute = createRoute({
  method: "get",
  path: "/api/platform/plans",
  tags: [TAG],
  operationId: "listPlatformPlans",
  summary: "Every plan and price, including inactive ones",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "Plans with prices.", schema: planListResponseSchema } },
    [401, 403, 429, 500],
  ),
});

const updatePlanRoute = createRoute({
  method: "patch",
  path: "/api/platform/plans/{planId}",
  tags: [TAG],
  operationId: "updatePlatformPlan",
  summary: "Rename, describe, or (de)activate a plan",
  description:
    "Changes a plan's display name, description or availability. Run the Stripe price sync " +
    "afterwards to publish the change to the payment provider. Audited.",
  security: [{ bearerAuth: [] }],
  request: {
    params: planIdParamSchema,
    body: { required: true, content: { "application/json": { schema: updatePlanBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "Updated plan.", schema: planSchema } },
    [400, 401, 403, 404, 429, 500],
  ),
});

const updatePlanPriceRoute = createRoute({
  method: "patch",
  path: "/api/platform/plans/{planId}/prices/{priceId}",
  tags: [TAG],
  operationId: "updatePlatformPlanPrice",
  summary: "(De)activate one plan price",
  security: [{ bearerAuth: [] }],
  request: {
    params: planPriceParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updatePlanPriceBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "Updated plan.", schema: planSchema } },
    [400, 401, 403, 404, 429, 500],
  ),
});

const listSettingsRoute = createRoute({
  method: "get",
  path: "/api/platform/settings",
  tags: [TAG],
  operationId: "listPlatformSettings",
  summary: "Every platform setting",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "Platform settings.", schema: platformSettingListSchema } },
    [401, 403, 429, 500],
  ),
});

const updateSettingRoute = createRoute({
  method: "patch",
  path: "/api/platform/settings/{key}",
  tags: [TAG],
  operationId: "updatePlatformSetting",
  summary: "Change a runtime-mutable platform setting",
  description: "Only settings marked mutable can change; the value must match the setting's type.",
  security: [{ bearerAuth: [] }],
  request: {
    params: settingKeyParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: updatePlatformSettingBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "Updated setting.", schema: platformSettingSchema } },
    [400, 401, 403, 404, 409, 429, 500],
  ),
});

const userLookupRoute = createRoute({
  method: "get",
  path: "/api/platform/users/lookup",
  tags: [TAG],
  operationId: "lookupPlatformUser",
  summary: "Find a person's accounts across all schools",
  description:
    "Exact match on the normalized email across every school -- one person may hold an account " +
    "in several. A support tool; never a substring search across tenants.",
  security: [{ bearerAuth: [] }],
  request: { query: userLookupQuerySchema },
  responses: standardResponses(
    { 200: { description: "Matching accounts.", schema: userLookupResponseSchema } },
    [400, 401, 403, 429, 500],
  ),
});

const listInquiriesRoute = createRoute({
  method: "get",
  path: "/api/platform/inquiries",
  tags: [TAG],
  operationId: "listPlatformInquiries",
  summary: '"Talk to us" sales inquiries',
  description:
    "Paged list of inquiries from the marketing site's contact form, newest first, filterable by " +
    "pipeline status and by a name/email/school search. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  request: { query: inquiryListQuerySchema },
  responses: standardResponses(
    { 200: { description: "One page of inquiries.", schema: inquiryListResponseSchema } },
    [400, 401, 403, 429, 500],
  ),
});

const updateInquiryRoute = createRoute({
  method: "patch",
  path: "/api/platform/inquiries/{inquiryId}",
  tags: [TAG],
  operationId: "updatePlatformInquiry",
  summary: "Update an inquiry's status or internal notes",
  description: "Moves an inquiry along the sales pipeline and/or edits the team's notes. Audited.",
  security: [{ bearerAuth: [] }],
  request: {
    params: inquiryIdParamSchema,
    body: { required: true, content: { "application/json": { schema: updateInquiryBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "Updated inquiry.", schema: inquirySchema } },
    [400, 401, 403, 404, 429, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route group factory
// ---------------------------------------------------------------------------

export interface PlatformRoutesDeps {
  database: Database;
  redis: RedisClient | null;
  /** Stripe, for pausing/resuming AI subscriptions on suspension. Null skips that step. */
  paymentProvider: PaymentProviderPort | null;
  logger: Logger;
}

function actorFrom(c: Context<AppEnv>): Actor {
  const auth = requireAuth(c);
  return { userId: auth.userId, schoolId: auth.schoolId, requestId: c.get("requestId") };
}

/**
 * The Studafy platform console API (`/api/platform/*`): cross-school operations for Studafy staff.
 *
 * Reads require `platform:read`, writes `platform:manage`; both are SUPER_ADMIN-only (see
 * packages/constants/src/permissions.ts). Web channel only -- a platform operator works from the
 * browser console, never a mobile session.
 */
export function platformRoutes(deps: PlatformRoutesDeps): OpenAPIHono<AppEnv> {
  const { database, redis, paymentProvider, logger } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/platform/*", requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/platform/*", requirePermission(PERMISSIONS.PLATFORM_READ));

  const manage = requirePermission(PERMISSIONS.PLATFORM_MANAGE);
  routes.use("/api/platform/schools/:schoolId/members", auditAction("read", "users"));
  routes.use("/api/platform/schools/:schoolId/status", manage);
  routes.use("/api/platform/schools/:schoolId/status", auditAction("update", "schools"));
  routes.use("/api/platform/schools/:schoolId/feature-flags/:flagName", manage);
  routes.use(
    "/api/platform/schools/:schoolId/feature-flags/:flagName",
    auditAction("update", "feature_flags"),
  );
  routes.use("/api/platform/plans/:planId", manage);
  routes.use("/api/platform/plans/:planId", auditAction("update", "plans"));
  routes.use("/api/platform/plans/:planId/prices/:priceId", manage);
  routes.use("/api/platform/plans/:planId/prices/:priceId", auditAction("update", "plan_prices"));
  routes.use("/api/platform/settings/:key", manage);
  routes.use("/api/platform/settings/:key", auditAction("update", "platform_settings"));
  routes.use("/api/platform/inquiries/:inquiryId", manage);
  routes.use("/api/platform/inquiries/:inquiryId", auditAction("update", "sales_inquiries"));

  routes.openapi(overviewRoute, async (c) => c.json(await getPlatformOverview(database), 200));

  routes.openapi(financeRoute, async (c) => c.json(await getPlatformFinance(database), 200));

  routes.openapi(listSchoolsRoute, async (c) => {
    const query = c.req.valid("query");
    return c.json(await listSchools(database, query), 200);
  });

  routes.openapi(getSchoolRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    return c.json(await getSchoolDetail(database, schoolId), 200);
  });

  routes.openapi(listSchoolMembersRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const query = c.req.valid("query");
    return c.json(await listSchoolMembers(database, schoolId, query, actorFrom(c)), 200);
  });

  routes.openapi(updateSchoolStatusRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const { status, reason } = c.req.valid("json");
    const actor = actorFrom(c);

    const change = await changeSchoolStatus(database, schoolId, status, reason, actor);

    // Runs after the status commits: the AI pause/resume opens its own transaction and calls the
    // provider per subscription. Both directions are idempotent, so a failure here is reported,
    // not rolled back -- the operator re-sends the same status to retry just this step.
    let aiSubscriptionsAffected: number | null = null;
    let aiBillingSynced = true;
    if (change.aiEffect && paymentProvider) {
      try {
        const run =
          change.aiEffect === "pause"
            ? pauseAiSubscriptionsForSchoolSuspension
            : resumeAiSubscriptionsForSchoolReactivation;
        const result = await run(database, paymentProvider, schoolId, logger, actor.requestId);
        aiSubscriptionsAffected = result.affected;
      } catch (err) {
        aiBillingSynced = false;
        logger.error(
          { err, school_id: schoolId, effect: change.aiEffect },
          "platform console: AI subscription billing sync failed after school status change",
        );
      }
    }

    const school = await getSchoolDetail(database, schoolId);
    return c.json({ school, aiSubscriptionsAffected, aiBillingSynced }, 200);
  });

  routes.openapi(setFeatureFlagRoute, async (c) => {
    const { schoolId, flagName } = c.req.valid("param");
    const { enabled } = c.req.valid("json");
    const detail = await setSchoolFeatureFlag(
      database,
      redis,
      schoolId,
      flagName,
      enabled,
      actorFrom(c),
    );
    return c.json(detail, 200);
  });

  routes.openapi(listPlansRoute, async (c) => c.json({ plans: await listPlans(database) }, 200));

  routes.openapi(updatePlanRoute, async (c) => {
    const { planId } = c.req.valid("param");
    const patch = c.req.valid("json");
    return c.json(await updatePlan(database, planId, patch, actorFrom(c)), 200);
  });

  routes.openapi(updatePlanPriceRoute, async (c) => {
    const { planId, priceId } = c.req.valid("param");
    const { isActive } = c.req.valid("json");
    return c.json(await updatePlanPrice(database, planId, priceId, isActive, actorFrom(c)), 200);
  });

  routes.openapi(listSettingsRoute, async (c) =>
    c.json({ settings: await listPlatformSettings(database) }, 200),
  );

  routes.openapi(updateSettingRoute, async (c) => {
    const { key } = c.req.valid("param");
    const { value } = c.req.valid("json");
    return c.json(await updatePlatformSetting(database, key, value, actorFrom(c)), 200);
  });

  routes.openapi(listInquiriesRoute, async (c) => {
    const query = c.req.valid("query");
    return c.json(await listInquiries(database, query), 200);
  });

  routes.openapi(updateInquiryRoute, async (c) => {
    const { inquiryId } = c.req.valid("param");
    const patch = c.req.valid("json");
    return c.json(await updateInquiry(database, inquiryId, patch, actorFrom(c)), 200);
  });

  routes.openapi(userLookupRoute, async (c) => {
    const { email } = c.req.valid("query");
    return c.json({ matches: await lookupUserByEmail(database, email) }, 200);
  });

  return routes;
}
