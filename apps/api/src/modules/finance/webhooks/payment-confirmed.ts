/**
 * The ERPNext payment confirmation receiver (ST-121).
 *
 * A payment forwarded by `POST /api/finance/payments` is recorded locally as `pending`. This endpoint
 * is what makes it `confirmed`: ERPNext calls it when a `Payment Entry` is submitted, and the handler
 * flips the cache row, stores the receipt link, and writes the audit trail.
 *
 * ## Why this exists next to `erpnext/webhook.ts`
 *
 * The generic receiver at `POST /erpnext/webhooks` already ingests every document event, including
 * `Payment Entry-submitted`, and both endpoints now share one projection (`payments/projection.ts`)
 * and one dedup table. This endpoint adds a dedicated URL a school's ERPNext instance can be pointed
 * at for payments alone, which matters operationally: payment confirmation carries an SLA the generic
 * ingest path does not, and a single-purpose URL can be monitored, alerted, and rate-limited on its
 * own without touching the rest of the ingest.
 *
 * ## Ordering
 *
 * Authenticate, then parse. Signature verification runs in middleware *ahead of* the request
 * validator, so an unsigned caller never receives schema feedback about a payload it was not entitled
 * to submit. This mirrors `erpnext/webhook.ts` deliberately — the ordering there was a considered
 * decision and diverging from it here would be a quiet regression.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../../../db/tenant-tx";
import { verifyWebhookSignature } from "../../../erpnext/signature";
import { auditAction, emitAuditLog } from "../../../middleware/auditEmitter";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { projectPaymentEntry } from "../payments/projection";
import { paymentConfirmedWebhookSchema, webhookAcceptedSchema } from "../payments/schemas";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { ErpNextPaymentEntry } from "../payments/projection";

const WEBHOOK_PATH = "/api/finance/webhooks/erpnext/payment-confirmed";

const paymentConfirmedRoute = createRoute({
  method: "post",
  path: WEBHOOK_PATH,
  tags: ["Finance"],
  operationId: "ingestPaymentConfirmedWebhook",
  summary: "Ingest an ERPNext Payment Entry confirmation",
  description:
    "Accepts a signed Payment Entry event from ERPNext, deduplicates it, and confirms the local " +
    "payment: status becomes `confirmed`, `confirmed_at` is stamped, and the ERPNext receipt link is " +
    "stored. An audit entry records the payment entry id and the amount in minor units.\n\n" +
    "Deduplicated on (school_id, event_id), so ERPNext's at-least-once delivery is safe to retry — " +
    "a redelivery answers 200 without reprocessing.\n\n" +
    "A payload for another doctype, or one that cannot be placed against a local student, also " +
    "answers 200. It was delivered and understood; answering an error would make ERPNext retry it " +
    "forever.",
  // Authenticated by HMAC over the raw body, not a bearer token. Declared empty rather than omitted:
  // this route *is* authenticated, just not by the app's scheme.
  security: [],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: paymentConfirmedWebhookSchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "Event confirmed, deduplicated, or knowingly ignored.",
        schema: webhookAcceptedSchema,
      },
    },
    // 400: malformed JSON, a schema violation, or a payload with no resolvable school.
    // 401: signature missing or wrong. 500: the secret is unconfigured, or ingestion failed.
    [400, 401, 500],
  ),
});

/**
 * Build the payment-confirmation route group.
 *
 * Returns an `OpenAPIHono`, not a `Hono`: `OpenAPIHono.route()` silently drops a plain Hono sub-app's
 * OpenAPI definitions while still serving its traffic, which would erase this endpoint from the
 * published document with no error anywhere.
 */
export function paymentWebhookRoutes(database: Database, logger: Logger): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use(WEBHOOK_PATH, auditAction("update", "payment_cache"));

  routes.use(WEBHOOK_PATH, async (c, next) => {
    // Per-tenant webhook secrets are what ST-121 asks for; the deployed plane has one shared secret,
    // for the same reason there is no per-tenant API key — see client/credential-resolver.ts and the
    // "Secrets" section of docs/modules/finance-payments-guide.md. When per-tenant secrets arrive,
    // only this lookup changes.
    const webhookSecret = process.env.ERPNEXT_WEBHOOK_SECRET;

    if (!webhookSecret) {
      // The message reaches the log, never the client: errorHandlerMiddleware withholds detail on
      // every 5xx. An operator needs to know which variable is missing; a caller must not learn that
      // our secret is unset.
      throw new HTTPException(500, { message: "ERPNEXT_WEBHOOK_SECRET is not configured" });
    }

    // c.req.text() caches, so the validator's later c.req.json() reads the same bytes. The signature
    // covers the exact bytes ERPNext sent, which is why this must be the raw text and never a
    // re-serialization of a parsed object.
    const rawBody = await c.req.text();
    const signature = c.req.header("x-erpnext-signature") ?? null;

    if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
      logger.warn({ path: WEBHOOK_PATH }, "payment webhook signature verification failed");
      throw new HTTPException(401, { message: "Invalid webhook signature" });
    }

    await next();
  });

  routes.openapi(paymentConfirmedRoute, async (c) => {
    const body = c.req.valid("json");

    // Anything but a Payment Entry belongs to the generic receiver. 200, not 400: it is a
    // misconfiguration to fix in ERPNext, not a delivery to retry until someone does.
    if (body.doctype !== "Payment Entry") {
      logger.warn(
        { event_id: body.event_id, doctype: body.doctype },
        "payment webhook received a non-payment doctype; ignoring",
      );
      return c.json({ ok: true } as const, 200);
    }

    const doc = body.data as ErpNextPaymentEntry & Record<string, unknown>;
    const schoolId = String(doc.school_id ?? doc.custom_school_id ?? "").trim();
    if (!schoolId) {
      // Without a tenant there is no RLS context to open and no row this could belong to. This one is
      // a 400: it is genuinely malformed rather than merely uninteresting.
      logger.warn({ event_id: body.event_id }, "payment webhook missing school_id");
      throw new HTTPException(400, { message: "Webhook payload is missing school_id" });
    }

    try {
      await withTenantTx(database, { schoolId, requestId: c.get("requestId") }, async (tx) => {
        const dedup = await tx<{ id: string }[]>`
          INSERT INTO app.erpnext_webhook_dedup (school_id, event_id, doc_type, action)
          VALUES (${schoolId}::uuid, ${body.event_id}, ${body.doctype}, ${body.action})
          ON CONFLICT (school_id, event_id) DO NOTHING
          RETURNING id
        `;

        // Already processed. Returning here leaves the earlier confirmation untouched, which is the
        // point of the dedup: a redelivery must not re-stamp confirmed_at or re-emit the audit row.
        if (dedup.length === 0) return;

        const projected = await projectPaymentEntry(tx, schoolId, doc, logger);
        if (!projected) return;

        await emitAuditLog(tx, {
          action: "update",
          targetTable: "payment_cache",
          targetId: projected.id,
          newValues: {
            erpnext_doctype: "Payment Entry",
            erpnext_payment_entry_id: projected.erpnext_docname,
            status: projected.status,
            // Minor units, matching how the amount is stored. For JOD that is fils: 12.345 JOD is
            // 12345, and recording the decimal here would make the audit trail disagree with the row.
            amount_minor: projected.amount_minor,
            currency: projected.currency,
            confirmed_at: projected.confirmed_at?.toISOString() ?? null,
          },
          userAgent: c.req.header("user-agent"),
        });
      });
    } catch (err) {
      logger.error({ err, event_id: body.event_id }, "payment webhook ingestion failed");
      // Detail is withheld from the client by the 5xx arm of errorHandlerMiddleware; the cause is in
      // the line above, correlated by request_id. A 500 is correct here: ERPNext *should* retry a
      // failure that was ours.
      throw new HTTPException(500, { message: "Payment webhook ingestion failed" });
    }

    return c.json({ ok: true } as const, 200);
  });

  return routes;
}
