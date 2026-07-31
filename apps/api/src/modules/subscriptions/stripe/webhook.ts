import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { transitionSubscriptionStatus } from "../services/subscription-service";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { PaymentProviderPort } from "../ports/payment-provider";

type TransactionSql = import("postgres").TransactionSql;

interface WebhookHandlerDeps {
  database: Database;
  provider: PaymentProviderPort;
  logger: Logger;
}

type EventHandler = (
  tx: TransactionSql,
  data: Record<string, unknown>,
  eventId: string,
) => Promise<void>;

const EVENT_HANDLERS: Record<string, EventHandler> = {};

export function registerWebhookHandler(eventType: string, handler: EventHandler): void {
  EVENT_HANDLERS[eventType] = handler;
}

registerWebhookHandler("checkout.session.completed", async (tx, data, _eventId) => {
  const session = data as {
    id: string;
    customer?: string;
    subscription?: string;
    metadata?: Record<string, string>;
    mode?: string;
  };

  if (session.mode !== "subscription") return;
  if (!session.customer || !session.subscription) return;

  const schoolId = session.metadata?.school_id;
  const studentId = session.metadata?.student_id;

  if (!schoolId) return;

  if (studentId) {
    await tx`
      INSERT INTO app.ai_subscriptions (school_id, student_id, status, current_period_start, current_period_end)
      VALUES (
        ${schoolId}::uuid,
        ${studentId}::uuid,
        'trialing'::app.subscription_status,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + INTERVAL '30 days'
      )
      ON CONFLICT (school_id, student_id) DO UPDATE SET
        status = 'trialing'::app.subscription_status,
        current_period_start = CURRENT_TIMESTAMP,
        current_period_end = CURRENT_TIMESTAMP + INTERVAL '30 days',
        updated_at = CURRENT_TIMESTAMP
    `;
    return;
  }

  await tx`
    UPDATE app.subscriptions
    SET
      status = 'active'::app.subscription_status,
      stripe_subscription_id = ${session.subscription},
      updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId}::uuid
  `;
});

registerWebhookHandler("invoice.paid", async (tx, data, _eventId) => {
  const invoice = data as {
    subscription?: string;
    period_start?: number;
    period_end?: number;
    customer?: string;
  };

  if (!invoice.subscription) return;

  const periodStart = invoice.period_start
    ? new Date(invoice.period_start * 1000).toISOString()
    : undefined;
  const periodEnd = invoice.period_end
    ? new Date(invoice.period_end * 1000).toISOString()
    : undefined;

  await tx`
    UPDATE app.subscriptions
    SET
      status = 'active'::app.subscription_status,
      current_period_start = COALESCE(
        ${periodStart ?? null}::timestamptz,
        current_period_start
      ),
      current_period_end = COALESCE(
        ${periodEnd ?? null}::timestamptz,
        current_period_end
      ),
      updated_at = CURRENT_TIMESTAMP
    WHERE stripe_subscription_id = ${invoice.subscription}
  `;
});

registerWebhookHandler("invoice.payment_failed", async (tx, data, _eventId) => {
  const invoice = data as {
    subscription?: string;
    attempt_count?: number;
  };

  if (!invoice.subscription) return;

  const subscription = await tx<{ status: string }[]>`
    SELECT status::text AS status
    FROM app.subscriptions
    WHERE stripe_subscription_id = ${invoice.subscription}
    LIMIT 1
  `;
  if (subscription.length === 0) return;

  const newStatus =
    invoice.attempt_count && invoice.attempt_count >= 3 ? "grace_period" : "past_due";
  await transitionSubscriptionStatus(tx, subscription[0].status, newStatus, invoice.subscription);
});

registerWebhookHandler("customer.subscription.updated", async (tx, data, _eventId) => {
  const sub = data as {
    id: string;
    status?: string;
    current_period_start?: number;
    current_period_end?: number;
    items?: { data?: { id: string; price?: { id: string } }[] };
  };

  await tx`
    UPDATE app.subscriptions
    SET
      status = ${mapStripeStatus(sub.status) ?? "active"}::app.subscription_status,
      current_period_start = COALESCE(
        ${sub.current_period_start ? new Date(sub.current_period_start * 1000).toISOString() : null}::timestamptz,
        current_period_start
      ),
      current_period_end = COALESCE(
        ${sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null}::timestamptz,
        current_period_end
      ),
      stripe_subscription_item_id = ${sub.items?.data?.[0]?.id ?? null},
      updated_at = CURRENT_TIMESTAMP
    WHERE stripe_subscription_id = ${sub.id}
  `;
});

registerWebhookHandler("customer.subscription.deleted", async (tx, data, _eventId) => {
  const sub = data as { id: string };

  const status = await tx<{ status: string }[]>`
    SELECT status::text AS status
    FROM app.subscriptions
    WHERE stripe_subscription_id = ${sub.id}
    LIMIT 1
  `;
  if (status.length === 0) return;

  await transitionSubscriptionStatus(tx, status[0].status, "canceled", sub.id);
});

registerWebhookHandler("customer.created", async (tx, data, _eventId) => {
  const customer = data as { id: string; metadata?: Record<string, string> };

  const schoolId = customer.metadata?.school_id;
  if (!schoolId) return;

  await tx`
    UPDATE app.schools
    SET stripe_customer_id = ${customer.id}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${schoolId}::uuid AND stripe_customer_id IS NULL
  `;
});

export function mapStripeStatus(stripeStatus: string | undefined): string | null {
  switch (stripeStatus) {
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "canceled":
      return "canceled";
    case "incomplete":
      return "trialing";
    case "incomplete_expired":
      return "expired";
    case "trialing":
      return "trialing";
    case "paused":
      return "grace_period";
    default:
      return null;
  }
}

export async function handleStripeWebhook(
  deps: WebhookHandlerDeps,
  payload: Buffer,
  signature: string,
): Promise<{ received: boolean }> {
  let event: { type: string; data: Record<string, unknown> };
  try {
    event = await deps.provider.parseWebhook(payload, signature);
  } catch {
    throw new CodedHttpException(
      400,
      ERROR_CODES.STRIPE_WEBHOOK_INVALID,
      "Invalid webhook signature",
    );
  }

  const eventId = (event.data.id as string) ?? "";

  await deps.database.begin(async (tx) => {
    const exists = await tx<{ id: string }[]>`
      SELECT id FROM app.billing_events
      WHERE provider = 'stripe' AND provider_event_id = ${eventId}
      LIMIT 1
    `;

    if (exists.length > 0) {
      deps.logger.debug(
        { event_type: event.type, event_id: eventId },
        "duplicate webhook, skipping",
      );
      return;
    }

    await tx`
      INSERT INTO app.billing_events (provider, provider_event_id, event_type, payload)
      VALUES ('stripe', ${eventId}, ${event.type}, ${JSON.stringify(event.data)})
    `;

    const handler = EVENT_HANDLERS[event.type];
    if (handler) {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      try {
        await handler(tx, event.data, eventId);
      } finally {
        await tx.unsafe("SET LOCAL ROLE studafy_app");
      }
    } else {
      deps.logger.debug({ event_type: event.type }, "no handler registered for webhook event type");
    }
  });

  return { received: true };
}

export { EVENT_HANDLERS };
