/**
 * The payment-provider webhook processor (ST-132, generalized for Tap in ST-298).
 *
 * Provider-agnostic by construction: everything provider-specific -- how the signature is checked,
 * what the envelope looks like, which of the provider's words map to which of ours -- happens inside
 * `PaymentProviderPort.parseWebhook`. What reaches this module is already a verified event in the
 * shared (Stripe-shaped) vocabulary, so Stripe and Tap run through one pipeline rather than two
 * that could drift.
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
import { ERROR_CODES, PAYMENT_PURPOSES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withSystemTx } from "../../../db/tenant-tx";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { emitWebhookSignatureFailure } from "../billing-anomaly-events";
import { publishEntitlementChange } from "../entitlements/entitlement-change-publisher";
import { PaymentProviderError } from "../ports/payment-provider";

import type { Database, DatabasePools } from "../../../db/client";
import type { SecurityEventSink } from "../../../lib/security/securityEventSink";
import type { Logger } from "../../../logger";
import type { PaymentProviderPort, ParsedWebhookEvent } from "../ports/payment-provider";
import type { BillingAuditWriter, BillingProvider } from "@studafy/billing";
import type { ErrorCode } from "@studafy/constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Enqueue a transient failure for retry. Absent in tests and when no queue is configured. */
export type BillingEventRetryEnqueuer = (input: {
  provider: BillingProvider;
  providerEventId: string;
}) => Promise<void>;

/**
 * Settles a one-time payment (online fees) from a verified provider event. Injected by the app, so
 * this module stays free of any finance import; see modules/finance/online-payments/service.ts.
 */
export type FeePaymentSettler = (
  provider: BillingProvider,
  event: ParsedWebhookEvent,
) => Promise<WebhookOutcome["outcome"]>;

export interface WebhookProcessorDeps {
  database: Database | DatabasePools;
  /** Which provider `provider` is. Keys the ledger row, the alert, and the 400's error code. */
  providerName: BillingProvider;
  provider: PaymentProviderPort;
  logger: Logger;
  eventSink?: SecurityEventSink | null;
  enqueueRetry?: BillingEventRetryEnqueuer;
  /** Absent when fee collection is not wired; a fee event then answers 503 for redelivery. */
  settleFeePayment?: FeePaymentSettler;
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
 * could not use would make the provider redeliver it forever -- the same reasoning the ERPNext webhook
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

const WEBHOOK_INVALID_CODES: Readonly<Record<BillingProvider, ErrorCode>> = {
  stripe: ERROR_CODES.STRIPE_WEBHOOK_INVALID,
  tap: ERROR_CODES.TAP_WEBHOOK_INVALID,
};

const PROVIDER_UNAVAILABLE_CODES: Readonly<Record<BillingProvider, ErrorCode>> = {
  stripe: ERROR_CODES.STRIPE_API_ERROR,
  tap: ERROR_CODES.TAP_API_ERROR,
};

export async function handleBillingWebhook(
  deps: WebhookProcessorDeps,
  payload: Buffer,
  signature: string | null,
  context: WebhookRequestContext,
): Promise<WebhookOutcome> {
  const event = await verify(deps, payload, signature, context);

  // A one-time fee payment is not a subscription event, whatever its type says: Stripe reports a
  // paid fee Checkout as `checkout.session.completed`, which the state machine would read as a
  // plan activation. Routed away before the pipeline can see it.
  if (isFeePaymentEvent(event)) {
    if (!deps.settleFeePayment) {
      throw new CodedHttpException(
        503,
        ERROR_CODES.INTERNAL_ERROR,
        "Fee payment settlement is not configured",
      );
    }
    return { received: true, outcome: await deps.settleFeePayment(deps.providerName, event) };
  }

  try {
    const result = await withSystemTx(deps.database, (tx) =>
      processBillingEvent(
        tx,
        {
          provider: deps.providerName,
          id: event.id,
          type: event.type,
          effectiveAt: event.effectiveAt,
          data: event.data,
        },
        {
          emitAudit: auditWriter,
          publishEntitlementChange,
          logger: deps.logger,
          requestId: context.requestId,
        },
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
 *
 * A provider that has to call home to finish verifying (Tap re-reads the charge) can fail for a
 * reason that says nothing about the signature. That surfaces as a `PaymentProviderError` with a 5xx
 * status and is answered 503 without a security alert: the delivery may be perfectly genuine, and
 * the provider's redelivery is the retry.
 */
async function verify(
  deps: WebhookProcessorDeps,
  payload: Buffer,
  signature: string | null,
  context: WebhookRequestContext,
): Promise<ParsedWebhookEvent> {
  const invalidCode = WEBHOOK_INVALID_CODES[deps.providerName];

  if (!signature) {
    emitWebhookSignatureFailure(deps.logger, deps.eventSink, {
      ...context,
      provider: deps.providerName,
      reason: "missing_signature",
    });
    throw new CodedHttpException(400, invalidCode, "Missing webhook signature header");
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
  } catch (error) {
    if (error instanceof PaymentProviderError && error.status >= 500) {
      deps.logger.warn(
        { err: error, provider: deps.providerName, request_id: context.requestId },
        "payment provider unavailable while verifying a webhook; answering 503 for redelivery",
      );
      throw new CodedHttpException(
        503,
        PROVIDER_UNAVAILABLE_CODES[deps.providerName],
        "Payment provider unavailable",
      );
    }

    emitWebhookSignatureFailure(deps.logger, deps.eventSink, {
      ...context,
      provider: deps.providerName,
      reason: "verification_failed",
    });
    throw new CodedHttpException(400, invalidCode, "Invalid webhook signature");
  }
}

function isFeePaymentEvent(event: ParsedWebhookEvent): boolean {
  const metadata = event.data.metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    (metadata as Record<string, unknown>).purpose === PAYMENT_PURPOSES.FEE_PAYMENT
  );
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

  const provider = deps.providerName;

  deps.logger.error(
    { err: error, provider, event_id: providerEventId },
    "billing webhook processing failed; will retry",
  );

  try {
    await withSystemTx(deps.database, (tx) => markFailed(tx, provider, providerEventId, reason));
  } catch (writeError) {
    deps.logger.error(
      { err: writeError, provider, event_id: providerEventId },
      "could not record a failed billing webhook",
    );
  }

  try {
    await deps.enqueueRetry?.({ provider, providerEventId });
  } catch (enqueueError) {
    deps.logger.error(
      { err: enqueueError, provider, event_id: providerEventId },
      "could not enqueue a billing webhook retry",
    );
  }
}
