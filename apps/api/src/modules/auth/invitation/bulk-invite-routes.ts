import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { QUEUE_NAMES, PERMISSIONS } from "@studafy/constants";
import { Queue } from "bullmq";

import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";

import {
  createBulkInvite,
  getBulkInvite,
  getBulkInviteRecipients,
  listBulkInvites,
  resetFailedRecipients,
} from "./bulk-invite-service";
import {
  bulkInviteBodySchema,
  bulkInviteIdPathParams,
  bulkInviteListResponseSchema,
  bulkInviteRecipientsQuerySchema,
  bulkInviteRecipientsResponseSchema,
  bulkInviteResponseSchema,
} from "./schemas";

import type { BulkInviteRecord } from "./bulk-invite-service";
import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { RedisClient } from "../../../redis";
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

function toBulkInviteResponse(record: BulkInviteRecord) {
  return {
    id: record.id,
    status: record.status,
    role: record.role,
    expiry_days: record.expiry_days,
    target_mode: record.target_mode,
    total_count: record.total_count,
    sent_count: record.sent_count,
    failed_count: record.failed_count,
    created_at: record.created_at.toISOString(),
    updated_at: record.updated_at.toISOString(),
    completed_at: record.completed_at?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const createBulkInviteRoute = createRoute({
  method: "post",
  path: "/api/invitations/bulk",
  tags: ["Invitations"],
  operationId: "createBulkInvite",
  summary: "Create a bulk invitation batch",
  description:
    "Issues invitations to a list of email addresses in one batch. Each recipient is " +
    "individually tracked; failures are retriable. Dispatches async processing to " +
    "the notifications worker queue.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: bulkInviteBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "Bulk invite batch created and queued for processing.",
        schema: bulkInviteResponseSchema,
      },
    },
    [400, 401, 403, 429, 500],
  ),
});

const listBulkInvitesRoute = createRoute({
  method: "get",
  path: "/api/invitations/bulk",
  tags: ["Invitations"],
  operationId: "listBulkInvites",
  summary: "List bulk invitation batches",
  description:
    "Paginated, cursor-based list of bulk invitation batches for the authenticated school.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(20),
      cursor: z.string().min(1).optional(),
    }),
  },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of bulk invite batches.",
        schema: bulkInviteListResponseSchema,
      },
    },
    [401, 403, 429, 500],
  ),
});

const getBulkInviteRoute = createRoute({
  method: "get",
  path: "/api/invitations/bulk/{bulkInviteId}",
  tags: ["Invitations"],
  operationId: "getBulkInvite",
  summary: "Get bulk invite batch status",
  description: "Returns the bulk invite record including per-recipient dispatch counts.",
  security: [{ bearerAuth: [] }],
  request: { params: bulkInviteIdPathParams },
  responses: standardResponses(
    {
      200: {
        description: "The bulk invite record.",
        schema: bulkInviteResponseSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const getBulkInviteRecipientsRoute = createRoute({
  method: "get",
  path: "/api/invitations/bulk/{bulkInviteId}/recipients",
  tags: ["Invitations"],
  operationId: "getBulkInviteRecipients",
  summary: "List recipients for a bulk invite",
  description: "Paginated, cursor-based list of recipients with individual invitation status.",
  security: [{ bearerAuth: [] }],
  request: {
    params: bulkInviteIdPathParams,
    query: bulkInviteRecipientsQuerySchema,
  },
  responses: standardResponses(
    {
      200: {
        description: "Paginated list of recipients.",
        schema: bulkInviteRecipientsResponseSchema,
      },
    },
    [401, 403, 404, 500],
  ),
});

const retryBulkInviteRoute = createRoute({
  method: "post",
  path: "/api/invitations/bulk/{bulkInviteId}/retry",
  tags: ["Invitations"],
  operationId: "retryBulkInvite",
  summary: "Retry failed invitations in a bulk batch",
  description:
    "Resets all failed recipients back to pending and re-dispatches the batch to " +
    "the notifications worker queue for processing.",
  security: [{ bearerAuth: [] }],
  request: { params: bulkInviteIdPathParams },
  responses: standardResponses(
    {
      200: {
        description: "Failed recipients reset and batch re-queued.",
        schema: bulkInviteResponseSchema,
      },
    },
    [400, 401, 403, 404, 409, 429, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route group factory
// ---------------------------------------------------------------------------

export function bulkInviteRoutes(
  database: Database,
  redis: RedisClient | null,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  const notificationsQueue = redis
    ? new Queue(QUEUE_NAMES.NOTIFICATIONS, { connection: redis as never })
    : null;

  // Channel guard: web only.
  const channelGuard = requireChannel(AUTH_CHANNELS.WEB);
  routes.use("/api/invitations/bulk", channelGuard);
  routes.use("/api/invitations/bulk/*", channelGuard);

  // Permission gates.
  routes.use("/api/invitations/bulk", requirePermission(PERMISSIONS.USER_INVITE));
  routes.use("/api/invitations/bulk/*", requirePermission(PERMISSIONS.USER_INVITE));

  // Audit declarations.
  routes.use("/api/invitations/bulk", auditAction("insert", "bulk_invites"));
  routes.use("/api/invitations/bulk/:bulkInviteId/retry", auditAction("update", "bulk_invites"));

  // --- Handlers ---

  routes.openapi(createBulkInviteRoute, async (c) => {
    const auth = requireAuth(c);
    const log = c.get("log");
    const body = c.req.valid("json");

    const batch = await withTenantTx(database, tenantFrom(c), (tx) =>
      createBulkInvite(tx, auth.schoolId, auth.userId, {
        role: body.role,
        expiryDays: body.expiry_days,
        recipients: body.recipients,
      }),
    );

    // Dispatch async processing.
    if (notificationsQueue) {
      await notificationsQueue.add(
        "process-bulk-invite",
        { bulkInviteId: batch.id, schoolId: batch.school_id },
        {
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: { age: 7 * 24 * 60 * 60 },
          removeOnFail: { age: 30 * 24 * 60 * 60 },
        },
      );
    }

    log.info({ bulk_invite_id: batch.id, total: batch.total_count }, "bulk invite created");

    return c.json(toBulkInviteResponse(batch), 201);
  });

  routes.openapi(listBulkInvitesRoute, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, next_cursor } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listBulkInvites(tx, auth.schoolId, { limit: query.limit, cursor: query.cursor }),
    );

    return c.json({ bulk_invites: rows.map(toBulkInviteResponse), next_cursor }, 200);
  });

  routes.openapi(getBulkInviteRoute, async (c) => {
    const auth = requireAuth(c);
    const { bulkInviteId } = c.req.valid("param");

    const record = await withTenantTx(database, tenantFrom(c), (tx) =>
      getBulkInvite(tx, auth.schoolId, bulkInviteId),
    );

    return c.json(toBulkInviteResponse(record), 200);
  });

  routes.openapi(getBulkInviteRecipientsRoute, async (c) => {
    const auth = requireAuth(c);
    const { bulkInviteId } = c.req.valid("param");
    const query = c.req.valid("query");

    const { rows, next_cursor } = await withTenantTx(database, tenantFrom(c), (tx) =>
      getBulkInviteRecipients(tx, auth.schoolId, bulkInviteId, {
        limit: query.limit,
        cursor: query.cursor,
        status: query.status,
      }),
    );

    return c.json(
      {
        recipients: rows.map((r) => ({
          id: r.id,
          email: r.email,
          status: r.status,
          invitation_id: r.invitation_id,
          error_message: r.error_message,
          created_at: r.created_at.toISOString(),
          updated_at: r.updated_at.toISOString(),
        })),
        next_cursor,
      },
      200,
    );
  });

  routes.openapi(retryBulkInviteRoute, async (c) => {
    const auth = requireAuth(c);
    const log = c.get("log");
    const { bulkInviteId } = c.req.valid("param");

    const batch = await withTenantTx(database, tenantFrom(c), (tx) =>
      resetFailedRecipients(tx, auth.schoolId, bulkInviteId),
    );

    // Re-dispatch to queue.
    if (notificationsQueue) {
      await notificationsQueue.add(
        "process-bulk-invite",
        { bulkInviteId: batch.id, schoolId: batch.school_id },
        {
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: { age: 7 * 24 * 60 * 60 },
          removeOnFail: { age: 30 * 24 * 60 * 60 },
        },
      );
    }

    log.info({ bulk_invite_id: batch.id }, "bulk invite retry dispatched");

    return c.json(toBulkInviteResponse(batch), 200);
  });

  return routes;
}
