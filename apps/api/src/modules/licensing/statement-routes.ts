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
import { readInSchool, runLicenseChange } from "./service";
import {
  approveStatementBodySchema,
  holdStatementBodySchema,
  platformStatementListSchema,
  rejectStatementBodySchema,
  schoolStatementListSchema,
  statementDetailSchema,
  statementListQuerySchema,
  statementParamsSchema,
} from "./statement-schemas";
import {
  approveStatement,
  holdStatement,
  listStatementsAcrossSchools,
  rejectStatement,
  schoolStatements,
  statementDetail,
} from "./statements";

import type { LicenseActor } from "./context";
import type { LicensingDeps } from "./service";
import type { SupportedLocale } from "../../middleware/locale";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

/**
 * The Student AI weekly statements (migration 000251, docs/billing/ai-programme.md "Weekly
 * statements").
 *
 * The super admin's console (SUPER_ADMIN, web channel; platform:read to read, platform:manage to
 * decide): the queue across schools, one statement with its student-months and licence shares, and
 * approve / hold / reject. Every decision is audited inside the service transaction.
 *
 * The school's own read (/api/school/ai-revenue-share/statements, aiRevenueShare:read): its
 * statements and what each billed and credited.
 */

const TAG = "Platform";
const SCHOOL_TAG = "Licensing";
const STATEMENT_PATH = "/api/platform/schools/{schoolId}/ai-revenue-share/statements/{statementId}";

const listRoute = createRoute({
  method: "get",
  path: "/api/platform/ai-revenue-share/statements",
  operationId: "platformListAiRevenueShareStatements",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Student AI weekly statements across schools",
  description:
    "Every school's weekly statements (or those with `status`), waiting ones first: the opt-in " +
    "months each school collected that week, what it owes Studafy for them less its share, and its " +
    "licence shares that became final.",
  request: { query: statementListQuerySchema },
  responses: standardResponses(
    { 200: { description: "The statements", schema: platformStatementListSchema } },
    [400, 401, 403],
  ),
});

const detailRoute = createRoute({
  method: "get",
  path: STATEMENT_PATH,
  operationId: "platformGetAiRevenueShareStatement",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "One Student AI weekly statement",
  description:
    "The statement, its student-months (student, month, price, share) and its licence shares.",
  request: { params: statementParamsSchema },
  responses: standardResponses(
    { 200: { description: "The statement", schema: statementDetailSchema } },
    [401, 403, 404],
  ),
});

const approveRoute = createRoute({
  method: "post",
  path: `${STATEMENT_PATH}/approve`,
  operationId: "platformApproveAiRevenueShareStatement",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Approve a Student AI weekly statement",
  description:
    "Its licence shares become owed (or payout due) and are credited on the school's next invoice; " +
    "its months are billed on a statement invoice for the net, and activated when that invoice is " +
    "paid. `expectedNetMinor` and `expectedLicenceShareMinor` are the figures shown: 409 " +
    "AI_REVENUE_SHARE_STATEMENT_CHANGED when they have changed since, 409 " +
    "AI_REVENUE_SHARE_STATEMENT_DECIDED when it was already approved or rejected.",
  request: {
    params: statementParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: approveStatementBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The approved statement", schema: statementDetailSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

const holdRoute = createRoute({
  method: "post",
  path: `${STATEMENT_PATH}/hold`,
  operationId: "platformHoldAiRevenueShareStatement",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Hold a Student AI weekly statement",
  description: "It waits, with the note, and can be approved or rejected later.",
  request: {
    params: statementParamsSchema,
    body: { required: true, content: { "application/json": { schema: holdStatementBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The held statement", schema: statementDetailSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

const rejectRoute = createRoute({
  method: "post",
  path: `${STATEMENT_PATH}/reject`,
  operationId: "platformRejectAiRevenueShareStatement",
  tags: [TAG],
  security: [{ bearerAuth: [] }],
  summary: "Reject a Student AI weekly statement",
  description:
    "With a reason: its licence shares are rejected (never credited or paid); its months wait for a " +
    "later statement.",
  request: {
    params: statementParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: rejectStatementBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The rejected statement", schema: statementDetailSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

const schoolListRoute = createRoute({
  method: "get",
  path: "/api/school/ai-revenue-share/statements",
  operationId: "getAiRevenueShareStatements",
  tags: [SCHOOL_TAG],
  security: [{ bearerAuth: [] }],
  summary: "The school's Student AI weekly statements",
  description:
    "Every weekly statement, newest first: the opt-in months the school collected, what it owes " +
    "Studafy for them less its share, its licence shares, and the decision. aiRevenueShare:read " +
    "(the school admin, the principal and finance).",
  responses: standardResponses(
    { 200: { description: "The statements", schema: schoolStatementListSchema } },
    [401, 403],
  ),
});

function actorOf(c: Context<AppEnv>, kind: LicenseActor["kind"]): LicenseActor {
  const auth = requireAuth(c);
  return {
    kind,
    userId: auth.userId,
    homeSchoolId: auth.schoolId,
    requestId: c.get("requestId"),
    locale: (c.get("locale") ?? "en") as SupportedLocale,
  };
}

export function platformAiRevenueShareStatementRoutes(deps: LicensingDeps): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const manage = requirePermission(PERMISSIONS.PLATFORM_MANAGE);
  const writesOnly = (c: Context<AppEnv>, next: () => Promise<void>) =>
    c.req.method === "GET" ? next() : manage(c, next);

  const paths = [
    "/api/platform/ai-revenue-share/statements",
    "/api/platform/schools/:schoolId/ai-revenue-share/statements/:statementId",
    "/api/platform/schools/:schoolId/ai-revenue-share/statements/:statementId/*",
  ];
  for (const path of paths) routes.use(path, requireChannel(AUTH_CHANNELS.WEB));
  for (const path of paths) routes.use(path, requirePermission(PERMISSIONS.PLATFORM_READ));
  for (const path of paths) routes.use(path, writesOnly);
  routes.use(
    "/api/platform/schools/:schoolId/ai-revenue-share/statements/:statementId/approve",
    auditAction("update", "ai_programme_weekly_statements"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/ai-revenue-share/statements/:statementId/hold",
    auditAction("update", "ai_programme_weekly_statements"),
  );
  routes.use(
    "/api/platform/schools/:schoolId/ai-revenue-share/statements/:statementId/reject",
    auditAction("update", "ai_programme_weekly_statements"),
  );

  routes.openapi(listRoute, async (c) => {
    const query = c.req.valid("query");
    const statements = await listStatementsAcrossSchools(
      deps.database,
      query.status ? { status: query.status } : {},
    );
    return c.json({ statements }, 200);
  });

  routes.openapi(detailRoute, async (c) => {
    const { schoolId, statementId } = c.req.valid("param");
    const actor = actorOf(c, "platform");
    const detail = await readInSchool(deps, schoolId, actor, (tx) =>
      statementDetail(tx, statementId),
    );
    if (!detail) throw licenseError(404, ERROR_CODES.RESOURCE_NOT_FOUND, actor.locale);
    return c.json(detail, 200);
  });

  routes.openapi(approveRoute, async (c) => {
    const { schoolId, statementId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = actorOf(c, "platform");
    const { result } = await runLicenseChange(deps, schoolId, actor, async (tx) => ({
      result: await approveStatement(tx, schoolId, statementId, body, actor),
      versions: new Map<string, number>(),
      pending: [],
    }));
    return c.json(result, 200);
  });

  routes.openapi(holdRoute, async (c) => {
    const { schoolId, statementId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = actorOf(c, "platform");
    const detail = await readInSchool(deps, schoolId, actor, (tx) =>
      holdStatement(tx, schoolId, statementId, body.note, actor),
    );
    return c.json(detail, 200);
  });

  routes.openapi(rejectRoute, async (c) => {
    const { schoolId, statementId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = actorOf(c, "platform");
    const detail = await readInSchool(deps, schoolId, actor, (tx) =>
      rejectStatement(tx, schoolId, statementId, body.reason, actor),
    );
    return c.json(detail, 200);
  });

  return routes;
}

export function schoolAiRevenueShareStatementRoutes(deps: LicensingDeps): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  routes.use(
    "/api/school/ai-revenue-share/statements",
    requirePermission(PERMISSIONS.AI_REVENUE_SHARE_READ),
  );

  routes.openapi(schoolListRoute, async (c) => {
    const actor = actorOf(c, "school");
    const statements = await readInSchool(deps, actor.homeSchoolId, actor, (tx) =>
      schoolStatements(tx),
    );
    return c.json({ statements }, 200);
  });

  return routes;
}
