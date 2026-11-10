import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { auditAction } from "../middleware/auditEmitter";
import { openApiValidationHook } from "../openapi/hook";
import { standardResponses } from "../openapi/responses";

import { EmailEventError, parseResendEvent } from "./resend-events";
import { ResendSignatureError, verifyResendSignature } from "./resend-signature";

import type { Database } from "../db";
import type { Logger } from "../logger";
import type { ParsedEmailEvent } from "./resend-events";
import type { AppEnv } from "../middleware/requestId";
import type { JSONValue, TransactionSql } from "postgres";

/**
 * Resend email-event webhook ingestion (deliverability R-08).
 *
 * Resend posts delivered, bounced, and complained events here. This endpoint is the feedback half
 * of the email channel: it records each event once in `app.email_events`, feeds permanent-bounce
 * and complaint addresses into the global `app.email_suppressions` list (which the workers'
 * dispatcher consults before every send), and advances the matching `app.email_deliveries` rows to
 * their terminal feedback state.
 *
 * It is public by design — there is no session — and authenticates the way Resend signs: an
 * HMAC-SHA256 over the svix id, timestamp, and raw body, keyed by RESEND_WEBHOOK_SECRET, inside a
 * five-minute replay window. That check runs before the body is parsed, so an unsigned request
 * never gets as far as touching the database. At-least-once delivery is absorbed by the unique
 * (message_id, event_type) constraint on `app.email_events`: a redelivery inserts nothing, is
 * answered 200, and changes no state.
 */

const resendEventSchema = z
  .object({
    type: z.string().openapi({
      description: "Resend event type, e.g. email.delivered, email.bounced, email.complained.",
    }),
    created_at: z.string().optional(),
    data: z
      .object({
        // Optional here so contact.* / domain.* events (no email) are acknowledged and ignored,
        // not answered 400 and retried; parseResendEvent requires it for the types acted on.
        email_id: z
          .string()
          .optional()
          .openapi({ description: "The Resend id of the email the event is about." }),
        to: z.union([z.array(z.string()), z.string()]).optional(),
        bounce: z
          .object({
            type: z.string().optional().openapi({
              description: "Permanent, Transient, or Undetermined. Only Permanent suppresses.",
            }),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough()
  .openapi("ResendEmailEvent");

const webhookAcceptedSchema = z.object({ ok: z.literal(true) }).openapi("EmailWebhookAccepted");

const webhookRoute = createRoute({
  method: "post",
  path: "/email/webhooks/resend",
  tags: ["Email"],
  operationId: "ingestResendEmailEvent",
  summary: "Ingest an email event from Resend",
  description:
    "Receives delivered, bounced, and complained events from Resend. Authenticates by the Svix " +
    "signature headers (svix-id, svix-timestamp, svix-signature): an HMAC-SHA256 over the raw body " +
    "keyed by the endpoint's signing secret, within a five-minute window; nothing else is trusted.\n\n" +
    "Each (email_id, event_type) is recorded in app.email_events exactly once — at-least-once " +
    "delivery is absorbed by the unique constraint and a redelivery answers 200 without re-processing. " +
    "Permanent bounces and complaints suppress the affected addresses in the global suppression list, " +
    "so the email dispatcher never mails them again. Other event types are acknowledged and ignored.",
  security: [],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: resendEventSchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description: "Event accepted, deduplicated, or knowingly ignored.",
        schema: webhookAcceptedSchema,
      },
    },
    // 400: malformed event document. 401: signature missing, invalid, or outside the replay window.
    // 500: RESEND_WEBHOOK_SECRET unconfigured, or ingestion failed.
    [400, 401, 500],
  ),
});

export interface EmailEventWebhookOptions {
  /** Clock for the replay window, in Unix seconds. Injected by tests. */
  nowSeconds?: () => number;
}

export function emailEventWebhookRoutes(
  db: Database,
  logger: Logger,
  options: EmailEventWebhookOptions = {},
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Audit declaration for the CI coverage gate (tests/audit-coverage.test.ts). No app.audit_logs row
  // is written for this surface: it is global and pre-tenant (there is no school_id to record, and
  // app.audit_logs.school_id is NOT NULL), and the insert into app.email_events IS the audit record
  // for the feedback event — it is written in the same transaction that mutates suppressions and
  // deliveries, so a partial ingestion can never be mistaken for a complete one.
  routes.use("/email/webhooks/resend", auditAction("insert", "email_events"));

  routes.use("/email/webhooks/resend", async (c, next) => {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) {
      // The message reaches the log, never the client: errorHandlerMiddleware withholds detail on
      // every 5xx. An operator needs to know which variable is missing; a caller must not learn
      // that verification is off.
      throw new HTTPException(500, { message: "RESEND_WEBHOOK_SECRET is not configured" });
    }

    // Signature verification runs ahead of the request validator: authenticate, then parse.
    // c.req.text() caches, so the validator's later c.req.json() reads the same bytes.
    const rawBody = await c.req.text();
    const headers = {
      id: c.req.header("svix-id"),
      timestamp: c.req.header("svix-timestamp"),
      signature: c.req.header("svix-signature"),
    };

    try {
      verifyResendSignature(secret, headers, rawBody, options.nowSeconds?.());
    } catch (err) {
      if (!(err instanceof ResendSignatureError)) throw err;
      logger.warn({ err, svix_id: headers.id }, "Resend webhook signature verification failed");
      // Same message for every authentication failure, so a caller cannot probe the checks.
      throw new HTTPException(401, { message: "Invalid webhook signature" });
    }

    await next();
  });

  routes.openapi(webhookRoute, async (c) => {
    const document = c.req.valid("json");
    const log = c.get("log");

    let event: ParsedEmailEvent | null;
    try {
      event = parseResendEvent(document);
    } catch (err) {
      if (err instanceof EmailEventError) throw new HTTPException(400, { message: err.message });
      throw err;
    }

    if (event === null) {
      log.info({ type: document.type }, "Resend event type knowingly ignored");
    } else {
      await ingestEvent(db, event, log);
    }
    return c.json({ ok: true } as const, 200);
  });

  return routes;
}

async function ingestEvent(db: Database, event: ParsedEmailEvent, logger: Logger): Promise<void> {
  try {
    await db.begin(async (tx) => {
      // The unique (message_id, event_type) constraint is the dedup arbiter: a redelivered event
      // inserts nothing, and this transaction stops before it changes any state.
      const inserted = await tx`
        INSERT INTO app.email_events (message_id, event_type, payload)
        VALUES (${event.messageId}, ${event.eventType}, ${tx.json(event.payload as unknown as JSONValue)}::jsonb)
        ON CONFLICT (message_id, event_type) DO NOTHING
        RETURNING id
      `;
      if (inserted.length === 0) {
        logger.info(
          { message_id: event.messageId, event_type: event.eventType },
          "Email event already recorded; ignoring redelivery",
        );
        return;
      }

      if (event.suppress) {
        for (const address of event.recipients) {
          await tx`
            INSERT INTO app.email_suppressions (address, reason)
            VALUES (${address}, ${event.reason})
            ON CONFLICT (address) DO NOTHING
          `;
        }
      }

      if (event.eventType === "bounce" || event.eventType === "complaint") {
        await transitionDeliveries(tx, event);
      }
    });
  } catch (err) {
    logger.error({ err, message_id: event.messageId }, "Email event ingestion failed");
    // Detail is withheld from the client by the 5xx arm of errorHandlerMiddleware; the cause is in
    // the line above, correlated by request_id. A 5xx makes Resend retry.
    throw new HTTPException(500, { message: "Email event ingestion failed" });
  }
}

/**
 * Advance `app.email_deliveries` rows for a message to the terminal feedback state ('bounced' or
 * 'complained'). Only rows still 'sent' transition — a row the dispatcher has not yet recorded (still
 * 'claimed') is left for the send to complete; the ledger and the suppression list already carry the
 * feedback's ground truth, and no row is ever walked backwards.
 *
 * The message_id → school resolution is inherently cross-tenant, so this reads and writes a
 * tenant-isolated table without a tenant context. That relies on the application connection having
 * RLS bypass — the same assumption the ERPNext webhook makes when it inserts an outbox row for the
 * school named in an unauthenticated payload (see docs/runbooks/edge-security.md on the PgBouncer
 * user). The per-school set_config keeps each update tenant-shaped for any future connection that
 * does not bypass RLS.
 */
async function transitionDeliveries(tx: TransactionSql, event: ParsedEmailEvent): Promise<void> {
  const status = event.eventType === "bounce" ? "bounced" : "complained";

  const schools = await tx`
    SELECT DISTINCT school_id
    FROM app.email_deliveries
    WHERE message_id = ${event.messageId}
  `;

  for (const row of schools) {
    await tx`SELECT set_config('app.school_id', ${row.school_id}, true)`;
    await tx`
      UPDATE app.email_deliveries
      SET status = ${status}, updated_at = NOW()
      WHERE message_id = ${event.messageId} AND school_id = ${row.school_id} AND status = 'sent'
    `;
  }
}
