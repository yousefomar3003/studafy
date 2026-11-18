import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { onlyMethods } from "../../../middleware/only-methods";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";

import {
  studentAiBillingSettingsSchema,
  studentAiFinanceLineListSchema,
  studentAiLinesQuerySchema,
  studentAiSettingsResultSchema,
  studentAiSyncSummarySchema,
  updateStudentAiBillingSettingsBodySchema,
} from "./schemas";
import {
  getStudentAiBillingSettings,
  listStudentAiLines,
  setStudentAiAutoBilling,
  syncSchoolStudentAiFeeItems,
  withStudentAiTx,
} from "./service";

import type { StudentAiSyncResult } from "./service";
import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { z } from "@hono/zod-openapi";
import type { Context } from "hono";

const getSettingsRoute = createRoute({
  method: "get",
  path: "/api/finance/student-ai/settings",
  tags: ["Finance"],
  operationId: "getStudentAiBillingSettings",
  summary: "Read whether the Student AI line is billed on the fee schedule",
  description:
    "On by default: each opted-in student's Student AI line (parent price per month x months to " +
    "the end of the academic year) is spread over their tuition instalments and invoiced with " +
    "them. Off: the school bills it itself; parents still see the line, paid with tuition.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The setting.", schema: studentAiBillingSettingsSchema } },
    [401, 403, 500],
  ),
});

const putSettingsRoute = createRoute({
  method: "put",
  path: "/api/finance/student-ai/settings",
  tags: ["Finance"],
  operationId: "updateStudentAiBillingSettings",
  summary: "Switch Student AI auto-billing on or off",
  description:
    "Affects only what is not yet invoiced. Off removes the planned portions (the school bills " +
    "the rest); back on plans the months from the current month on, so nothing the school billed " +
    "meanwhile is billed twice. Invoiced amounts never change.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: updateStudentAiBillingSettingsBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The saved setting.", schema: studentAiSettingsResultSchema } },
    [400, 401, 403, 500],
  ),
});

const listLinesRoute = createRoute({
  method: "get",
  path: "/api/finance/student-ai/lines",
  tags: ["Finance"],
  operationId: "listStudentAiLines",
  summary: "List the Student AI lines on students' fees",
  description:
    "One line per opted-in student per academic year: price per month, months, total, what is " +
    "already invoiced and what is still planned.",
  security: [{ bearerAuth: [] }],
  request: { query: studentAiLinesQuerySchema },
  responses: standardResponses(
    { 200: { description: "The lines.", schema: studentAiFinanceLineListSchema } },
    [400, 401, 403, 500],
  ),
});

const syncRoute = createRoute({
  method: "post",
  path: "/api/finance/student-ai/sync",
  tags: ["Finance"],
  operationId: "syncStudentAiLines",
  summary: "Recalculate the Student AI lines",
  description:
    "Brings every line and its planned portions in line with the opt-ins, the instalments and " +
    "the auto-billing setting. Safe to repeat; invoiced portions are never changed.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "What changed.", schema: studentAiSyncSummarySchema } },
    [401, 403, 500],
  ),
});

export function summarizeStudentAiSync(
  results: readonly StudentAiSyncResult[],
): z.infer<typeof studentAiSyncSummarySchema> {
  const summary = {
    students: results.length,
    created: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    skipped_no_price: 0,
  };
  for (const item of results.flatMap((result) => result.items)) {
    if (item.action === "created") summary.created += 1;
    else if (item.action === "updated") summary.updated += 1;
    else if (item.action === "removed") summary.removed += 1;
    else if (item.action === "unchanged") summary.unchanged += 1;
    else if (item.action === "skipped_no_price") summary.skipped_no_price += 1;
  }
  return summary;
}

function actorOf(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

/**
 * The school's Student AI tuition line (phase 3 of the AI revenue-share programme, 000238): the
 * auto-billing switch, finance's list of lines and the recalculation. Reads on `billing:read`,
 * changes on `billing:update`. They run in the finance system transaction because the lines are
 * per student, which finance staff do not read directly (as every finance student read).
 */
export function studentAiFinanceRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/finance/student-ai/settings", requirePermission(PERMISSIONS.BILLING_READ));
  routes.use(
    "/api/finance/student-ai/settings",
    onlyMethods(["PUT"], auditAction("update", "student_ai_billing_settings")),
  );
  routes.use(
    "/api/finance/student-ai/settings",
    onlyMethods(["PUT"], requirePermission(PERMISSIONS.BILLING_UPDATE)),
  );
  routes.use("/api/finance/student-ai/lines", requirePermission(PERMISSIONS.BILLING_READ));
  routes.use("/api/finance/student-ai/sync", auditAction("update", "student_ai_fee_items"));
  routes.use("/api/finance/student-ai/sync", requirePermission(PERMISSIONS.BILLING_UPDATE));

  routes.openapi(getSettingsRoute, async (c) => {
    const actor = actorOf(c);
    const settings = await withStudentAiTx(database, actor, (tx) =>
      getStudentAiBillingSettings(tx, actor.schoolId),
    );
    return c.json(settings, 200);
  });

  routes.openapi(putSettingsRoute, async (c) => {
    const actor = actorOf(c);
    const { auto_billing } = c.req.valid("json");
    const { settings, results } = await withStudentAiTx(database, actor, (tx) =>
      setStudentAiAutoBilling(tx, actor.schoolId, actor.userId, auto_billing),
    );
    return c.json({ settings, sync: summarizeStudentAiSync(results) }, 200);
  });

  routes.openapi(listLinesRoute, async (c) => {
    const actor = actorOf(c);
    const { academic_year_id } = c.req.valid("query");
    const lines = await withStudentAiTx(database, actor, (tx) =>
      listStudentAiLines(tx, actor.schoolId, academic_year_id),
    );
    return c.json({ lines }, 200);
  });

  routes.openapi(syncRoute, async (c) => {
    const actor = actorOf(c);
    const results = await withStudentAiTx(database, actor, (tx) =>
      syncSchoolStudentAiFeeItems(tx, actor.schoolId),
    );
    return c.json(summarizeStudentAiSync(results), 200);
  });

  return routes;
}
