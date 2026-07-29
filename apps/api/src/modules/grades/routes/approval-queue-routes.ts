import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import {
  approvalQueueListSchema,
  bulkDecisionBodySchema,
  bulkDecisionResultSchema,
  gradeSubmissionDiffSchema,
  timetableVersionDiffSchema,
} from "../approval-queue-schemas";
import { bulkDecision, listPendingApprovals } from "../approval-queue-service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { ApprovalQueueRow } from "../approval-queue-service";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tenantFrom(c: Context<AppEnv>): {
  schoolId: string;
  userId: string;
  requestId?: string;
} {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function toApprovalQueueItem(row: ApprovalQueueRow) {
  return {
    id: row.id,
    item_type: row.item_type,
    status: row.status,
    summary: row.summary,
    requested_by_user_id: row.requested_by_user_id,
    requested_by_display_name: row.requested_by_display_name,
    requested_at: row.requested_at?.toISOString() ?? null,
    decided_at: row.decided_at?.toISOString() ?? null,
    diff: row.diff as z.infer<typeof gradeSubmissionDiffSchema | typeof timetableVersionDiffSchema>,
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listApprovalQueueRoute = createRoute({
  method: "get",
  path: "/api/approvals/queue",
  tags: ["Approval Queue"],
  operationId: "listApprovalQueue",
  summary: "List pending approval items",
  description:
    "Returns a unified feed of all items awaiting administrative approval, " +
    "including grade submissions and timetable versions. " +
    "Each item carries a type-specific diff payload describing the pending change. " +
    "Results are sorted by submission time descending.",
  security: [{ bearerAuth: [] }],
  request: {},
  responses: standardResponses(
    { 200: { description: "List of pending approval items.", schema: approvalQueueListSchema } },
    [401, 403, 500],
  ),
});

const bulkDecisionRoute = createRoute({
  method: "post",
  path: "/api/approvals/bulk-decision",
  tags: ["Approval Queue"],
  operationId: "bulkApprovalDecision",
  summary: "Bulk approve or reject pending items",
  description:
    "Process up to 50 approval decisions atomically. Each item is handled in its own " +
    "transactional scope within the request transaction; if one item fails the others " +
    "still succeed. Returns a per-item result array with a summary of succeeded/failed counts. " +
    "Each decision is individually audited via the existing grade/timetable audit infrastructure.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: bulkDecisionBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "Per-item decision results with summary.",
        schema: bulkDecisionResultSchema,
      },
    },
    [400, 401, 403, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function approvalQueueRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/approvals/*", requirePermission(PERMISSIONS.APPROVAL_REVIEW));
  routes.use("/api/approvals/bulk-decision", auditAction("update", "approval_queue"));

  // --- List pending approvals ---

  routes.openapi(listApprovalQueueRoute, async (c) => {
    const auth = requireAuth(c);

    const { items, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listPendingApprovals(tx, auth.schoolId),
    );

    return c.json({ items: items.map(toApprovalQueueItem), total }, 200);
  });

  // --- Bulk decision ---

  routes.openapi(bulkDecisionRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");

    const result = await withTenantTx(database, tenantFrom(c), (tx) =>
      bulkDecision(tx, auth.schoolId, auth.userId, body.items),
    );

    return c.json(result, 200);
  });

  return routes;
}
