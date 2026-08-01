/**
 * Applying one verified provider event to subscription state (ST-132).
 *
 * The transaction body, and nothing else: no HTTP, no signature verification, no queue. It lives in
 * a package rather than in apps/api because two processes need it and must reach identical
 * conclusions -- the API applies an event when it arrives, and apps/workers re-applies one that
 * failed transiently. Two implementations would eventually disagree about what an event meant, and
 * the disagreement would show up as a subscription in the wrong state rather than as a test failure.
 *
 * Everything here takes an open `TransactionSql` and returns a verdict. The caller owns the
 * transaction boundary, which is what makes "the audit row and the state change are atomic" the
 * caller's guarantee to keep rather than a promise buried in here.
 *
 * ## Order of operations, and why it is that order
 *
 *   1. **Claim** on `(provider, provider_event_id)`. First, because everything after it is wasted
 *      work if this delivery is a replay -- and because the claim is the concurrency control.
 *   2. **Classify** the event. Before any lookup: an event nobody can act on is not worth resolving
 *      a school for, and some events legitimately have no subscription at all.
 *   3. **Attribute** to a school (via the global `app.schools`), then arm tenant isolation, then
 *      attribute to a subscription. The school must come first because every subscription table is
 *      RLS-forced and would match nothing before the GUC is set.
 *   4. **Fold** the whole ordered history. Not "apply this event to the current state" -- see
 *      `foldStatus` for why the difference is the entire out-of-order story.
 *   5. **Apply and audit**, together.
 */

import { resolveSchoolId, resolveTarget } from "./attribution";
import {
  attributeEvent,
  claimEvent,
  loadFoldSequence,
  markDeadLettered,
  markProcessed,
} from "./billing-event-store";
import {
  extractCustomerId,
  extractPeriod,
  extractSchoolIdHint,
  extractSubscriptionItemId,
} from "./event-mapping";
import { deriveIntent, foldStatus, LIVE_STATUSES, resolveAiCascade } from "./state-machine";

import type { AttributionTarget } from "./attribution";
import type { SubscriptionKind } from "./state-machine";
import type { SubscriptionStatus } from "@studafy/constants";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** One audited status change. Structurally the subset of apps/api's `AuditEntry` this needs. */
export interface BillingAuditEntry {
  action: "update";
  targetTable: "subscriptions" | "ai_subscriptions";
  targetId: string;
  oldValues: { status: SubscriptionStatus };
  newValues: { status: SubscriptionStatus };
}

/**
 * Writes one `app.audit_logs` row inside the caller's transaction.
 *
 * Injected rather than implemented here so there is exactly one audit writer per process, and it is
 * the process's own -- apps/api passes `emitAuditLog` from its audit emitter, which owns the column
 * list and the redaction rules for every audited mutation in the API. A second writer living in
 * this package would be a second place those rules could drift.
 *
 * Must throw on failure. The caller's transaction rolling back is the mechanism that keeps an
 * unaudited transition from committing.
 */
export type BillingAuditWriter = (tx: TransactionSql, entry: BillingAuditEntry) => Promise<void>;

/**
 * The logging surface this package needs.
 *
 * `debug` is optional because apps/workers' logger deliberately has only three levels (see
 * apps/workers/src/log.ts) -- and the one debug line here reports a duplicate claim, which is the
 * least interesting thing that can happen. Requiring it would force a fourth level on that logger
 * to carry a message nobody reads.
 */
export interface BillingLogger {
  debug?: (fields: Record<string, unknown>, message: string) => void;
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
}

/** One verified provider event, envelope included. Mirrors `ParsedWebhookEvent` in apps/api's port. */
export interface VerifiedBillingEvent {
  id: string;
  type: string;
  effectiveAt: Date;
  data: Record<string, unknown>;
}

export interface ProcessOptions {
  emitAudit: BillingAuditWriter;
  logger: BillingLogger;
  /** Correlates the audit row with the HTTP request that caused it, when there was one. */
  requestId?: string | null;
}

export type ProcessOutcome =
  /** Already claimed by an earlier or concurrent delivery. Nothing was done, and that is correct. */
  | { outcome: "duplicate" }
  /** Recorded and finished with. `transitioned` is false for events that changed no status. */
  | { outcome: "processed"; transitioned: boolean }
  /** Recorded and parked for a human. No retry will change the verdict. */
  | { outcome: "parked"; reason: string };

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function processBillingEvent(
  tx: TransactionSql,
  event: VerifiedBillingEvent,
  options: ProcessOptions,
): Promise<ProcessOutcome> {
  const rowId = await claimEvent(tx, {
    providerEventId: event.id,
    eventType: event.type,
    effectiveAt: event.effectiveAt,
    payload: event.data,
  });

  if (rowId === null) {
    options.logger.debug?.(
      { event_id: event.id, event_type: event.type },
      "billing event already claimed; no-op",
    );
    return { outcome: "duplicate" };
  }

  return applyClaimedEvent(tx, rowId, event, options);
}

/**
 * Process an event whose `app.billing_events` row already exists.
 *
 * The retry path. A row reaching here has been claimed before and failed transiently, so the claim
 * must not be repeated -- `claimEvent` would return `null` and the retry would report a duplicate
 * and quietly do nothing, which is the failure mode that turns "we retried it" into "we dropped it".
 */
export async function reprocessClaimedEvent(
  tx: TransactionSql,
  rowId: string,
  event: VerifiedBillingEvent,
  options: ProcessOptions,
): Promise<ProcessOutcome> {
  return applyClaimedEvent(tx, rowId, event, options);
}

async function applyClaimedEvent(
  tx: TransactionSql,
  rowId: string,
  event: VerifiedBillingEvent,
  options: ProcessOptions,
): Promise<ProcessOutcome> {
  const park = async (reason: string): Promise<ProcessOutcome> => {
    await markDeadLettered(tx, rowId, reason);
    options.logger.warn(
      { event_id: event.id, event_type: event.type, reason },
      "billing event parked for manual review",
    );
    return { outcome: "parked", reason };
  };

  const resolution = deriveIntent(event.type, event.data);
  if (resolution.kind === "unmapped") {
    return park(`No handler mapping for event type "${event.type}"`);
  }

  // A known-but-uninteresting event finishes here, still holding a row with its full payload -- that
  // we saw it and chose not to act is a different fact from never having received it.
  //
  // It short-circuits *before* attribution rather than after, because some of these events sit above
  // the subscription level: `customer.created` concerns a school that may not have bought anything
  // yet. Running it through attribution would park it for "no subscription to apply this to", which
  // would fill the dead-letter queue with events behaving exactly as intended.
  if (resolution.kind === "ignored") {
    await applyCustomerSideEffects(tx, event.type, event.data);
    await markProcessed(tx, rowId);
    return { outcome: "processed", transitioned: false };
  }

  const schoolId = await resolveSchoolId(
    tx,
    extractCustomerId(event.data),
    extractSchoolIdHint(event.data),
  );
  if (schoolId === null) {
    return park("Could not attribute the event to a school by stripe_customer_id or metadata");
  }

  // From here on the transaction is tenant-scoped: app.subscriptions, app.ai_subscriptions and
  // app.audit_logs are all RLS-forced and would match zero rows without it.
  await setTenantScope(tx, schoolId, options.requestId);

  const target = await resolveTarget(tx, schoolId, event.type, event.data);
  if (target === null) {
    return park(`School ${schoolId} has no subscription this event could be applied to`);
  }

  await attributeEvent(tx, rowId, target.kind, target.id);

  const sequence = await loadFoldSequence(tx, target.kind, target.id, rowId);
  const fold = foldStatus(target.kind, sequence);

  const rejected = fold.skipped.find((step) => step.id === event.id);
  if (rejected) {
    return park(
      `Illegal transition: ${rejected.from} + ${rejected.intent} (${event.type}) has no target ` +
        `for a ${target.kind} subscription`,
    );
  }

  await applyTransition(tx, options, target, fold.status, event.data);
  await markProcessed(tx, rowId);

  return { outcome: "processed", transitioned: fold.status !== target.status };
}

// ---------------------------------------------------------------------------
// Tenant scope
// ---------------------------------------------------------------------------

/**
 * Arm tenant isolation mid-transaction, once the tenant is known.
 *
 * `set_config(..., true)` is transaction-local wherever it is called from, so setting the GUC here
 * binds every subsequent statement and evaporates at COMMIT -- the same lifetime the GUCs set at
 * BEGIN have, and the property that makes this safe under PgBouncer transaction pooling.
 *
 * `app.user_id` is deliberately left unset. The actor is the system, the role-scope helpers
 * returning false is the correct default for an unattended process, and the audit writer reads the
 * same GUC to record a NULL `actor_id` -- which is the accurate statement that no person did this.
 */
async function setTenantScope(
  tx: TransactionSql,
  schoolId: string,
  requestId?: string | null,
): Promise<void> {
  if (requestId) {
    await tx`
      SELECT set_config('app.school_id', ${schoolId}, true),
             set_config('app.request_id', ${requestId}, true)
    `.execute();
    return;
  }
  await tx`SELECT set_config('app.school_id', ${schoolId}, true)`.execute();
}

// ---------------------------------------------------------------------------
// Side effects that are not transitions
// ---------------------------------------------------------------------------

/**
 * Repair a school's `stripe_customer_id` from a customer lifecycle event.
 *
 * Carried over from the pre-ST-132 handler, and worth keeping even though the checkout service
 * writes this column in the same transaction that creates the provider customer. If that transaction
 * rolls back *after* the provider call, Stripe holds a customer Studafy has no record of -- and since
 * attribution now resolves the school through exactly this column, an unrepaired gap would make
 * every subsequent event for that school unattributable. This is the repair path.
 *
 * `IS NULL` in the predicate: this fills a hole, it never re-points an existing mapping.
 * `app.schools` is global and carries no RLS, which is why this can run before the tenant scope is
 * set -- and why it must, since a school with no customer id cannot be resolved to set one.
 */
async function applyCustomerSideEffects(
  tx: TransactionSql,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (eventType !== "customer.created" && eventType !== "customer.updated") return;

  const customerId = typeof payload.id === "string" ? payload.id : null;
  const schoolId = extractSchoolIdHint(payload);
  if (!customerId || !schoolId) return;

  await tx`
    UPDATE app.schools
    SET stripe_customer_id = ${customerId}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${schoolId}::uuid AND stripe_customer_id IS NULL
  `;
}

// ---------------------------------------------------------------------------
// Applying the result
// ---------------------------------------------------------------------------

/**
 * Write the folded status, the period the event reported, and the audit trail.
 *
 * The status is written even when it equals the current one -- the period and provider ids on the
 * same event are still worth persisting, and an idempotent UPDATE is cheaper to reason about than a
 * branch. What is conditional is the *audit row*: `app.audit_logs` records changes, and a row
 * asserting `active -> active` would be noise in the one table that has to stay readable.
 */
async function applyTransition(
  tx: TransactionSql,
  options: ProcessOptions,
  target: AttributionTarget,
  next: SubscriptionStatus,
  payload: Record<string, unknown>,
): Promise<void> {
  const period = extractPeriod(payload);

  // The nulls are cast explicitly: a bare NULL parameter inside COALESCE leaves PostgreSQL unable to
  // infer the parameter's type, which fails at prepare time rather than at review time.
  const periodStart = period?.start.toISOString() ?? null;
  const periodEnd = period?.end.toISOString() ?? null;

  if (target.kind === "school") {
    await tx`
      UPDATE app.subscriptions
      SET status = ${next}::app.subscription_status,
          current_period_start = COALESCE(${periodStart}::timestamptz, current_period_start),
          current_period_end = COALESCE(${periodEnd}::timestamptz, current_period_end),
          stripe_subscription_item_id = COALESCE(
            ${extractSubscriptionItemId(payload)}::text, stripe_subscription_item_id
          ),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${target.id}::uuid
    `;
  } else {
    await tx`
      UPDATE app.ai_subscriptions
      SET status = ${next}::app.subscription_status,
          current_period_start = COALESCE(${periodStart}::timestamptz, current_period_start),
          current_period_end = COALESCE(${periodEnd}::timestamptz, current_period_end),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${target.id}::uuid
    `;
  }

  if (next === target.status) return;

  await audit(options, tx, target.kind, target.id, target.status, next);

  if (target.kind === "school") {
    await cascadeToAiSubscriptions(tx, options, target, next);
  }
}

/**
 * Drive a school's AI subscriptions to match when the school stops being live.
 *
 * The cross-entity half of the state machine -- ST-131 gates an AI add-on on an active school
 * subscription, and no provider event expresses that dependency, so nothing but this code will
 * enforce it. In the same transaction as the school's own change, and audited per row: a student
 * losing AI access is a state change in its own right, and "why did this stop working" is answered
 * from `app.audit_logs` or not at all.
 *
 * Only rows currently in a live status move. A student whose AI subscription was already canceled
 * stays canceled rather than being dragged to `closed` behind their school -- terminal states are
 * absorbing here for the same reason they are in the transition table, and a re-run therefore
 * selects nothing and audits nothing.
 *
 * The rows are read (and locked) before the UPDATE rather than reported by `RETURNING`, because the
 * audit row needs the value *before* the change and `RETURNING` yields the value after it.
 */
async function cascadeToAiSubscriptions(
  tx: TransactionSql,
  options: ProcessOptions,
  target: AttributionTarget,
  next: SubscriptionStatus,
): Promise<void> {
  const cascade = resolveAiCascade(target.status, next);
  if (cascade === null) return;

  const affected = await tx<{ id: string; status: SubscriptionStatus }[]>`
    SELECT id, status::text AS status
    FROM app.ai_subscriptions
    WHERE school_id = ${target.schoolId}::uuid
      AND status::text = ANY(${[...LIVE_STATUSES]})
    FOR UPDATE
  `;

  if (affected.length === 0) return;

  await tx`
    UPDATE app.ai_subscriptions
    SET status = ${cascade}::app.subscription_status, updated_at = CURRENT_TIMESTAMP
    WHERE id = ANY(${affected.map((row) => row.id)}::uuid[])
  `;

  for (const row of affected) {
    await audit(options, tx, "ai", row.id, row.status, cascade);
  }

  options.logger.info(
    {
      school_id: target.schoolId,
      school_status: next,
      ai_status: cascade,
      affected: affected.length,
    },
    "school subscription left a live state; AI subscriptions cascaded",
  );
}

/**
 * One audit row for one status change, inside the caller's transaction.
 *
 * If the writer throws, the transaction rolls back and takes the status change with it. That is the
 * intended coupling, not a hazard: an unaudited billing transition is worse than an unapplied one,
 * because the next delivery can reapply the transition and nothing can reconstruct the audit.
 */
function audit(
  options: ProcessOptions,
  tx: TransactionSql,
  kind: SubscriptionKind,
  id: string,
  from: SubscriptionStatus,
  to: SubscriptionStatus,
): Promise<void> {
  return options.emitAudit(tx, {
    action: "update",
    targetTable: kind === "school" ? "subscriptions" : "ai_subscriptions",
    targetId: id,
    oldValues: { status: from },
    newValues: { status: to },
  });
}
