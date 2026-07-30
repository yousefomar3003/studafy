import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { verifyWebhookSignature } from "../../../erpnext/signature";
import { auditAction, emitAuditLog } from "../../../middleware/auditEmitter";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { refundProcessedWebhookSchema, webhookAcceptedSchema } from "../refunds/schemas";
import { applyRefundCompleted } from "../refunds/service";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";

const WEBHOOK_PATH = "/api/finance/webhooks/erpnext/refund-processed";

const refundProcessedRoute = createRoute({
  method: "post",
  path: WEBHOOK_PATH,
  tags: ["Finance"],
  operationId: "ingestRefundProcessedWebhook",
  summary: "Ingest an ERPNext Credit Note / Return confirmation",
  description:
    "Accepts a signed Sales Invoice return event from ERPNext, deduplicates it, and marks the " +
    "local refund request as completed. Updates payment_cache and fee_schedule_cache to reflect " +
    "the reduced paid balances. Writes an immutable audit log entry.\n\n" +
    "Deduplicated on (school_id, event_id), so ERPNext's at-least-once delivery is safe to retry — " +
    "a redelivery answers 200 without reprocessing.\n\n" +
    "A payload for another doctype, or one that cannot be matched to a local refund request, " +
    "also answers 200.",
  security: [],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: refundProcessedWebhookSchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "Event confirmed, deduplicated, or knowingly ignored.",
        schema: webhookAcceptedSchema,
      },
    },
    [400, 401, 500],
  ),
});

export function refundWebhookRoutes(database: Database, logger: Logger): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use(WEBHOOK_PATH, auditAction("update", "refund_requests"));

  routes.use(WEBHOOK_PATH, async (c, next) => {
    const webhookSecret = process.env.ERPNEXT_WEBHOOK_SECRET;

    if (!webhookSecret) {
      throw new HTTPException(500, { message: "ERPNEXT_WEBHOOK_SECRET is not configured" });
    }

    const rawBody = await c.req.text();
    const signature = c.req.header("x-erpnext-signature") ?? null;

    if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
      logger.warn({ path: WEBHOOK_PATH }, "refund webhook signature verification failed");
      throw new HTTPException(401, { message: "Invalid webhook signature" });
    }

    await next();
  });

  routes.openapi(refundProcessedRoute, async (c) => {
    const body = c.req.valid("json");

    if (body.doctype !== "Sales Invoice") {
      logger.warn(
        { event_id: body.event_id, doctype: body.doctype },
        "refund webhook received a non-Sales Invoice doctype; ignoring",
      );
      return c.json({ ok: true } as const, 200);
    }

    const doc = body.data as Record<string, unknown>;
    const isReturn = Number(doc.is_return ?? 0);
    if (isReturn !== 1) {
      logger.warn(
        { event_id: body.event_id, erpnext_docname: doc.name },
        "refund webhook received a non-return Sales Invoice; ignoring",
      );
      return c.json({ ok: true } as const, 200);
    }

    const schoolId = String(doc.custom_school_id ?? doc.school_id ?? "").trim();
    if (!schoolId) {
      logger.warn({ event_id: body.event_id }, "refund webhook missing school_id");
      throw new HTTPException(400, { message: "Webhook payload is missing school_id" });
    }

    const creditNoteId = String(doc.name ?? "").trim();
    if (!creditNoteId) {
      logger.warn({ event_id: body.event_id }, "refund webhook missing document name");
      throw new HTTPException(400, { message: "Webhook payload is missing document name" });
    }

    try {
      await withTenantTx(database, { schoolId, requestId: c.get("requestId") }, async (tx) => {
        const dedup = await tx<{ id: string }[]>`
          INSERT INTO app.erpnext_webhook_dedup (school_id, event_id, doc_type, action)
          VALUES (${schoolId}::uuid, ${body.event_id}, ${body.doctype}, ${body.action})
          ON CONFLICT (school_id, event_id) DO NOTHING
          RETURNING id
        `;

        if (dedup.length === 0) return;

        await applyRefundCompleted(tx, schoolId, creditNoteId, doc);

        await emitAuditLog(tx, {
          action: "update",
          targetTable: "refund_requests",
          targetId: creditNoteId,
          newValues: {
            status: "completed",
            erpnext_credit_note_id: creditNoteId,
            school_id: schoolId,
          },
          userAgent: c.req.header("user-agent"),
        });
      });
    } catch (err) {
      logger.error({ err, event_id: body.event_id }, "refund webhook ingestion failed");
      throw new HTTPException(500, { message: "Refund webhook ingestion failed" });
    }

    return c.json({ ok: true } as const, 200);
  });

  return routes;
}
