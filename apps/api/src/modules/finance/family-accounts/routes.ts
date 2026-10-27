import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { auditAction, emitAuditLog } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { onlyMethods } from "../../../middleware/only-methods";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { sendFamilyReminder, sendFamilyStatement } from "../communications/service";
import { withFinanceActorTx, withStudentIdentityTx } from "../students/service";

import {
  bulkReminderBodySchema,
  bulkReminderResultSchema,
  createFamilyPaymentBodySchema,
  familyIdParamSchema,
  familyListQuerySchema,
  familyListSchema,
  familyPaymentResponseSchema,
  familyProfileSchema,
  familySendResultSchema,
  idempotencyHeaderSchema,
} from "./schemas";
import {
  getFamilyAccount,
  listFamilyAccounts,
  overdueFamilyIds,
  recordFamilyPayment,
} from "./service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { TenantErpNextFactory } from "../client/tenant-client";
import type { ReminderOutcome, StatementOutcome } from "../communications/service";
import type { Context } from "hono";
import type { TransactionSql } from "postgres";

function actorFrom(c: Context<AppEnv>) {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

const listDef = createRoute({
  method: "get",
  path: "/api/finance/families",
  tags: ["Finance"],
  operationId: "listFinanceFamilies",
  summary: "List families with their balances",
  description:
    "Every family in the school with its guardians, its children (eldest first, with the sibling " +
    "discount each one's next invoice gets) and per-currency totals across the children's issued " +
    "invoices. Filter to sibling families with `min_children=2`, or to families that owe money.",
  security: [{ bearerAuth: [] }],
  request: { query: familyListQuerySchema },
  responses: standardResponses(
    { 200: { description: "One page of families.", schema: familyListSchema } },
    [400, 401, 403, 500],
  ),
});

const profileDef = createRoute({
  method: "get",
  path: "/api/finance/families/{familyId}/profile",
  tags: ["Finance"],
  operationId: "getFinanceFamilyProfile",
  summary: "Read one family's finance profile",
  description:
    "The family as the list shows it, plus the last 50 fee messages sent to its guardians. The " +
    "invoices, installments and payments themselves come from `GET /api/finance/families/{familyId}`.",
  security: [{ bearerAuth: [] }],
  request: { params: familyIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The family.", schema: familyProfileSchema } },
    [401, 403, 404, 500],
  ),
});

const paymentDef = createRoute({
  method: "post",
  path: "/api/finance/families/{familyId}/payments",
  tags: ["Finance"],
  operationId: "createFamilyPayment",
  summary: "Record one payment across a family's invoices",
  description:
    "Records what a family paid in one go — one ERPNext Payment Entry per invoice it covers. " +
    "Without `allocations`, the oldest-due invoices are paid first. An amount larger than the " +
    "family owes in that currency is refused.\n\n" +
    "`Idempotency-Key` is required. Each invoice's share is posted under a key derived from it and " +
    "the invoice, so retrying the same request after a `partial` outcome pays only what is left.",
  security: [{ bearerAuth: [] }],
  request: {
    headers: idempotencyHeaderSchema,
    params: familyIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: createFamilyPaymentBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "What happened to each share.", schema: familyPaymentResponseSchema } },
    [400, 401, 403, 404, 409, 500, 502, 503],
  ),
});

const reminderDef = createRoute({
  method: "post",
  path: "/api/finance/families/{familyId}/reminders",
  tags: ["Finance"],
  operationId: "sendFamilyReminder",
  summary: "Remind a family of its overdue fees",
  description:
    "Notifies the family's guardians of the amount overdue across their children's invoices. Not " +
    "sent when nothing is overdue, or when the family was reminded in the last 24 hours; the " +
    "`status` says which.",
  security: [{ bearerAuth: [] }],
  request: { params: familyIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The outcome.", schema: familySendResultSchema } },
    [401, 403, 404, 500],
  ),
});

const statementDef = createRoute({
  method: "post",
  path: "/api/finance/families/{familyId}/statements",
  tags: ["Finance"],
  operationId: "sendFamilyStatement",
  summary: "Send a family its fee statement",
  description:
    "Notifies the family's guardians of their outstanding balance across all their children; the " +
    "app shows the per-child detail.",
  security: [{ bearerAuth: [] }],
  request: { params: familyIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The outcome.", schema: familySendResultSchema } },
    [401, 403, 404, 500],
  ),
});

const bulkReminderDef = createRoute({
  method: "post",
  path: "/api/finance/reminders",
  tags: ["Finance"],
  operationId: "sendBulkReminders",
  summary: "Remind every family with overdue fees",
  description:
    "Sends the overdue reminder to each listed family, or to every family with an overdue balance. " +
    "Families reminded in the last 24 hours are skipped, so running it twice in a day is harmless.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: false,
      content: { "application/json": { schema: bulkReminderBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "How many families were reminded.", schema: bulkReminderResultSchema } },
    [400, 401, 403, 500],
  ),
});

function sendResult(outcome: ReminderOutcome | StatementOutcome) {
  return {
    status: outcome.status,
    delivered: outcome.status === "sent" ? outcome.result.delivered : 0,
    suppressed: outcome.status === "sent" ? outcome.result.suppressed : 0,
    last_reminder_at:
      outcome.status === "recently_reminded" ? outcome.lastReminderAt.toISOString() : null,
  };
}

async function auditSend(
  tx: TransactionSql,
  familyId: string,
  kind: "payment_reminder" | "statement",
  outcome: ReminderOutcome | StatementOutcome,
): Promise<void> {
  if (outcome.status !== "sent") return;
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "finance_communications",
    targetId: familyId,
    newValues: {
      kind,
      family_id: familyId,
      delivered: outcome.result.delivered,
      suppressed: outcome.result.suppressed,
    },
  });
}

/**
 * Family-level finance (list, profile, one payment across invoices, reminders, statements).
 *
 * Reading is billing:read; anything that posts to ERPNext or notifies a family is billing:update —
 * the same split as the single-invoice payment routes. Both the bare paths and their sub-paths are
 * guarded.
 */
export function familyAccountRoutes(
  database: Database,
  erpnextFactory: TenantErpNextFactory,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/finance/families", requirePermission(PERMISSIONS.BILLING_READ));
  routes.use(
    "/api/finance/families/:familyId/profile",
    requirePermission(PERMISSIONS.BILLING_READ),
  );
  for (const [path, table] of [
    ["/api/finance/families/:familyId/payments", "payment_cache"],
    ["/api/finance/families/:familyId/reminders", "finance_communications"],
    ["/api/finance/families/:familyId/statements", "finance_communications"],
    ["/api/finance/reminders", "finance_communications"],
  ] as const) {
    routes.use(path, onlyMethods(["POST"], auditAction("insert", table)));
    routes.use(path, requirePermission(PERMISSIONS.BILLING_UPDATE));
  }

  routes.openapi(listDef, async (c) => {
    const { schoolId } = requireAuth(c);
    const result = await withStudentIdentityTx(database, schoolId, (tx) =>
      listFamilyAccounts(tx, schoolId, c.req.valid("query")),
    );
    return c.json(result, 200);
  });

  routes.openapi(profileDef, async (c) => {
    const { schoolId } = requireAuth(c);
    const { familyId } = c.req.valid("param");
    const family = await withStudentIdentityTx(database, schoolId, (tx) =>
      getFamilyAccount(tx, schoolId, familyId),
    );
    if (!family) {
      throw new CodedHttpException(404, ERROR_CODES.FAMILY_NOT_FOUND, "Family not found");
    }
    return c.json(family, 200);
  });

  routes.openapi(paymentDef, async (c) => {
    const actor = actorFrom(c);
    const { familyId } = c.req.valid("param");
    const result = await recordFamilyPayment(
      database,
      erpnextFactory,
      actor,
      familyId,
      c.req.valid("json"),
      c.req.valid("header")["idempotency-key"],
      c.req.header("accept-language"),
    );
    return c.json(result, 200);
  });

  routes.openapi(reminderDef, async (c) => {
    const actor = actorFrom(c);
    const { familyId } = c.req.valid("param");
    const outcome = await withFinanceActorTx(database, actor, async (tx) => {
      const sent = await sendFamilyReminder(tx, actor.schoolId, familyId, actor.userId);
      if (sent) await auditSend(tx, familyId, "payment_reminder", sent);
      return sent;
    });
    if (!outcome) {
      throw new CodedHttpException(404, ERROR_CODES.FAMILY_NOT_FOUND, "Family not found");
    }
    return c.json(sendResult(outcome), 200);
  });

  routes.openapi(statementDef, async (c) => {
    const actor = actorFrom(c);
    const { familyId } = c.req.valid("param");
    const outcome = await withFinanceActorTx(database, actor, async (tx) => {
      const sent = await sendFamilyStatement(tx, actor.schoolId, familyId, actor.userId);
      if (sent) await auditSend(tx, familyId, "statement", sent);
      return sent;
    });
    if (!outcome) {
      throw new CodedHttpException(404, ERROR_CODES.FAMILY_NOT_FOUND, "Family not found");
    }
    return c.json(sendResult(outcome), 200);
  });

  routes.openapi(bulkReminderDef, async (c) => {
    const actor = actorFrom(c);
    const body = c.req.valid("json") as { family_ids?: string[] } | undefined;
    const familyIds =
      body?.family_ids ??
      (await withStudentIdentityTx(database, actor.schoolId, (tx) =>
        overdueFamilyIds(tx, actor.schoolId),
      ));

    const summary = {
      families: familyIds.length,
      sent: 0,
      recently_reminded: 0,
      nothing_overdue: 0,
      no_guardians: 0,
      delivered: 0,
    };
    // One transaction per family: one family's failure must not undo the reminders already sent.
    for (const familyId of [...new Set(familyIds)]) {
      const outcome = await withFinanceActorTx(database, actor, async (tx) => {
        const sent = await sendFamilyReminder(tx, actor.schoolId, familyId, actor.userId);
        if (sent) await auditSend(tx, familyId, "payment_reminder", sent);
        return sent;
      });
      if (!outcome) continue;
      summary[outcome.status] += 1;
      if (outcome.status === "sent") summary.delivered += outcome.result.delivered;
    }
    return c.json(summary, 200);
  });

  return routes;
}
