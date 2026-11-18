import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";

import { withSystemTx } from "../../db/tenant-tx";
import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { requireChannel } from "../../middleware/channelGuard";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";
import { AUTH_CHANNELS } from "../auth/channels";

import {
  aiProgrammeDashboard,
  listAiProgrammeSchools,
  platformAiProgrammeDashboard,
  readSchoolAsSystem,
} from "./ai-dashboard";
import {
  aiProgrammeDashboardSchema,
  aiProgrammeSchoolListSchema,
  platformAiProgrammeDashboardSchema,
} from "./ai-dashboard-schemas";
import { licenseError } from "./context";
import {
  licenseRevenueShare,
  recomputeRevenueShare,
  recordRevenueSharePayout,
  remeasureConversion,
  schoolRevenueShare,
} from "./revenue-share";
import {
  licenseRevenueShareSchema,
  recomputeResultSchema,
  recordPayoutBodySchema,
  remeasureBodySchema,
  revenueShareLicenseParamsSchema,
  revenueSharePayoutSchema,
  revenueShareQuerySchema,
  revenueShareSchoolParamsSchema,
  schoolRevenueShareQuerySchema,
  schoolRevenueShareSchema,
} from "./revenue-share-schemas";
import { readInSchool, readLicense, runLicenseChange } from "./service";

import type { LicenseActor } from "./context";
import type { LicensingDeps } from "./service";
import type { SupportedLocale } from "../../middleware/locale";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

/**
 * The Student AI revenue share (migration 000237, docs/billing/ai-programme.md).
 *
 * The super admin's console (SUPER_ADMIN, web channel; platform:read to read, platform:manage to
 * change): a school's ledger and totals, a licence's conversion measurements and share rate,
 * re-measuring before the lock (with a reason), working pending shares out again, and recording a
 * payout. Every change is audited inside the service transaction.
 *
 * The school's own read (/api/school/ai-revenue-share, aiRevenueShare:read: the school admin, the
 * principal and finance): its ledger, totals and payouts. The dashboards are phase 6's.
 */

const TAG = "Platform";
const SCHOOL_TAG = "Licensing";

const listRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/ai-revenue-share",
  operationId: "platformListAiRevenueShare",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "A school's Student AI revenue share ledger",
  description:
    "One entry per recorded payment and instalment: collected, the Student AI part, conversion " +
    "and bonus, the total share and the amount, and where it stands (pending, owed, zero, credited, " +
    "payout_due, paid_out, forfeited, void); totals per currency; payouts. Filter by licence or " +
    "status.",
  request: { params: revenueShareSchoolParamsSchema, query: revenueShareQuerySchema },
  responses: standardResponses(
    { 200: { description: "The ledger", schema: schoolRevenueShareSchema } },
    [400, 401, 403, 404],
  ),
});

const licenseRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/licenses/{licenseId}/ai-revenue-share",
  operationId: "platformGetLicenseAiRevenueShare",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "A licence's conversion measurements and revenue share",
  description:
    "Its measurement periods (each locked on its measurement day, with the re-measures before), " +
    "the conversion share a payment recorded today gets (locked, provisional or none yet), and its " +
    "ledger.",
  request: { params: revenueShareLicenseParamsSchema },
  responses: standardResponses(
    { 200: { description: "The licence's revenue share", schema: licenseRevenueShareSchema } },
    [401, 403, 404],
  ),
});

const measureRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/licenses/{licenseId}/ai-revenue-share/measure",
  operationId: "platformMeasureLicenseConversion",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Measure a licence period's conversion again, before it is locked",
  description:
    "Counts students enrolled and opted in now, with a reason, audited. The period today falls in " +
    "unless `periodStart` names another. The workers still lock the measurement on the measurement " +
    "day. 409 AI_REVENUE_SHARE_CONVERSION_LOCKED once it is locked; 422 " +
    "AI_PROGRAMME_REASON_REQUIRED without a reason.",
  request: {
    params: revenueShareLicenseParamsSchema,
    body: { required: true, content: { "application/json": { schema: remeasureBodySchema } } },
  },
  responses: standardResponses(
    { 201: { description: "The licence's revenue share", schema: licenseRevenueShareSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

const recomputeRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/ai-revenue-share/recompute",
  operationId: "platformRecomputeAiRevenueShare",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Work a school's pending revenue share out again, and settle it",
  description:
    "What the workers do every hour, now: pending shares whose conversion is locked and upload " +
    "consistency known become final; owed shares are credited on open later invoices; shares of a " +
    "licence that ended become payout_due; shares of an instalment unpaid past its cutoff are " +
    "forfeited. Every change is audited.",
  request: { params: revenueShareSchoolParamsSchema },
  responses: standardResponses(
    { 200: { description: "What changed, and the ledger", schema: recomputeResultSchema } },
    [401, 403, 404],
  ),
});

const payoutRoute = createRoute({
  method: "post",
  path: "/api/platform/schools/{schoolId}/ai-revenue-share/payouts",
  operationId: "platformRecordAiRevenueSharePayout",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Record a revenue share payout to a school",
  description:
    "Every share due to be paid out in the currency (net of reversals) becomes paid_out, with the " +
    "transfer's reference. `amountMinor` is the amount due as shown: 409 " +
    "AI_REVENUE_SHARE_PAYOUT_CHANGED when it has changed since, 409 AI_REVENUE_SHARE_NOTHING_DUE " +
    "when nothing is due.",
  request: {
    params: revenueShareSchoolParamsSchema,
    body: { required: true, content: { "application/json": { schema: recordPayoutBodySchema } } },
  },
  responses: standardResponses(
    { 201: { description: "The payout", schema: revenueSharePayoutSchema } },
    [400, 401, 403, 404, 409],
  ),
});

const schoolRoute = createRoute({
  method: "get",
  path: "/api/school/ai-revenue-share",
  operationId: "schoolGetAiRevenueShare",
  tags: [SCHOOL_TAG],
  security: [{ bearerAuth: [] }],
  summary: "The school's Student AI revenue share",
  description:
    "What Studafy collected for Student AI seats, the share worked out on each payment (conversion " +
    "+ bonus = total, and the amount), and what was credited on invoices or paid out. " +
    "aiRevenueShare:read (the school admin, the principal and finance).",
  request: { query: schoolRevenueShareQuerySchema },
  responses: standardResponses(
    { 200: { description: "The school's revenue share", schema: schoolRevenueShareSchema } },
    [400, 401, 403],
  ),
});

const DASHBOARD_DESCRIPTION =
  "Students enrolled and opted in today; the conversion the share uses (locked on the measurement " +
  "day, a provisional re-measure, or today's counts) and its tier; the next tier that pays more " +
  "and the opt-ins it takes, and the large-school floor when it pays more; upload consistency to " +
  "date, its bonus tier and the target; the share a payment would get now; the ledger's totals; " +
  "the school's earnings for the academic year (the share earned, plus the margin on the Student " +
  "AI tuition lines: collected from lines Studafy billed, estimated for lines the school bills " +
  "itself); and the licence's invoices (invoiced, paid, outstanding, credits). Aggregates only.";

const schoolDashboardRoute = createRoute({
  method: "get",
  path: "/api/school/ai-revenue-share/summary",
  operationId: "schoolGetAiProgrammeDashboard",
  tags: [SCHOOL_TAG],
  security: [{ bearerAuth: [] }],
  summary: "The school's Student AI programme dashboard",
  description: `${DASHBOARD_DESCRIPTION} aiRevenueShare:read (the school admin, the principal and finance).`,
  responses: standardResponses(
    { 200: { description: "The dashboard", schema: aiProgrammeDashboardSchema } },
    [401, 403],
  ),
});

const platformDashboardRoute = createRoute({
  method: "get",
  path: "/api/platform/schools/{schoolId}/ai-revenue-share/summary",
  operationId: "platformGetAiProgrammeDashboard",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "A school's Student AI programme dashboard",
  description: `${DASHBOARD_DESCRIPTION} Adds what Studafy keeps for the year, in total and per seat.`,
  request: { params: revenueShareSchoolParamsSchema },
  responses: standardResponses(
    { 200: { description: "The dashboard", schema: platformAiProgrammeDashboardSchema } },
    [401, 403, 404],
  ),
});

const overviewRoute = createRoute({
  method: "get",
  path: "/api/platform/ai-revenue-share/schools",
  operationId: "platformListAiProgrammeSchools",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Every school in the Student AI programme",
  description:
    "One row per school with an opt-in window, opt-ins or a revenue share ledger: enrolled and " +
    "opted in, conversion (in force and today's), upload consistency, the share rate, the year's " +
    "share (collected, pending, owed, credited, payout due, paid out, forfeited) and what Studafy " +
    "keeps, in total and per seat.",
  responses: standardResponses(
    { 200: { description: "The schools", schema: aiProgrammeSchoolListSchema } },
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

export function platformAiRevenueShareRoutes(deps: LicensingDeps): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const manage = requirePermission(PERMISSIONS.PLATFORM_MANAGE);
  const writesOnly = (c: Context<AppEnv>, next: () => Promise<void>) =>
    c.req.method === "GET" ? next() : manage(c, next);

  const paths = [
    "/api/platform/ai-revenue-share/schools",
    "/api/platform/schools/:schoolId/ai-revenue-share",
    "/api/platform/schools/:schoolId/ai-revenue-share/*",
    "/api/platform/schools/:schoolId/licenses/:licenseId/ai-revenue-share",
    "/api/platform/schools/:schoolId/licenses/:licenseId/ai-revenue-share/*",
  ];
  for (const path of paths) routes.use(path, requireChannel(AUTH_CHANNELS.WEB));
  for (const path of paths) routes.use(path, requirePermission(PERMISSIONS.PLATFORM_READ));
  for (const path of paths) routes.use(path, writesOnly);

  routes.use(
    "/api/platform/schools/:schoolId/licenses/:licenseId/ai-revenue-share/measure",
    auditAction("insert", "ai_programme_conversion_snapshots"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/ai-revenue-share/recompute",
    auditAction("update", "ai_programme_revenue_share_entries"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/ai-revenue-share/payouts",
    auditAction("insert", "ai_programme_revenue_share_payouts"),
  );

  async function requireSchool(schoolId: string, actor: LicenseActor): Promise<void> {
    const found = await withSystemTx(
      deps.database,
      (tx) => tx`SELECT 1 FROM app.schools WHERE id = ${schoolId}::uuid`,
    );
    if (found.length === 0) throw licenseError(404, ERROR_CODES.RESOURCE_NOT_FOUND, actor.locale);
  }

  routes.openapi(listRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const query = c.req.valid("query");
    const actor = platformActor(c);
    await requireSchool(schoolId, actor);
    const view = await readInSchool(deps, schoolId, actor, (tx) => schoolRevenueShare(tx, query));
    return c.json(view, 200);
  });

  routes.openapi(overviewRoute, async (c) => {
    const schools = await listAiProgrammeSchools(deps.database);
    return c.json({ schools }, 200);
  });

  routes.openapi(platformDashboardRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const actor = platformActor(c);
    await requireSchool(schoolId, actor);
    const view = await readInSchool(deps, schoolId, actor, (tx) =>
      platformAiProgrammeDashboard(tx),
    );
    return c.json(view, 200);
  });

  routes.openapi(licenseRoute, async (c) => {
    const { schoolId, licenseId } = c.req.valid("param");
    const actor = platformActor(c);
    const view = await readInSchool(deps, schoolId, actor, async (tx) => {
      const license = await readLicense(tx, licenseId);
      if (!license) throw licenseError(404, ERROR_CODES.LICENSE_NOT_FOUND, actor.locale);
      return licenseRevenueShare(tx, license);
    });
    return c.json(view, 200);
  });

  routes.openapi(measureRoute, async (c) => {
    const { schoolId, licenseId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = platformActor(c);
    const view = await readInSchool(deps, schoolId, actor, async (tx) => {
      const license = await readLicense(tx, licenseId, { forUpdate: true });
      if (!license) throw licenseError(404, ERROR_CODES.LICENSE_NOT_FOUND, actor.locale);
      return remeasureConversion(tx, schoolId, license, body, actor);
    });
    return c.json(view, 201);
  });

  routes.openapi(recomputeRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const actor = platformActor(c);
    await requireSchool(schoolId, actor);
    const { result } = await runLicenseChange(deps, schoolId, actor, async (tx) => {
      const changed = await recomputeRevenueShare(tx, schoolId, actor);
      return {
        ...changed,
        result: { ...changed.result, revenueShare: await schoolRevenueShare(tx) },
      };
    });
    return c.json(result, 200);
  });

  routes.openapi(payoutRoute, async (c) => {
    const { schoolId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = platformActor(c);
    await requireSchool(schoolId, actor);
    const payout = await readInSchool(deps, schoolId, actor, (tx) =>
      recordRevenueSharePayout(tx, schoolId, body, actor),
    );
    return c.json(payout, 201);
  });

  return routes;
}

export function schoolAiRevenueShareRoutes(deps: LicensingDeps): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  routes.use("/api/school/ai-revenue-share", requirePermission(PERMISSIONS.AI_REVENUE_SHARE_READ));
  routes.use(
    "/api/school/ai-revenue-share/summary",
    requirePermission(PERMISSIONS.AI_REVENUE_SHARE_READ),
  );

  const schoolActor = (c: Context<AppEnv>): LicenseActor => {
    const auth = requireAuth(c);
    return {
      kind: "school",
      userId: auth.userId,
      homeSchoolId: auth.schoolId,
      requestId: c.get("requestId"),
      locale: (c.get("locale") ?? "en") as SupportedLocale,
    };
  };

  routes.openapi(schoolRoute, async (c) => {
    const query = c.req.valid("query");
    const actor = schoolActor(c);
    const view = await readInSchool(deps, actor.homeSchoolId, actor, (tx) =>
      schoolRevenueShare(tx, query),
    );
    return c.json(view, 200);
  });

  // Aggregates over opt-ins and tuition lines, which the runtime role shows leadership only: read as
  // the system armed for the caller's own school (tenant isolation still binds every statement).
  routes.openapi(schoolDashboardRoute, async (c) => {
    const actor = schoolActor(c);
    const view = await readSchoolAsSystem(deps.database, actor, (tx) => aiProgrammeDashboard(tx));
    return c.json(view, 200);
  });

  return routes;
}
