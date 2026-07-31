import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ERPNEXT_DOC_EVENT_MAP } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { withTenantTx } from "../db/tenant-tx";
import { auditAction, emitAuditLog } from "../middleware/auditEmitter";
import { projectFeeScheduleEntry } from "../modules/finance/fee-schedules/projection";
import { projectInvoiceEntry } from "../modules/finance/invoices/projection";
import { projectPaymentEntry } from "../modules/finance/payments/projection";
import { openApiValidationHook } from "../openapi/hook";
import { standardResponses } from "../openapi/responses";

import { verifyWebhookSignature } from "./signature";

import type { Database } from "../db";
import type { Logger } from "../logger";
import type { AppEnv } from "../middleware/requestId";
import type { ErpNextFeeSchedule } from "../modules/finance/fee-schedules/projection";
import type { ErpNextSalesInvoice } from "../modules/finance/invoices/projection";
import type { ErpNextPaymentEntry } from "../modules/finance/payments/projection";
import type { JSONValue } from "postgres";

const webhookBodySchema = z
  .object({
    event_id: z.string().min(1).openapi({
      description: "ERPNext's unique id for this delivery. Used to deduplicate redeliveries.",
    }),
    doctype: z.string().min(1).openapi({ description: "ERPNext DocType, e.g. 'Sales Invoice'." }),
    action: z
      .string()
      .min(1)
      .openapi({ description: "ERPNext document action, e.g. 'on_submit'." }),
    data: z.record(z.string(), z.unknown()).openapi({
      description:
        "The ERPNext document. Must carry school_id (or custom_school_id) — the payload is " +
        "otherwise untenanted and cannot be routed to a tenant.",
    }),
  })
  .openapi("ErpNextWebhook");

const webhookAcceptedSchema = z.object({ ok: z.literal(true) }).openapi("ErpNextWebhookAccepted");

function resolveEventName(doctype: string, action: string): string | undefined {
  const key = `${doctype}-${action}`;
  return ERPNEXT_DOC_EVENT_MAP[key];
}

/**
 * Project an ERPNext document into the appropriate finance cache table. Best-effort: if it fails,
 * the outbox event is still relayed and a downstream consumer can retry.
 *
 * Every arm delegates to a shared projection in modules/finance and runs inside a tenant
 * transaction rather than on a bare pool connection, so the write is covered by the same RLS context
 * and commit boundary as the outbox and audit rows recorded for this event.
 */
async function projectToCache(
  db: Database,
  schoolId: string,
  eventName: string,
  data: Record<string, unknown>,
  logger: Logger,
): Promise<void> {
  switch (eventName) {
    case "erpnext.invoiceSubmitted":
    case "erpnext.creditNoteIssued":
      // ST-121 follow-on: the invoice arm previously passed `String(data.student_id ?? data.customer
      // ?? "")` into a uuid column, an ISO currency *code* into the currency_id uuid foreign key,
      // and a raw decimal into total_amount_minor. All three are hard failures on any real payload
      // (see modules/finance/invoices/projection.ts).
      await withTenantTx(db, { schoolId }, (tx) =>
        projectInvoiceEntry(tx, schoolId, data as ErpNextSalesInvoice, logger),
      );
      break;
    case "erpnext.paymentReceived":
      // ST-121 replaced this arm's inline SQL with the shared projection in
      // modules/finance/payments/projection.ts. The previous version could not succeed: it passed
      // `String(data.student_id ?? data.party ?? "")` into a uuid column, an ISO currency *code* into
      // the currency_id uuid foreign key, and a raw decimal paid_amount into the integer
      // amount_minor. The shared function resolves the student, looks the currency up in
      // app.currencies, and converts through the currency's own exponent (3 for JOD, not 2).
      await withTenantTx(db, { schoolId }, (tx) =>
        projectPaymentEntry(tx, schoolId, data as ErpNextPaymentEntry, logger),
      );
      break;
    case "erpnext.feeDue":
      // Same bug class as the invoice arm: an ISO currency code into the currency_id uuid foreign
      // key, a raw decimal into total_amount_minor, and names into the academic_year_id/term_id
      // uuids (see modules/finance/fee-schedules/projection.ts).
      await withTenantTx(db, { schoolId }, (tx) =>
        projectFeeScheduleEntry(tx, schoolId, data as ErpNextFeeSchedule, logger),
      );
      break;
  }
}

const webhookRoute = createRoute({
  method: "post",
  path: "/erpnext/webhooks",
  tags: ["ERPNext"],
  operationId: "ingestErpNextWebhook",
  summary: "Ingest an ERPNext document event",
  description:
    "Accepts a signed document event from ERPNext, records it for deduplication, enqueues an " +
    "outbox event, and projects the document into the finance cache.\n\n" +
    "Deduplicated on (school_id, event_id): redelivering an event already seen answers 200 " +
    "without re-processing it, so ERPNext's at-least-once delivery is safe to retry.\n\n" +
    "An event whose doctype/action pair maps to no known event also answers 200 — it is delivered, " +
    "understood, and deliberately ignored. Answering an error would make ERPNext retry forever.",
  // Authenticated by HMAC over the raw body, not a bearer token, so the bearerAuth scheme does not
  // apply. Empty rather than omitted: this route *is* authenticated, just not by the app's scheme.
  security: [],
  request: {
    headers: z.object({
      "x-erpnext-signature": z.string().openapi({
        description:
          "Hex-encoded HMAC-SHA256 of the raw request body, keyed with the shared webhook secret. " +
          "Verified before the body is parsed; compared with a timing-safe equality.",
      }),
    }),
    body: {
      required: true,
      content: { "application/json": { schema: webhookBodySchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "Event accepted, deduplicated, or knowingly ignored.",
        schema: webhookAcceptedSchema,
      },
    },
    // 400: malformed JSON or a body that fails webhookBodySchema, both raised by the request
    // validator. 401: signature missing or wrong. 500: the secret is unconfigured, or ingestion
    // failed.
    [400, 401, 500],
  ),
});

/**
 * Build the route group for ERPNext webhook ingestion.
 *
 * Returns an OpenAPIHono, not a Hono: OpenAPIHono.route() silently drops a plain Hono sub-app's
 * OpenAPI definitions while still serving its traffic, so a plain Hono here would erase this
 * endpoint from the document with no error.
 */
export function erpNextWebhookRoutes(db: Database, logger: Logger): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  /**
   * ST-065's audit declaration, and ST-060's signature check, in one middleware chain.
   *
   * They are registered with `use` rather than as `routes.post(path, ...middleware, handler)`
   * arguments because `routes.openapi(route, handler)` takes no middleware list — the path and verb
   * now live in webhookRoute's createRoute config. The behaviour is identical: Hono composes
   * path-matched `use` middleware ahead of the route handler either way.
   *
   * auditAction only records intent (it sets auditMeta on the context); the row is written by
   * emitAuditLog inside the mutation's own transaction below. It runs first so the declaration
   * holds for the whole request regardless of how the request ends.
   */
  routes.use("/erpnext/webhooks", auditAction("insert", "erpnext_webhook_dedup"));

  /**
   * Signature verification runs ahead of the request validator, to keep the order this endpoint has
   * always had: authenticate, then parse. The validator would otherwise parse an unsigned caller's
   * JSON and hand it schema feedback before we ever check who it is.
   *
   * Reading the body here is what makes that possible and is safe: c.req.text() caches, and the
   * validator's later c.req.json() reads the same bytes. The signature covers the exact bytes
   * ERPNext sent, so this must be the raw text and never a re-serialization of a parsed object.
   */
  routes.use("/erpnext/webhooks", async (c, next) => {
    const webhookSecret = process.env.ERPNEXT_WEBHOOK_SECRET;

    if (!webhookSecret) {
      // The message reaches the log, never the client: errorHandlerMiddleware withholds detail on
      // every 5xx. An operator needs to know which variable is missing; a caller must not learn
      // that our secret is unset.
      throw new HTTPException(500, { message: "ERPNEXT_WEBHOOK_SECRET is not configured" });
    }

    const rawBody = await c.req.text();
    const signature = c.req.header("x-erpnext-signature") ?? null;

    if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
      logger.warn({ signature }, "webhook signature verification failed");
      throw new HTTPException(401, { message: "Invalid webhook signature" });
    }

    await next();
  });

  routes.openapi(webhookRoute, async (c) => {
    // Already validated by webhookBodySchema. Malformed JSON became an HTTPException(400) and a
    // schema violation a ZodError, and errorHandlerMiddleware turned both into 400 problem+json —
    // which is why there is no hand-rolled try/catch around parsing here.
    const body = c.req.valid("json");

    const eventName = resolveEventName(body.doctype, body.action);
    if (!eventName) {
      return c.json({ ok: true } as const, 200);
    }

    const schoolId = String(body.data.school_id ?? body.data.custom_school_id ?? "");
    if (!schoolId) {
      logger.warn({ event_id: body.event_id }, "webhook missing school_id");
      throw new HTTPException(400, { message: "Webhook payload is missing school_id" });
    }

    try {
      await db.begin(async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

        const dedupResult = await tx`
          INSERT INTO app.erpnext_webhook_dedup (school_id, event_id, doc_type, action)
          VALUES (${schoolId}, ${body.event_id}, ${body.doctype}, ${body.action})
          ON CONFLICT (school_id, event_id) DO NOTHING
          RETURNING id
        `;

        if (dedupResult.length === 0) {
          return;
        }

        await emitAuditLog(tx, {
          action: "insert",
          targetTable: "erpnext_webhook_dedup",
          targetId: String(dedupResult[0].id),
          newValues: { event_id: body.event_id, doc_type: body.doctype, action: body.action },
          userAgent: c.req.header("user-agent"),
        });

        // tx.json(), not JSON.stringify() + ::jsonb. With an explicit ::jsonb cast postgres.js infers
        // the parameter type as jsonb and JSON-encodes the string it was given, producing a jsonb
        // *string* rather than an object. app.outbox_events.payload has no jsonb_typeof CHECK, so the
        // mistake would store silently and corrupt every consumer downstream (see the same note in
        // apps/workers/src/queues/notifications/attendance-alert.worker.ts).
        await tx`
          INSERT INTO app.outbox_events (school_id, event_name, payload)
          VALUES (${schoolId}, ${eventName}, ${tx.json(body.data as unknown as JSONValue)})
        `;
      });

      await projectToCache(db, schoolId, eventName, body.data as Record<string, unknown>, logger);
    } catch (err) {
      logger.error({ err, event_id: body.event_id }, "webhook ingestion failed");
      // Detail is withheld from the client by the 5xx arm of errorHandlerMiddleware; the cause is
      // in the line above, correlated by request_id.
      throw new HTTPException(500, { message: "Webhook ingestion failed" });
    }

    return c.json({ ok: true } as const, 200);
  });

  return routes;
}
