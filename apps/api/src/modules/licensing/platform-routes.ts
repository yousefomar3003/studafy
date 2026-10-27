import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";

import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { requireChannel } from "../../middleware/channelGuard";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";
import { AUTH_CHANNELS } from "../auth/channels";

import { licenseError } from "./context";
import {
  assignSeatsBodySchema,
  assignSeatsResponseSchema,
  changeRequestListQuerySchema,
  changeRequestListSchema,
  changeRequestSchema,
  createLicenseBodySchema,
  extendLicenseBodySchema,
  licenseStatusBodySchema,
  platformLicenseChangeResponseSchema,
  platformLicenseListSchema,
  platformLicenseParamsSchema,
  platformLicenseSchema,
  platformRequestParamsSchema,
  platformSchoolParamsSchema,
  platformSeatParamsSchema,
  resolveChangeRequestBodySchema,
  seatListQuerySchema,
  seatListSchema,
  unassignSeatResponseSchema,
  updateLicenseBodySchema,
} from "./schemas";
import {
  assignSeats,
  createLicense,
  extendLicense,
  listChangeRequests,
  listLicenses,
  listSeats,
  platformLicenseView,
  readInSchool,
  readLicense,
  resolveChangeRequest,
  runLicenseChange,
  transitionLicense,
  unassignSeat,
  updateLicense,
} from "./service";

import type { LicenseActor } from "./context";
import type { AssignRequest, LicensingDeps } from "./service";
import type { SupportedLocale } from "../../middleware/locale";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

/**
 * The super admin's side of school licenses (docs/billing/feature-licensing.md, session 2): create
 * and edit a school's licenses, move them through their lifecycle, and manage seats on the school's
 * behalf. Under /api/platform like the rest of the console: SUPER_ADMIN only (platform:read to read,
 * platform:manage to change), web channel only.
 *
 * Every write is audited twice -- in the school with a NULL actor, and in the operator's home school
 * with the operator -- the console's convention (./context.ts).
 */

const TAG = "Platform";

const listLicensesRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/licenses",
  tags: [TAG],
  operationId: "platformListSchoolLicenses",
  summary: "List a school's licenses",
  security: [{ bearerAuth: [] }],
  request: { params: platformSchoolParamsSchema },
  responses: standardResponses(
    {
      200: {
        description: "The school's licenses, newest first",
        schema: platformLicenseListSchema,
      },
    },
    [401, 403],
  ),
});

const createLicenseRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/licenses",
  tags: [TAG],
  operationId: "platformCreateSchoolLicense",
  summary: "Create a draft license for a school",
  description:
    "Creates a license in `draft`: a tier and seat count per audience (parents only with " +
    "`includeFamilyPlus`), a period and a currency. Each tier must be a tier of its audience.",
  security: [{ bearerAuth: [] }],
  request: {
    params: platformSchoolParamsSchema,
    body: { required: true, content: { "application/json": { schema: createLicenseBodySchema } } },
  },
  responses: standardResponses(
    { 201: { description: "The new draft license", schema: platformLicenseSchema } },
    [400, 401, 403, 422],
  ),
});

const getLicenseRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/licenses/{licenseId}",
  tags: [TAG],
  operationId: "platformGetSchoolLicense",
  summary: "Get one license",
  security: [{ bearerAuth: [] }],
  request: { params: platformLicenseParamsSchema },
  responses: standardResponses(
    { 200: { description: "The license", schema: platformLicenseSchema } },
    [401, 403, 404],
  ),
});

const updateLicenseRoute = createRoute({
  method: "patch",
  path: "/api/platform/schools/{schoolId}/licenses/{licenseId}",
  tags: [TAG],
  operationId: "platformUpdateSchoolLicense",
  summary: "Edit a license",
  description:
    "Draft and awaiting-payment licenses: every field. Active and suspended: tiers, seat counts, " +
    "Family+ and notes (409 LICENSE_NOT_EDITABLE otherwise; the end date moves through /extend). " +
    "A seat count below the seats already assigned answers 409 LICENSE_SEATS_BELOW_ASSIGNED.",
  security: [{ bearerAuth: [] }],
  request: {
    params: platformLicenseParamsSchema,
    body: { required: true, content: { "application/json": { schema: updateLicenseBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The updated license", schema: platformLicenseSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

const licenseStatusRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/licenses/{licenseId}/status",
  tags: [TAG],
  operationId: "platformChangeSchoolLicenseStatus",
  summary: "Activate, suspend, resume, cancel or send a license for payment",
  description:
    "Moves the license along its lifecycle (`allowedTransitions` lists the moves from its status). " +
    "Activating starts covering every seat holder: overlaps with personal subscriptions are " +
    "recorded and their renewals stopped (`renewalStops`). One active license per school " +
    "(409 LICENSE_ALREADY_ACTIVE).",
  security: [{ bearerAuth: [] }],
  request: {
    params: platformLicenseParamsSchema,
    body: { required: true, content: { "application/json": { schema: licenseStatusBodySchema } } },
  },
  responses: standardResponses(
    {
      200: {
        description: "The license after the change",
        schema: platformLicenseChangeResponseSchema,
      },
    },
    [400, 401, 403, 404, 409],
  ),
});

const extendLicenseRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/licenses/{licenseId}/extend",
  tags: [TAG],
  operationId: "platformExtendSchoolLicense",
  summary: "Extend a license",
  security: [{ bearerAuth: [] }],
  request: {
    params: platformLicenseParamsSchema,
    body: { required: true, content: { "application/json": { schema: extendLicenseBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The license with its new end date", schema: platformLicenseSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

const listSeatsRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/licenses/{licenseId}/seats",
  tags: [TAG],
  operationId: "platformListLicenseSeats",
  summary: "List a license's seats",
  security: [{ bearerAuth: [] }],
  request: { params: platformLicenseParamsSchema, query: seatListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Seats", schema: seatListSchema } },
    [400, 401, 403, 404],
  ),
});

const assignSeatsRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/licenses/{licenseId}/seats",
  tags: [TAG],
  operationId: "platformAssignLicenseSeats",
  summary: "Assign seats on the school's behalf",
  description:
    "Same as the school's own assignment: named people (`userIds`) or a scope (grade, section, " +
    "class, all eligible), filled in name order until the seats run out.",
  security: [{ bearerAuth: [] }],
  request: {
    params: platformLicenseParamsSchema,
    body: { required: true, content: { "application/json": { schema: assignSeatsBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "Who got a seat and who did not", schema: assignSeatsResponseSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

const unassignSeatRoute = createRoute({
  method: "delete",
  path: "/api/platform/schools/{schoolId}/licenses/{licenseId}/seats/{seatId}",
  tags: [TAG],
  operationId: "platformUnassignLicenseSeat",
  summary: "Unassign a seat on the school's behalf",
  security: [{ bearerAuth: [] }],
  request: { params: platformSeatParamsSchema },
  responses: standardResponses(
    { 200: { description: "The freed seat", schema: unassignSeatResponseSchema } },
    [401, 403, 404],
  ),
});

const listRequestsRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/license-requests",
  tags: [TAG],
  operationId: "platformListLicenseChangeRequests",
  summary: "List a school's seat change requests",
  security: [{ bearerAuth: [] }],
  request: { params: platformSchoolParamsSchema, query: changeRequestListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Requests, newest first", schema: changeRequestListSchema } },
    [400, 401, 403],
  ),
});

const resolveRequestRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/license-requests/{requestId}/resolve",
  tags: [TAG],
  operationId: "platformResolveLicenseChangeRequest",
  summary: "Resolve or decline a seat change request",
  security: [{ bearerAuth: [] }],
  request: {
    params: platformRequestParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: resolveChangeRequestBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The closed request", schema: changeRequestSchema } },
    [400, 401, 403, 404],
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

export function platformLicenseRoutes(deps: LicensingDeps): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const manage = requirePermission(PERMISSIONS.PLATFORM_MANAGE);
  const writesOnly = (c: Context<AppEnv>, next: () => Promise<void>) =>
    c.req.method === "GET" ? next() : manage(c, next);

  // Repeated here rather than relied on from platformRoutes: this file must stand alone.
  routes.use("/api/platform/schools/:schoolId/licenses", requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/platform/schools/:schoolId/licenses/*", requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/platform/schools/:schoolId/license-requests", requireChannel(AUTH_CHANNELS.WEB));
  routes.use(
    "/api/platform/schools/:schoolId/license-requests/*",
    requireChannel(AUTH_CHANNELS.WEB),
  );
  routes.use(
    "/api/platform/schools/:schoolId/licenses",
    requirePermission(PERMISSIONS.PLATFORM_READ),
  );
  routes.use(
    "/api/platform/schools/:schoolId/licenses/*",
    requirePermission(PERMISSIONS.PLATFORM_READ),
  );
  routes.use(
    "/api/platform/schools/:schoolId/license-requests",
    requirePermission(PERMISSIONS.PLATFORM_READ),
  );
  routes.use(
    "/api/platform/schools/:schoolId/license-requests/*",
    requirePermission(PERMISSIONS.PLATFORM_READ),
  );
  routes.use("/api/platform/schools/:schoolId/licenses", writesOnly);
  routes.use("/api/platform/schools/:schoolId/licenses/*", writesOnly);
  routes.use("/api/platform/schools/:schoolId/license-requests/*", writesOnly);

  routes.use("/api/platform/schools/:schoolId/licenses", auditAction("insert", "school_licenses"));
  routes.use(
    "/api/platform/schools/:schoolId/licenses/:licenseId",
    auditAction("update", "school_licenses"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/licenses/:licenseId/status",
    auditAction("update", "school_licenses"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/licenses/:licenseId/extend",
    auditAction("update", "school_licenses"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/licenses/:licenseId/seats",
    auditAction("insert", "license_seats"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/licenses/:licenseId/seats/:seatId",
    auditAction("update", "license_seats"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/license-requests/:requestId/resolve",
    auditAction("update", "license_change_requests"),
  );

  routes.openapi(listLicensesRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const licenses = await readInSchool(deps, schoolId, platformActor(c), listLicenses);
    return c.json({ licenses }, 200);
  });

  routes.openapi(createLicenseRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = platformActor(c);
    const { result } = await runLicenseChange(deps, schoolId, actor, async (tx) => {
      const license = await createLicense(
        tx,
        schoolId,
        { ...body, startsAt: new Date(body.startsAt), endsAt: new Date(body.endsAt) },
        actor,
      );
      return { result: await platformLicenseView(tx, license), versions: new Map(), pending: [] };
    });
    return c.json(result, 201);
  });

  routes.openapi(getLicenseRoute, async (c) => {
    const { schoolId, licenseId } = c.req.valid("param");
    const actor = platformActor(c);
    const view = await readInSchool(deps, schoolId, actor, async (tx) => {
      const license = await readLicense(tx, licenseId);
      if (!license) throw licenseError(404, ERROR_CODES.LICENSE_NOT_FOUND, actor.locale);
      return platformLicenseView(tx, license);
    });
    return c.json(view, 200);
  });

  routes.openapi(updateLicenseRoute, async (c) => {
    const { schoolId, licenseId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = platformActor(c);
    const { result } = await runLicenseChange(deps, schoolId, actor, async (tx) => {
      const changed = await updateLicense(
        tx,
        schoolId,
        licenseId,
        {
          ...body,
          startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
          endsAt: body.endsAt ? new Date(body.endsAt) : undefined,
        },
        actor,
      );
      return { ...changed, result: await platformLicenseView(tx, changed.result) };
    });
    return c.json(result, 200);
  });

  routes.openapi(licenseStatusRoute, async (c) => {
    const { schoolId, licenseId } = c.req.valid("param");
    const { status } = c.req.valid("json");
    const actor = platformActor(c);
    const { result, renewals } = await runLicenseChange(deps, schoolId, actor, async (tx) => {
      const changed = await transitionLicense(tx, schoolId, licenseId, status, actor);
      return { ...changed, result: await platformLicenseView(tx, changed.result) };
    });
    return c.json({ license: result, renewalStops: renewals }, 200);
  });

  routes.openapi(extendLicenseRoute, async (c) => {
    const { schoolId, licenseId } = c.req.valid("param");
    const { endsAt } = c.req.valid("json");
    const actor = platformActor(c);
    const { result } = await runLicenseChange(deps, schoolId, actor, async (tx) => {
      const changed = await extendLicense(tx, schoolId, licenseId, new Date(endsAt), actor);
      return { ...changed, result: await platformLicenseView(tx, changed.result) };
    });
    return c.json(result, 200);
  });

  routes.openapi(listSeatsRoute, async (c) => {
    const { schoolId, licenseId } = c.req.valid("param");
    const query = c.req.valid("query");
    const seats = await readInSchool(deps, schoolId, platformActor(c), (tx) =>
      listSeats(tx, licenseId, query),
    );
    return c.json({ ...seats, status: query.status }, 200);
  });

  routes.openapi(assignSeatsRoute, async (c) => {
    const { schoolId, licenseId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = platformActor(c);
    const request: AssignRequest = body.userIds
      ? { audience: body.audience, userIds: body.userIds }
      : { audience: body.audience, scope: body.scope! };
    const { result, renewals } = await runLicenseChange(deps, schoolId, actor, (tx) =>
      assignSeats(tx, schoolId, licenseId, request, actor),
    );
    return c.json({ ...result, renewalStops: renewals }, 200);
  });

  routes.openapi(unassignSeatRoute, async (c) => {
    const { schoolId, licenseId, seatId } = c.req.valid("param");
    const actor = platformActor(c);
    const { result } = await runLicenseChange(deps, schoolId, actor, (tx) =>
      unassignSeat(tx, schoolId, licenseId, seatId, actor),
    );
    return c.json(result, 200);
  });

  routes.openapi(listRequestsRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const { status } = c.req.valid("query");
    const requests = await readInSchool(deps, schoolId, platformActor(c), (tx) =>
      listChangeRequests(tx, status),
    );
    return c.json({ requests }, 200);
  });

  routes.openapi(resolveRequestRoute, async (c) => {
    const { schoolId, requestId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = platformActor(c);
    const { result } = await runLicenseChange(deps, schoolId, actor, async (tx) => ({
      result: await resolveChangeRequest(tx, schoolId, requestId, body, actor),
      versions: new Map(),
      pending: [],
    }));
    return c.json(result, 200);
  });

  return routes;
}
