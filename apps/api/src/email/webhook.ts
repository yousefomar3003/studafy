import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { auditAction } from "../middleware/auditEmitter";
import { openApiValidationHook } from "../openapi/hook";
import { standardResponses } from "../openapi/responses";

import { ResendEventError, parseResendEvent, verifyResendSignature } from "./resend-events";

import type { Database } from "../db";
import type { Logger } from "../logger";
import type { ParsedEmailEvent } from "./email-events";
import type { AppEnv } from "../middleware/requestId";
import type { JSONValue, TransactionSql } from "postgres";

/**
 * Resend email-event webhook ingestion (deliverability R-08).
 *
 * Resend posts bounce, complaint, and delivery events here. This endpoint is the feedback half of
 * the email channel: it records each event once in `app.email_events`, feeds hard-bounce and
 * complaint addresses into the global `app.email_suppressions` list (which the workers' dispatcher
 * consults before every send), and advances the matching `app.email_deliveries` rows to their
 * terminal feedback state.
 *
 * It is public by design — there is no session — and authenticates by Resend's Svix signature over
 * the raw body before anything is parsed, so an unsigned or stale event never gets as far as
 * touching the database. At-least-once delivery is absorbed by the unique (message_id, event_type)
 * constraint on `app.email_events`: a redelivery inserts nothing, is answered 200, and changes no
 * state.
 */

const webhookAcceptedSchema = z.object({ ok: z.literal(true) }).openapi("EmailWebhookAccepted");

const resendEventSchema = z
  .object({
    type: z.string().openapi({
      description:
        "Resend event type; email.bounced, email.complained and email.delivered are acted on.",
    }),
    created_at: z.string().optional(),
    data: z
      .object({
        email_id: z.string().openapi({ description: "Resend's id for the sent email." }),
        to: z.array(z.string()).optional(),
      })
      .passthrough(),
  })
  .passthrough()
  .openapi("ResendEmailEvent");

const resendWebhookRoute = createRoute({
  method: "post",
  path: "/email/webhooks/resend",
  tags: ["Email"],
  operationId: "ingestResendEmailEvent",
  summary: "Ingest an email event from Resend",
  description:
    "Receives bounce, complaint and delivery events from Resend, the email provider the workers " +
    "send through. Authenticates by Resend's Svix " +
    "signature (svix-id, svix-timestamp, svix-signature headers) with RESEND_WEBHOOK_SECRET; " +
    "nothing else is trusted.\n\n" +
    "Each (message_id, event_type) is recorded once in " +
    "app.email_events, hard bounces and complaints added to the global suppression list, and the " +
    "matching deliveries advanced to bounced or complained. Other event types answer 200 and are " +
    "ignored.",
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
    // 400: malformed event. 401: signature missing, invalid or stale. 500: RESEND_WEBHOOK_SECRET
    // unconfigured, or ingestion failed.
    [400, 401, 500],
  ),
});

export function emailEventWebhookRoutes(db: Database, logger: Logger): OpenAPIHono<AppEnv> {
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
      throw new HTTPException(500, { message: "RESEND_WEBHOOK_SECRET is not configured" });
    }

    // Authenticate over the exact bytes Resend signed, before the validator parses them.
    const rawBody = await c.req.text();
    const verified = verifyResendSignature(
      rawBody,
      {
        id: c.req.header("svix-id"),
        timestamp: c.req.header("svix-timestamp"),
        signature: c.req.header("svix-signature"),
      },
      secret,
    );
    if (!verified) {
      logger.warn({ svix_id: c.req.header("svix-id") }, "Resend signature verification failed");
      throw new HTTPException(401, { message: "Invalid webhook signature" });
    }
    await next();
  });

  routes.openapi(resendWebhookRoute, async (c) => {
    const log = c.get("log");
    let event: ParsedEmailEvent | null;
    try {
      event = parseResendEvent(c.req.valid("json"));
    } catch (err) {
      if (err instanceof ResendEventError) {
        throw new HTTPException(400, { message: err.message });
      }
      throw err;
    }
    if (event === null) {
      log.info({ type: c.req.valid("json").type }, "Resend event type knowingly ignored");
    } else {
      await recordEmailEvent(db, event, log);
    }
    return c.json({ ok: true } as const, 200);
  });

  return routes;
}

/**
 * Record one provider email event and apply it: the ledger row, the suppression of
 * hard-bounced or complaining addresses, and the deliveries' terminal state, in one transaction.
 */
async function recordEmailEvent(
  db: Database,
  event: ParsedEmailEvent,
  logger: Logger,
): Promise<void> {
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
    // the line above, correlated by request_id.
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
