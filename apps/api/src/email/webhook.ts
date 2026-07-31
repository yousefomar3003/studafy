import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { auditAction } from "../middleware/auditEmitter";
import { openApiValidationHook } from "../openapi/hook";
import { standardResponses } from "../openapi/responses";

import { SesEventError, parseSesEvent } from "./ses-events";
import { SnsSignatureError, verifySnsSignature } from "./sns-signature";

import type { Database } from "../db";
import type { Logger } from "../logger";
import type { SnsEnvelope } from "./sns-signature";
import type { AppEnv, AppVariables } from "../middleware/requestId";
import type { Context } from "hono";
import type { JSONValue, TransactionSql } from "postgres";

/**
 * SES → SNS email-event webhook ingestion (deliverability R-08).
 *
 * The configuration set publishes Bounce, Complaint, and Delivery notifications to an SNS topic;
 * the topic delivers them here. This endpoint is the feedback half of the email channel: it records
 * each event once in `app.email_events`, feeds permanent-bounce and complaint addresses into the
 * global `app.email_suppressions` list (which the workers' dispatcher consults before every send),
 * and advances the matching `app.email_deliveries` rows to their terminal feedback state.
 *
 * It is public by design — there is no session — and authenticates the way SNS itself does: by
 * verifying the RSA signature over the envelope's canonical message against SNS's own regional
 * signing certificate, then asserting the topic ARN is the one we configured. Both checks happen
 * before anything is parsed for handling, so an unsigned or wrong-topic notification never gets as
 * far as touching the database. At-least-once SNS delivery is absorbed by the unique
 * (message_id, event_type) constraint on `app.email_events`: a redelivery inserts nothing, is
 * answered 200, and changes no state.
 */

const snsEnvelopeSchema = z
  .object({
    Type: z.string().openapi({
      description:
        "SNS message type: Notification, SubscriptionConfirmation, UnsubscribeConfirmation.",
    }),
    MessageId: z
      .string()
      .optional()
      .openapi({ description: "SNS delivery id, unique per published message." }),
    TopicArn: z.string().openapi({
      description:
        "The topic this message was published to; must equal the configured EMAIL_EVENTS_SNS_TOPIC_ARN.",
    }),
    Subject: z.string().optional(),
    Message: z
      .string()
      .openapi({ description: "For Notification, a JSON string carrying the SES event document." }),
    Timestamp: z.string().optional(),
    SignatureVersion: z.string().optional(),
    Signature: z
      .string()
      .optional()
      .openapi({ description: "Base64 RSA-SHA1 signature over the canonical message." }),
    SigningCertURL: z.string().optional().openapi({
      description:
        "HTTPS URL of the SNS signing certificate; host is pinned to sns.<region>.amazonaws.com.",
    }),
    SubscribeURL: z.string().optional().openapi({
      description: "Present on SubscriptionConfirmation; fetching it activates the subscription.",
    }),
    UnsubscribeURL: z.string().optional(),
  })
  .openapi("SnsEnvelope");

const webhookAcceptedSchema = z.object({ ok: z.literal(true) }).openapi("EmailWebhookAccepted");

const webhookRoute = createRoute({
  method: "post",
  path: "/email/webhooks/sns",
  tags: ["Email"],
  operationId: "ingestSesSnsEvent",
  summary: "Ingest a SES event notification from SNS",
  description:
    "Receives Bounce, Complaint, and Delivery notifications from an SNS topic subscribed to the SES " +
    "configuration set. Authenticates by SNS's RSA signature (verified against SNS's regional " +
    "signing certificate) and a configured topic ARN allowlist; nothing else is trusted.\n\n" +
    "Each (message_id, event_type) is recorded in app.email_events exactly once — SNS at-least-once " +
    "delivery is absorbed by the unique constraint and a redelivery answers 200 without re-processing. " +
    "Permanent bounces and complaints suppress the affected addresses in the global suppression list, " +
    "so the email dispatcher never mails them again. SubscriptionConfirmation is auto-confirmed by " +
    "fetching the signed SubscribeURL.",
  security: [],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: snsEnvelopeSchema } },
    },
  },
  responses: standardResponses(
    {
      200: {
        description:
          "Notification accepted, deduplicated, or knowingly ignored; subscription confirmed.",
        schema: webhookAcceptedSchema,
      },
    },
    // 400: malformed JSON envelope or SES event document. 401: signature missing/invalid, or the
    // topic is not the configured one. 500: EMAIL_EVENTS_SNS_TOPIC_ARN unconfigured, the
    // subscription confirmation fetch failed, or ingestion failed.
    [400, 401, 500],
  ),
});

/**
 * The signature middleware stamps the verified envelope on the request context. AppVariables does
 * not carry it — the key is private to this module — so access goes through this typed wrapper and
 * a local WebhookEnv rather than widening the shared AppEnv for one route's bookkeeping.
 */
const ENVELOPE_KEY = "snsEnvelope";

type WebhookEnv = AppEnv & { Variables: AppVariables & { snsEnvelope: SnsEnvelope } };

function envelopeFrom(c: Context<AppEnv>): SnsEnvelope {
  return (c as unknown as Context<WebhookEnv>).get(ENVELOPE_KEY);
}

function stampEnvelope(c: Context<AppEnv>, envelope: SnsEnvelope): void {
  (c as unknown as Context<WebhookEnv>).set(ENVELOPE_KEY, envelope);
}

export interface EmailEventWebhookOptions {
  /**
   * Certificate fetcher for signature verification. Injected so tests can stub the network; app.ts
   * omits it and verification uses the default cached fetch.
   */
  fetchCert?: (url: string) => Promise<string>;
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
  routes.use("/email/webhooks/sns", auditAction("insert", "email_events"));

  routes.use("/email/webhooks/sns", async (c, next) => {
    const topicArn = process.env.EMAIL_EVENTS_SNS_TOPIC_ARN;

    if (!topicArn) {
      // The message reaches the log, never the client: errorHandlerMiddleware withholds detail on
      // every 5xx. An operator needs to know which variable is missing; a caller must not learn
      // that our topic allowlist is unset.
      throw new HTTPException(500, { message: "EMAIL_EVENTS_SNS_TOPIC_ARN is not configured" });
    }

    // Signature verification runs ahead of the request validator, mirroring the ERPNext webhook:
    // authenticate, then parse. Reading the body here is safe — c.req.text() caches, and the
    // validator's later c.req.json() reads the same bytes.
    const rawBody = await c.req.text();

    let envelope: SnsEnvelope;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("envelope is not a JSON object");
      }
      envelope = parsed as SnsEnvelope;
    } catch {
      throw new HTTPException(400, { message: "SNS notification is not a valid JSON object" });
    }

    try {
      const verified = await verifySnsSignature(envelope, options);
      if (!verified) throw new SnsSignatureError("signature did not verify");
    } catch (err) {
      logger.warn(
        { err, message_id: envelope.MessageId, topic_arn: envelope.TopicArn },
        "SNS signature verification failed",
      );
      // Same message for every authentication failure, so a caller cannot distinguish (and probe
      // for) the individual checks.
      throw new HTTPException(401, { message: "Invalid webhook signature" });
    }

    if (envelope.TopicArn !== topicArn) {
      logger.warn(
        { topic_arn: envelope.TopicArn, expected_topic_arn: topicArn },
        "SNS notification from an unexpected topic",
      );
      throw new HTTPException(401, { message: "Invalid webhook signature" });
    }

    stampEnvelope(c, envelope);
    await next();
  });

  routes.openapi(webhookRoute, async (c) => {
    const envelope = envelopeFrom(c);
    const log = c.get("log");

    switch (envelope.Type) {
      case "SubscriptionConfirmation":
        await confirmSubscription(c, envelope, log);
        break;
      case "UnsubscribeConfirmation":
        log.info({ message_id: envelope.MessageId }, "SNS subscription unsubscribed");
        break;
      case "Notification":
        await ingestNotification(db, envelope, log);
        break;
      default:
        // SNS only ever sends the three types above; a fourth means a third-party published to our
        // topic. It signed it, so it is not an attacker, but we do not act on it.
        log.info({ type: envelope.Type }, "SNS notification type ignored");
        break;
    }

    return c.json({ ok: true } as const, 200);
  });

  return routes;
}

async function confirmSubscription(
  c: Context<AppEnv>,
  envelope: SnsEnvelope,
  logger: Logger,
): Promise<void> {
  const subscribeUrl = envelope.SubscribeURL;
  if (!subscribeUrl) {
    throw new HTTPException(400, { message: "SubscriptionConfirmation is missing SubscribeURL" });
  }
  try {
    // The URL is signed envelope data verified above and points at SNS's own confirmation
    // endpoint, so following it is safe. Confirming keeps the subscription active without a manual
    // console step; failure surfaces as a 500 so SNS redelivers the confirmation.
    const response = await fetch(subscribeUrl, { method: "GET" });
    if (!response.ok) {
      throw new Error(`SNS confirmation answered HTTP ${response.status}`);
    }
  } catch (err) {
    logger.error({ err }, "SNS subscription confirmation failed");
    throw new HTTPException(500, { message: "SNS subscription confirmation failed" });
  }
}

async function ingestNotification(
  db: Database,
  envelope: SnsEnvelope,
  logger: Logger,
): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(envelope.Message);
  } catch {
    throw new HTTPException(400, { message: "SNS notification Message is not valid JSON" });
  }

  let event: ReturnType<typeof parseSesEvent>;
  try {
    event = parseSesEvent(message);
  } catch (err) {
    if (err instanceof SesEventError) {
      throw new HTTPException(400, { message: err.message });
    }
    throw err;
  }
  if (event === null) {
    logger.info({ message_id: envelope.MessageId }, "SES event type knowingly ignored");
    return;
  }

  try {
    await db.begin(async (tx) => {
      // The unique (message_id, event_type) constraint is the dedup arbiter: a redelivered SNS
      // notification inserts nothing, and this transaction stops before it changes any state.
      const inserted = await tx`
        INSERT INTO app.email_events (message_id, event_type, payload)
        VALUES (${event.messageId}, ${event.eventType}, ${tx.json(event.payload as unknown as JSONValue)}::jsonb)
        ON CONFLICT (message_id, event_type) DO NOTHING
        RETURNING id
      `;
      if (inserted.length === 0) {
        logger.info(
          { message_id: event.messageId, event_type: event.eventType },
          "SES event already recorded; ignoring redelivery",
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
    logger.error({ err, message_id: event.messageId }, "SES event ingestion failed");
    // Detail is withheld from the client by the 5xx arm of errorHandlerMiddleware; the cause is in
    // the line above, correlated by request_id.
    throw new HTTPException(500, { message: "SES event ingestion failed" });
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
async function transitionDeliveries(
  tx: TransactionSql,
  event: NonNullable<ReturnType<typeof parseSesEvent>>,
): Promise<void> {
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
