/**
 * The Stripe webhook processor (ST-132).
 *
 * The API's half of the job: verify the signature over the raw bytes, open the transaction, hand the
 * verified event to `@studafy/billing`, and decide what a failure means. The state machine, the
 * attribution and the fold live in that package because apps/workers re-runs exactly the same logic
 * on a retry and the two must not be able to disagree.
 *
 * ```
 *   verify signature ─fail→ alert + 400 (never recorded; an unverified body is not evidence)
 *          │
 *   withSystemTx ──→ processBillingEvent ──→ 200
 *          │                 duplicate | processed | parked
 *          └─throw→ record 'failed' out-of-band + enqueue retry + rethrow
 * ```
 *
 * The whole of `processBillingEvent` runs in one transaction, and that is what makes the audit row
 * and the state change atomic: if the audit write throws, the status change rolls back with it, and
 * so does the claim -- so the next delivery of that event is a fresh attempt rather than a permanent
 * hole. ST-132's "audit write failure must roll back the transition" and its "replayed events
 * processed exactly once" are the same transaction boundary seen from two sides.
 *
 * ## Three ways an event can fail, and why they are not the same
 *
 *   - **Rejected at the door.** A bad signature never becomes a row. Recording unverified bodies
 *     would let anyone fill the table.
 *   - **Parked (`dlq`).** Unattributable, unmapped, or an illegal transition. A retry produces the
 *     same verdict, so retrying would burn attempts to reach it again; the row keeps its raw payload
 *     and its reason and waits for a human.
 *   - **Failed (`failed`).** Something transient -- a lock timeout, a dropped connection. Recorded
 *     out-of-band, because the transaction that would have recorded it is being rolled back, and
 *     handed to the billing queue, which retries with backoff and dead-letters on exhaustion.
 */

import { markFailed, processBillingEvent, truncateError } from "@studafy/billing";
import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withSystemTx } from "../../../db/tenant-tx";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { emitWebhookSignatureFailure } from "../billing-anomaly-events";

import type { Database, DatabasePools } from "../../../db/client";
import type { SecurityEventSink } from "../../../lib/security/securityEventSink";
import type { Logger } from "../../../logger";
import type { PaymentProviderPort, ParsedWebhookEvent } from "../ports/payment-provider";
import type { BillingAuditWriter } from "@studafy/billing";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Enqueue a transient failure for retry. Absent in tests and when no queue is configured. */
export type BillingEventRetryEnqueuer = (input: { providerEventId: string }) => Promise<void>;

export interface WebhookProcessorDeps {
  database: Database | DatabasePools;
  provider: PaymentProviderPort;
  logger: Logger;
  eventSink?: SecurityEventSink | null;
  enqueueRetry?: BillingEventRetryEnqueuer;
}

/** Request facts the processor reports on but never trusts. */
export interface WebhookRequestContext {
  path: string;
  clientIp?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * What happened, for the route's response body and for tests.
 *
 * Every outcome answers 200 except a signature failure, which throws. A 4xx for an event we merely
 * could not use would make Stripe redeliver it forever -- the same reasoning the ERPNext webhook
 * documents for unknown doctypes.
 */
export interface WebhookOutcome {
  received: true;
  outcome: "duplicate" | "processed" | "parked";
}

/**
 * The API's audit writer, passed to the shared core.
 *
 * `emitAuditLog` owns the column list, the redaction rules and the GUC-derived identity columns for
 * every audited mutation in this app; billing transitions use it rather than a writer of their own
 * so there is one place those rules live.
 */
const auditWriter: BillingAuditWriter = (tx, entry) => emitAuditLog(tx, entry);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleStripeWebhook(
  deps: WebhookProcessorDeps,
  payload: Buffer,
  signature: string | null,
  context: WebhookRequestContext,
): Promise<WebhookOutcome> {
  const event = await verify(deps, payload, signature, context);

  try {
    const result = await withSystemTx(deps.database, (tx) =>
      processBillingEvent(
        tx,
        { id: event.id, type: event.type, effectiveAt: event.effectiveAt, data: event.data },
        { emitAudit: auditWriter, logger: deps.logger, requestId: context.requestId },
      ),
    );

    return { received: true, outcome: result.outcome };
  } catch (error) {
    await recordTransientFailure(deps, event.id, error);
    throw error;
  }
}

/**
 * Verify the signature over the raw bytes, or reject.
 *
 * The bytes are the request body exactly as received. Re-serializing a parsed object first would
 * change whitespace and key order and fail verification for every legitimate delivery -- and worse,
 * verifying a re-serialization verifies something other than what arrived.
 *
 * A missing header and a failed check are distinguished in telemetry because they mean different
 * things operationally (an unconfigured sender versus a rotated secret or a probe) and are answered
 * identically, so the distinction costs the caller nothing.
 */
async function verify(
  deps: WebhookProcessorDeps,
  payload: Buffer,
  signature: string | null,
  context: WebhookRequestContext,
): Promise<ParsedWebhookEvent> {
  if (!signature) {
    emitWebhookSignatureFailure(deps.logger, deps.eventSink, {
      ...context,
      reason: "missing_signature",
    });
    throw new CodedHttpException(
      400,
      ERROR_CODES.STRIPE_WEBHOOK_INVALID,
      "Missing stripe-signature header",
    );
  }

  try {
    const event = await deps.provider.parseWebhook(payload, signature);
    // A signed event with no id cannot be claimed, deduplicated or replayed, and would violate
    // ck_billing_events_provider_event_id on the way in. Refused here, where the answer is a 400
    // rather than an unhandled constraint violation and a 500.
    if (event.id.trim() === "") {
      throw new Error("provider event carries no id");
    }
    return event;
  } catch {
    emitWebhookSignatureFailure(deps.logger, deps.eventSink, {
      ...context,
      reason: "verification_failed",
    });
    throw new CodedHttpException(
      400,
      ERROR_CODES.STRIPE_WEBHOOK_INVALID,
      "Invalid webhook signature",
    );
  }
}

// ---------------------------------------------------------------------------
// Transient failure
// ---------------------------------------------------------------------------

/**
 * Record a transient failure and hand it to the retry queue.
 *
 * Best-effort by construction and deliberately so: the caller is already unwinding with a real
 * error, and a failure to *write about* that failure must not replace it with a less informative
 * one. Both steps therefore swallow and log rather than throw.
 *
 * The UPDATE matches on `(provider, provider_event_id)` rather than on a row id, because the
 * transaction that produced the id has been rolled back -- and if the claim itself is what rolled
 * back, there is no row, the UPDATE matches nothing, and the next delivery starts cleanly. Both
 * outcomes are correct.
 */
async function recordTransientFailure(
  deps: WebhookProcessorDeps,
  providerEventId: string,
  error: unknown,
): Promise<void> {
  // A rejected signature is not a processing failure and never reached the database.
  if (error instanceof CodedHttpException) return;

  const reason = truncateError(error instanceof Error ? error.message : String(error));

  deps.logger.error(
    { err: error, event_id: providerEventId },
    "stripe webhook processing failed; will retry",
  );

  try {
    await withSystemTx(deps.database, (tx) => markFailed(tx, providerEventId, reason));
  } catch (writeError) {
    deps.logger.error(
      { err: writeError, event_id: providerEventId },
      "could not record a failed stripe webhook",
    );
  }

  try {
    await deps.enqueueRetry?.({ providerEventId });
  } catch (enqueueError) {
    deps.logger.error(
      { err: enqueueError, event_id: providerEventId },
      "could not enqueue a stripe webhook retry",
    );
  }
}
