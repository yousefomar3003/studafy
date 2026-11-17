import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { auditAction } from "../../middleware/auditEmitter";
import { requireAuth } from "../../middleware/authContext";
import { requirePermission } from "../../middleware/authz";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";

import {
  closeWindow,
  listOptInStudents,
  openWindow,
  parentOffers,
  parentOptIn,
  recordOnBehalf,
  releaseOptIn,
  schoolAiOptInOverview,
  transferOptIn,
} from "./ai-optin";
import {
  aiOptInSchema,
  aiOptInWindowSchema,
  openWindowBodySchema,
  optInParamsSchema,
  optInStudentListSchema,
  optInStudentsQuerySchema,
  parentOffersSchema,
  parentOptInBodySchema,
  recordOnBehalfBodySchema,
  recordResultSchema,
  releaseBodySchema,
  schoolAiOptInOverviewSchema,
  transferBodySchema,
  transferResultSchema,
  windowParamsSchema,
} from "./ai-optin-schemas";
import { readInSchool, runLicenseChange } from "./service";

import type { LicenseActor } from "./context";
import type { LicensingDeps } from "./service";
import type { SupportedLocale } from "../../middleware/locale";
import type { AppEnv } from "../../middleware/requestId";
import type { Context } from "hono";

/**
 * Student AI opt-in (phase 2 of the Student AI programme, 000235, docs/billing/ai-programme.md).
 *
 * School (license:read to read, license:manage to change; ORG_ADMIN and PRINCIPAL), under
 * /api/school/license/student-ai: the overview, open and close a window, the students with their
 * opt-in, record opt-ins on parents' behalf, and transfer or release a seat when a student leaves.
 *
 * Parent (studentAi:optIn; PARENT only), under /api/parent/student-ai: the offer per linked child at
 * this school (a parent with children at several schools has an account per school and sees each
 * school's offer in that account), and the opt-in itself. Every change is audited in the service.
 */

const TAG = "Licensing";

const overviewRoute = createRoute({
  method: "get",
  path: "/api/school/license/student-ai",
  tags: [TAG],
  operationId: "getSchoolStudentAi",
  summary: "Student AI opt-in: the school's window, counts and seats",
  description:
    "The licence opt-ins fill (seats and assigned student seats), the price parents see and the " +
    "minimum seats from the licence's programme values, the current or latest window, what a " +
    "student opting in today commits to (months follow the school's academic year), counts " +
    "(eligible, opted in, waiting for a seat, released, transferred), the seats the licence needs, " +
    "the open automatic seat request, and why a window cannot be opened, if it cannot.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The overview", schema: schoolAiOptInOverviewSchema } },
    [401, 403],
  ),
});

const openWindowRoute = createRoute({
  method: "post",
  path: "/api/school/license/student-ai/windows",
  tags: [TAG],
  operationId: "openStudentAiWindow",
  summary: "Open a Student AI opt-in window",
  description:
    "Opens a window on the school's licence (active or awaiting payment, with a student tier and a " +
    "parent price in its currency: 409 AI_OPTIN_NO_LICENCE / AI_OPTIN_PRICE_MISSING otherwise) for " +
    "an academic year, optionally for some grades or sections only. The school must accept the " +
    "programme's minimum seats (`acknowledgeMinimumSeats`); when the licence has fewer, Studafy is " +
    "asked for them (an automatic seat request). Parents of eligible children are notified. 409 " +
    "AI_OPTIN_WINDOW_ALREADY_OPEN while another window is open.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: openWindowBodySchema } } },
  },
  responses: standardResponses(
    { 201: { description: "The window", schema: aiOptInWindowSchema } },
    [400, 401, 403, 409, 422],
  ),
});

const closeWindowRoute = createRoute({
  method: "post",
  path: "/api/school/license/student-ai/windows/{windowId}/close",
  tags: [TAG],
  operationId: "closeStudentAiWindow",
  summary: "Close a Student AI opt-in window",
  description: "Parents can no longer opt in through it. Opt-ins already made stand.",
  security: [{ bearerAuth: [] }],
  request: { params: windowParamsSchema },
  responses: standardResponses(
    { 200: { description: "The closed window", schema: aiOptInWindowSchema } },
    [401, 403, 404],
  ),
});

const studentsRoute = createRoute({
  method: "get",
  path: "/api/school/license/student-ai/students",
  tags: [TAG],
  operationId: "listStudentAiStudents",
  summary: "Students and their Student AI opt-in",
  description:
    "The academic year's students with their opt-in: filter all, opted in, not opted in, waiting " +
    "for a seat, or left the school while holding a seat; by grade or section; search by name or " +
    "admission number.",
  security: [{ bearerAuth: [] }],
  request: { query: optInStudentsQuerySchema },
  responses: standardResponses(
    { 200: { description: "Students", schema: optInStudentListSchema } },
    [400, 401, 403],
  ),
});

const recordRoute = createRoute({
  method: "post",
  path: "/api/school/license/student-ai/opt-ins",
  tags: [TAG],
  operationId: "recordStudentAiOptIns",
  summary: "Record opt-ins on parents' behalf",
  description:
    "One student, many, or a CSV's admission numbers, with a required note (recorded on the " +
    "parent's behalf). Same open window, eligibility and price as a parent's opt-in; each student is " +
    "reported recorded or not, and why. Recorded opt-ins get a seat while the licence has one free, " +
    "and their parents are notified. 409 AI_OPTIN_WINDOW_CLOSED when no window is open.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: recordOnBehalfBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "Recorded and not recorded", schema: recordResultSchema } },
    [400, 401, 403, 409],
  ),
});

const transferRoute = createRoute({
  method: "post",
  path: "/api/school/license/student-ai/opt-ins/{optInId}/transfer",
  tags: [TAG],
  operationId: "transferStudentAiOptIn",
  summary: "Transfer a leaving student's Student AI seat",
  description:
    "Only for a student who has left the school (409 AI_OPTIN_STUDENT_NOT_LEFT): the seat goes to " +
    "another enrolled student for the rest of the year, with no billing change.",
  security: [{ bearerAuth: [] }],
  request: {
    params: optInParamsSchema,
    body: { required: true, content: { "application/json": { schema: transferBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The ended and the new opt-in", schema: transferResultSchema } },
    [400, 401, 403, 404, 409, 422],
  ),
});

const releaseRoute = createRoute({
  method: "post",
  path: "/api/school/license/student-ai/opt-ins/{optInId}/release",
  tags: [TAG],
  operationId: "releaseStudentAiOptIn",
  summary: "Release a leaving student's Student AI seat",
  description:
    "Only for a student who has left the school (409 AI_OPTIN_STUDENT_NOT_LEFT): the seat is no " +
    "longer charged from the next month (`releasedEffectiveMonth`) and frees for a student waiting.",
  security: [{ bearerAuth: [] }],
  request: {
    params: optInParamsSchema,
    body: { required: true, content: { "application/json": { schema: releaseBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "The released opt-in", schema: aiOptInSchema } },
    [400, 401, 403, 404, 409],
  ),
});

const parentOffersRoute = createRoute({
  method: "get",
  path: "/api/parent/student-ai",
  tags: [TAG],
  operationId: "getParentStudentAi",
  summary: "Student AI for my children at this school",
  description:
    "Per linked child: the offer while the school's window is open for them (monthly price × the " +
    "months left in the school's academic year = total, paid with tuition), their opt-in once they " +
    "have one, or that the window is closed. Children the school never offered it to are left out.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The offers", schema: parentOffersSchema } },
    [401, 403],
  ),
});

const parentOptInRoute = createRoute({
  method: "post",
  path: "/api/parent/student-ai/opt-ins",
  tags: [TAG],
  operationId: "optInParentStudentAi",
  summary: "Opt my child in to Student AI",
  description:
    "Committed for the rest of the school year, paid with tuition, and it can't be cancelled " +
    "mid-year: the parent must accept the terms (`acceptTerms`, current `termsVersion`; 422 " +
    "AI_OPTIN_TERMS_REQUIRED) and confirm the total they were shown (409 AI_OPTIN_PRICE_CHANGED). " +
    "422 AI_OPTIN_NOT_ELIGIBLE for a child not theirs or not in the window; 409 " +
    "AI_OPTIN_WINDOW_CLOSED / AI_OPTIN_ALREADY_OPTED_IN.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: parentOptInBodySchema } } },
  },
  responses: standardResponses(
    { 201: { description: "The opt-in", schema: aiOptInSchema } },
    [400, 401, 403, 409, 422],
  ),
});

function actorOf(c: Context<AppEnv>): LicenseActor & { schoolId: string } {
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

const unchanged = <T>(result: T) => ({ result, versions: new Map<string, number>(), pending: [] });

export function aiOptInRoutes(deps: LicensingDeps): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  const manage = requirePermission(PERMISSIONS.LICENSE_MANAGE);
  const writesOnly = (c: Context<AppEnv>, next: () => Promise<void>) =>
    c.req.method === "GET" ? next() : manage(c, next);

  routes.use("/api/school/license/student-ai", requirePermission(PERMISSIONS.LICENSE_READ));
  routes.use("/api/school/license/student-ai/*", requirePermission(PERMISSIONS.LICENSE_READ));
  routes.use("/api/school/license/student-ai/*", writesOnly);
  routes.use("/api/school/license/student-ai/windows", auditAction("insert", "ai_optin_windows"));
  routes.use(
    "/api/school/license/student-ai/windows/:windowId/close",
    auditAction("update", "ai_optin_windows"),
  );
  routes.use("/api/school/license/student-ai/opt-ins", auditAction("insert", "ai_optins"));
  routes.use(
    "/api/school/license/student-ai/opt-ins/:optInId/transfer",
    auditAction("update", "ai_optins"),
  );
  routes.use(
    "/api/school/license/student-ai/opt-ins/:optInId/release",
    auditAction("update", "ai_optins"),
  );
  routes.use("/api/parent/student-ai", requirePermission(PERMISSIONS.STUDENT_AI_OPT_IN));
  routes.use("/api/parent/student-ai/*", requirePermission(PERMISSIONS.STUDENT_AI_OPT_IN));
  routes.use("/api/parent/student-ai/opt-ins", auditAction("insert", "ai_optins"));

  routes.openapi(overviewRoute, async (c) => {
    const actor = actorOf(c);
    const overview = await readInSchool(deps, actor.schoolId, actor, (tx) =>
      schoolAiOptInOverview(tx),
    );
    return c.json(overview, 200);
  });

  routes.openapi(openWindowRoute, async (c) => {
    const actor = actorOf(c);
    const body = c.req.valid("json");
    const { result } = await runLicenseChange(deps, actor.schoolId, actor, async (tx) =>
      unchanged(await openWindow(tx, actor.schoolId, body, actor)),
    );
    return c.json(result, 201);
  });

  routes.openapi(closeWindowRoute, async (c) => {
    const actor = actorOf(c);
    const { windowId } = c.req.valid("param");
    const { result } = await runLicenseChange(deps, actor.schoolId, actor, async (tx) =>
      unchanged(await closeWindow(tx, actor.schoolId, windowId, actor)),
    );
    return c.json(result, 200);
  });

  routes.openapi(studentsRoute, async (c) => {
    const actor = actorOf(c);
    const query = c.req.valid("query");
    const list = await readInSchool(deps, actor.schoolId, actor, (tx) =>
      listOptInStudents(tx, query),
    );
    return c.json({ ...list, filter: query.filter }, 200);
  });

  routes.openapi(recordRoute, async (c) => {
    const actor = actorOf(c);
    const body = c.req.valid("json");
    const { result } = await runLicenseChange(deps, actor.schoolId, actor, (tx) =>
      recordOnBehalf(tx, actor.schoolId, body, actor),
    );
    return c.json(result, 200);
  });

  routes.openapi(transferRoute, async (c) => {
    const actor = actorOf(c);
    const { optInId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { result } = await runLicenseChange(deps, actor.schoolId, actor, (tx) =>
      transferOptIn(tx, actor.schoolId, optInId, body, actor),
    );
    return c.json(result, 200);
  });

  routes.openapi(releaseRoute, async (c) => {
    const actor = actorOf(c);
    const { optInId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { result } = await runLicenseChange(deps, actor.schoolId, actor, (tx) =>
      releaseOptIn(tx, actor.schoolId, optInId, body, actor),
    );
    return c.json(result, 200);
  });

  routes.openapi(parentOffersRoute, async (c) => {
    const actor = actorOf(c);
    const offers = await readInSchool(deps, actor.schoolId, actor, (tx) =>
      parentOffers(tx, actor.userId),
    );
    return c.json(offers, 200);
  });

  routes.openapi(parentOptInRoute, async (c) => {
    const actor = actorOf(c);
    const body = c.req.valid("json");
    const { result } = await runLicenseChange(deps, actor.schoolId, actor, (tx) =>
      parentOptIn(tx, actor.schoolId, body, actor),
    );
    return c.json(result, 201);
  });

  return routes;
}
