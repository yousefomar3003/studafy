import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";

import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { requireChannel } from "../../middleware/channelGuard";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";
import { AUTH_CHANNELS } from "../auth/channels";
import { requireStorage } from "../licensing/billing-platform-routes";
import { inSchool, licenseError } from "../licensing/context";
import { confirmUpload, getContentClass } from "../storage";
import {
  invalidateEntitlementEntry,
  userEntitlementCacheKey,
} from "../subscriptions/entitlements/cache";

import {
  createGrantBodySchema,
  grantIdParamSchema,
  grantListQuerySchema,
  grantReceiptFileSchema,
  manualGrantListSchema,
  manualGrantSchema,
  revokeGrantBodySchema,
} from "./grants-schemas";
import {
  createGrant,
  grantReceiptKey,
  listAllGrants,
  listSchoolGrants,
  revokeGrant,
} from "./grants-service";
import { schoolIdParamSchema } from "./schemas";

import type { GrantChange } from "./grants-service";
import type { Database } from "../../db/client";
import type { StorageService } from "../../lib/storage";
import type { Logger } from "../../logger";
import type { SupportedLocale } from "../../middleware/locale";
import type { AppEnv } from "../../middleware/requestId";
import type { RedisClient } from "../../redis";
import type { LicenseActor } from "../licensing/context";
import type { Context } from "hono";

const TAG = "Platform";

const listAllRoute = createRoute({
  method: "get",
  path: "/api/platform/grants",
  tags: [TAG],
  operationId: "listPlatformManualGrants",
  summary: "Manual grants across every school",
  description:
    "Storage caps and feature tiers Studafy staff granted by hand (for example after a cash " +
    "payment). `filter` picks active (in force or scheduled), expiring (ending within 14 days) or " +
    "ended (ended or revoked) grants.",
  security: [{ bearerAuth: [] }],
  request: { query: grantListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Matching grants.", schema: manualGrantListSchema } },
    [400, 401, 403, 429, 500],
  ),
});

const listSchoolRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/grants",
  tags: [TAG],
  operationId: "listPlatformSchoolGrants",
  summary: "A school's manual grants",
  security: [{ bearerAuth: [] }],
  request: { params: schoolIdParamSchema, query: grantListQuerySchema },
  responses: standardResponses(
    { 200: { description: "The school's grants.", schema: manualGrantListSchema } },
    [400, 401, 403, 429, 500],
  ),
});

const createGrantRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/grants",
  tags: [TAG],
  operationId: "createPlatformSchoolGrant",
  summary: "Grant storage or a feature tier by hand",
  description:
    "A storage grant raises the school's upload cap while it is in force (the cap is the largest " +
    "of the included storage, a live storage add-on and any grant). A tier grant gives one person " +
    "an active tier of their own audience; it adds to any App Store, Google Play or school-license " +
    "coverage. Audited; never deleted when it ends. 422 MANUAL_GRANT_TIER_INVALID when the person " +
    "cannot hold that tier.",
  security: [{ bearerAuth: [] }],
  request: {
    params: schoolIdParamSchema,
    body: { required: true, content: { "application/json": { schema: createGrantBodySchema } } },
  },
  responses: standardResponses(
    { 201: { description: "The new grant.", schema: manualGrantSchema } },
    [400, 401, 403, 404, 422, 429, 500, 503],
  ),
});

const revokeGrantRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/grants/{grantId}/revoke",
  tags: [TAG],
  operationId: "revokePlatformSchoolGrant",
  summary: "Revoke a manual grant now",
  description: "With a reason. The grant stops counting immediately and stays as history.",
  security: [{ bearerAuth: [] }],
  request: {
    params: grantIdParamSchema,
    body: { required: true, content: { "application/json": { schema: revokeGrantBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The revoked grant.", schema: manualGrantSchema } },
    [400, 401, 403, 404, 409, 429, 500],
  ),
});

const receiptFileRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/grants/{grantId}/receipt-file",
  tags: [TAG],
  operationId: "getPlatformSchoolGrantReceiptFile",
  summary: "A short-lived link to a grant's receipt file",
  security: [{ bearerAuth: [] }],
  request: { params: grantIdParamSchema },
  responses: standardResponses(
    { 200: { description: "A pre-signed GET.", schema: grantReceiptFileSchema } },
    [401, 403, 404, 429, 500, 503],
  ),
});

export interface PlatformGrantRoutesDeps {
  database: Database;
  redis: RedisClient | null;
  storage: StorageService | null;
  logger: Logger;
}

function actorFrom(c: Context<AppEnv>): LicenseActor {
  const auth = requireAuth(c);
  return {
    kind: "platform",
    userId: auth.userId,
    homeSchoolId: auth.schoolId,
    requestId: c.get("requestId"),
    locale: (c.get("locale") ?? "en") as SupportedLocale,
  };
}

/**
 * Manual grants in the platform console (db/migrations/000211). Reads need `platform:read`, writes
 * `platform:manage` (SUPER_ADMIN only); web channel only. Stands alone: its guards are its own.
 */
export function platformGrantRoutes(deps: PlatformGrantRoutesDeps): OpenAPIHono<AppEnv> {
  const { database, redis, storage, logger } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const manage = requirePermission(PERMISSIONS.PLATFORM_MANAGE);
  const writesOnly = (c: Context<AppEnv>, next: () => Promise<void>) =>
    c.req.method === "GET" ? next() : manage(c, next);

  for (const path of [
    "/api/platform/grants",
    "/api/platform/schools/:schoolId/grants",
    "/api/platform/schools/:schoolId/grants/*",
  ]) {
    routes.use(path, requireChannel(AUTH_CHANNELS.WEB));
    routes.use(path, requirePermission(PERMISSIONS.PLATFORM_READ));
    routes.use(path, writesOnly);
  }

  // The audit rows themselves are written by the service, inside the grant's transaction (the
  // console's two rows when a super admin acts on another school); these declare the action.
  routes.use("/api/platform/schools/:schoolId/grants", auditAction("insert", "manual_grants"));
  routes.use(
    "/api/platform/schools/:schoolId/grants/:grantId/revoke",
    auditAction("update", "manual_grants"),
  );

  /** Drop the changed people's cached entitlements now; the outbox invalidator does it too. */
  async function invalidate(schoolId: string, change: GrantChange): Promise<void> {
    if (!redis) return;
    for (const [userId, version] of change.versions) {
      await invalidateEntitlementEntry(redis, userEntitlementCacheKey(userId), version).catch(
        (err: unknown) => {
          logger.warn(
            { err, school_id: schoolId, user_id: userId },
            "manual grant: direct cache invalidation failed; the outbox invalidator will apply it",
          );
        },
      );
    }
  }

  routes.openapi(listAllRoute, async (c) => {
    const { filter, kind } = c.req.valid("query");
    return c.json({ grants: await listAllGrants(database, filter, kind) }, 200);
  });

  routes.openapi(listSchoolRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const { filter, kind } = c.req.valid("query");
    const grants = await inSchool(database, schoolId, actorFrom(c), (tx) =>
      listSchoolGrants(tx, filter, kind),
    );
    return c.json({ grants }, 200);
  });

  routes.openapi(createGrantRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = actorFrom(c);
    // The receipt is promoted before the grant's transaction: storage calls never sit inside one. A
    // grant that then fails leaves an orphan object, which the orphan report lists.
    let receiptStorageKey: string | null = null;
    if (body.receiptStorageKey) {
      const confirmed = await confirmUpload(
        requireStorage(storage, actor.locale),
        schoolId,
        getContentClass("license.receipt"),
        { storageKey: body.receiptStorageKey },
      );
      receiptStorageKey = confirmed.storageKey;
    }
    const change = await inSchool(database, schoolId, actor, (tx) =>
      createGrant(
        tx,
        schoolId,
        {
          kind: body.kind,
          capBytes: body.capBytes,
          userId: body.userId,
          planCode: body.planCode,
          startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
          endsAt: new Date(body.endsAt),
          reason: body.reason,
          amountMinor: body.amountMinor,
          currencyCode: body.currencyCode,
          receiptStorageKey,
        },
        actor,
      ),
    );
    await invalidate(schoolId, change);
    return c.json(change.grant, 201);
  });

  routes.openapi(revokeGrantRoute, async (c) => {
    const { schoolId, grantId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const actor = actorFrom(c);
    const change = await inSchool(database, schoolId, actor, (tx) =>
      revokeGrant(tx, schoolId, grantId, reason, actor),
    );
    await invalidate(schoolId, change);
    return c.json(change.grant, 200);
  });

  routes.openapi(receiptFileRoute, async (c) => {
    const { schoolId, grantId } = c.req.valid("param");
    const actor = actorFrom(c);
    const key = await inSchool(database, schoolId, actor, (tx) =>
      grantReceiptKey(tx, grantId, actor),
    );
    if (!key) throw licenseError(404, ERROR_CODES.MANUAL_GRANT_NOT_FOUND, actor.locale);
    const signed = await requireStorage(storage, actor.locale).presign(key, "GET");
    return c.json({ url: signed.url, expiresAt: signed.expiresAt.toISOString() }, 200);
  });

  return routes;
}
