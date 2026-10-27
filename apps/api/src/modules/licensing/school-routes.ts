import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";

import {
  assignSeatsBodySchema,
  assignSeatsResponseSchema,
  changeRequestSchema,
  createChangeRequestBodySchema,
  eligibleListSchema,
  eligibleQuerySchema,
  schoolLicenseOverviewSchema,
  schoolSeatParamsSchema,
  seatListQuerySchema,
  seatListSchema,
  unassignSeatResponseSchema,
} from "./schemas";
import {
  assignSeats,
  createChangeRequest,
  currentLicense,
  licenseUsage,
  licenseView,
  listChangeRequests,
  listEligible,
  listSeats,
  readInSchool,
  requireSchoolLicenseId,
  runLicenseChange,
  unassignSeat,
} from "./service";

import type { LicenseActor } from "./context";
import type { AssignRequest, LicensingDeps, SeatScope } from "./service";
import type { SupportedLocale } from "../../middleware/locale";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

/**
 * The school's side of its feature license (docs/billing/feature-licensing.md, session 2): read the
 * license and this month's usage, assign and unassign seats, see who could still get one, and ask
 * the super admin for different seats. `license:read` to read, `license:manage` to change -- both
 * held by ORG_ADMIN and PRINCIPAL. The license itself is the super admin's; a school can only
 * request a change.
 *
 * Seats are assigned on the school's current license: the active one, or one awaiting payment so the
 * school can prepare before activation.
 */

const TAG = "Licensing";

const overviewRoute = createRoute({
  method: "get",
  path: "/api/school/license",
  tags: [TAG],
  operationId: "getSchoolLicense",
  summary: "The school's license, seats and this month's usage",
  description:
    "The current license (active, else awaiting payment, else the latest suspended, expired or " +
    "cancelled one; null when there is none): the tier and seats used out of purchased per " +
    "audience, the end date and Family+. With this month's units per feature over the seat " +
    "holders, and the school's open seat change requests.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The license overview", schema: schoolLicenseOverviewSchema } },
    [401, 403],
  ),
});

const listSeatsRoute = createRoute({
  method: "get",
  path: "/api/school/license/seats",
  tags: [TAG],
  operationId: "listSchoolLicenseSeats",
  summary: "List seats on the school's license",
  description: "Filter by audience and status (active, unassigned, all); search by name or email.",
  security: [{ bearerAuth: [] }],
  request: { query: seatListQuerySchema },
  responses: standardResponses(
    { 200: { description: "Seats", schema: seatListSchema } },
    [400, 401, 403, 404],
  ),
});

const assignSeatsRoute = createRoute({
  method: "post",
  path: "/api/school/license/seats",
  tags: [TAG],
  operationId: "assignSchoolLicenseSeats",
  summary: "Assign seats",
  description:
    "Assign seats of one audience to named people (`userIds`) or in bulk by `scope`: a grade or " +
    "section (this academic year), a class, or everyone eligible. People are taken in name order " +
    "until the purchased seats run out; the result lists who got a seat and who did not, and why " +
    "(already_assigned, not_eligible, no_seats_left). A seat on an active license covers its holder " +
    "at once; a holder who pays personally has that subscription's renewal turned off " +
    "(`renewalStops`). 409 LICENSE_AUDIENCE_NOT_LICENSED when the license sells no seats to that " +
    "audience.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: assignSeatsBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "Who got a seat and who did not", schema: assignSeatsResponseSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

const unassignSeatRoute = createRoute({
  method: "delete",
  path: "/api/school/license/seats/{seatId}",
  tags: [TAG],
  operationId: "unassignSchoolLicenseSeat",
  summary: "Unassign a seat",
  description:
    "Frees the seat for someone else. The holder's personal subscription, if any, is not touched.",
  security: [{ bearerAuth: [] }],
  request: { params: schoolSeatParamsSchema },
  responses: standardResponses(
    { 200: { description: "The freed seat", schema: unassignSeatResponseSchema } },
    [401, 403, 404],
  ),
});

const eligibleRoute = createRoute({
  method: "get",
  path: "/api/school/license/eligible",
  tags: [TAG],
  operationId: "listSchoolLicenseEligible",
  summary: "People who could get a seat",
  description:
    "Members of the school in the audience who do not hold a seat yet, optionally narrowed to a " +
    "grade, section or class, with `hasPersonalSubscription` marking those who already pay.",
  security: [{ bearerAuth: [] }],
  request: { query: eligibleQuerySchema },
  responses: standardResponses(
    { 200: { description: "Eligible people", schema: eligibleListSchema } },
    [400, 401, 403, 404],
  ),
});

const changeRequestRoute = createRoute({
  method: "post",
  path: "/api/school/license/change-requests",
  tags: [TAG],
  operationId: "requestSchoolLicenseChange",
  summary: "Ask the super admin for different seats",
  description:
    "Records a request -- the seat totals wanted per audience and/or Family+, with a note -- for " +
    "the super admin. The license is unchanged until the super admin changes it.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createChangeRequestBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "The recorded request", schema: changeRequestSchema } },
    [400, 401, 403],
  ),
});

function schoolActor(c: Context<AppEnv>): LicenseActor & { schoolId: string } {
  const auth = requireAuth(c);
  return {
    kind: "school",
    userId: auth.userId,
    homeSchoolId: auth.schoolId,
    schoolId: auth.schoolId,
    requestId: c.get("requestId"),
    locale: (c.get("locale") ?? "en") as SupportedLocale,
  };
}

function scopeFrom(query: {
  gradeLevelId?: string;
  sectionId?: string;
  classId?: string;
}): SeatScope {
  if (query.classId) return { kind: "class", classId: query.classId };
  if (query.sectionId) return { kind: "section", sectionId: query.sectionId };
  if (query.gradeLevelId) return { kind: "grade", gradeLevelId: query.gradeLevelId };
  return { kind: "all" };
}

export function schoolLicenseRoutes(deps: LicensingDeps): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const manage = requirePermission(PERMISSIONS.LICENSE_MANAGE);
  const writesOnly = (c: Context<AppEnv>, next: () => Promise<void>) =>
    c.req.method === "GET" ? next() : manage(c, next);

  routes.use("/api/school/license", requirePermission(PERMISSIONS.LICENSE_READ));
  routes.use("/api/school/license/*", requirePermission(PERMISSIONS.LICENSE_READ));
  routes.use("/api/school/license/*", writesOnly);
  routes.use("/api/school/license/seats", auditAction("insert", "license_seats"));
  routes.use("/api/school/license/seats/:seatId", auditAction("update", "license_seats"));
  routes.use(
    "/api/school/license/change-requests",
    auditAction("insert", "license_change_requests"),
  );

  routes.openapi(overviewRoute, async (c) => {
    const actor = schoolActor(c);
    const overview = await readInSchool(deps, actor.schoolId, actor, async (tx) => {
      const license = await currentLicense(tx);
      return {
        license: license ? await licenseView(tx, license) : null,
        usage: license ? await licenseUsage(tx, license.id) : [],
        openChangeRequests: await listChangeRequests(tx, "open"),
      };
    });
    return c.json(overview, 200);
  });

  routes.openapi(listSeatsRoute, async (c) => {
    const actor = schoolActor(c);
    const query = c.req.valid("query");
    const seats = await readInSchool(deps, actor.schoolId, actor, async (tx) =>
      listSeats(tx, await requireSchoolLicenseId(tx, actor), query),
    );
    return c.json({ ...seats, status: query.status }, 200);
  });

  routes.openapi(assignSeatsRoute, async (c) => {
    const actor = schoolActor(c);
    const body = c.req.valid("json");
    const request: AssignRequest = body.userIds
      ? { audience: body.audience, userIds: body.userIds }
      : { audience: body.audience, scope: body.scope! };
    const { result, renewals } = await runLicenseChange(deps, actor.schoolId, actor, async (tx) =>
      assignSeats(tx, actor.schoolId, await requireSchoolLicenseId(tx, actor), request, actor),
    );
    return c.json({ ...result, renewalStops: renewals }, 200);
  });

  routes.openapi(unassignSeatRoute, async (c) => {
    const actor = schoolActor(c);
    const { seatId } = c.req.valid("param");
    const { result } = await runLicenseChange(deps, actor.schoolId, actor, async (tx) =>
      unassignSeat(tx, actor.schoolId, await requireSchoolLicenseId(tx, actor), seatId, actor),
    );
    return c.json(result, 200);
  });

  routes.openapi(eligibleRoute, async (c) => {
    const actor = schoolActor(c);
    const query = c.req.valid("query");
    const eligible = await readInSchool(deps, actor.schoolId, actor, async (tx) => {
      const license = await currentLicense(tx);
      if (!license) return { people: [], total: 0 };
      return listEligible(tx, license, {
        audience: query.audience,
        scope: scopeFrom(query),
        search: query.search,
        limit: query.limit,
        offset: query.offset,
      });
    });
    return c.json(eligible, 200);
  });

  routes.openapi(changeRequestRoute, async (c) => {
    const actor = schoolActor(c);
    const body = c.req.valid("json");
    const { result } = await runLicenseChange(deps, actor.schoolId, actor, async (tx) => ({
      result: await createChangeRequest(tx, actor.schoolId, body, actor),
      versions: new Map(),
      pending: [],
    }));
    return c.json(result, 201);
  });

  return routes;
}
