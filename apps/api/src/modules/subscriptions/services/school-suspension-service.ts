/**
 * Pause and resume a school's students' AI subscriptions on school suspension/reactivation.
 *
 * There is no "suspend a school" action in this codebase yet -- only `app.school_status` itself
 * carries a `suspended` value, and nothing writes it outside test fixtures. This module is
 * deliberately scoped to the half the subscriptions module owns: given a school id, pause or resume
 * every AI subscription under it. Whatever eventually flips `app.schools.status` calls one of these
 * two functions -- ideally inside its own transaction, so the school's status write and the AI
 * pause/resume commit together -- the same way `packages/billing/src/system-transition.ts` is a
 * function the dunning sweep calls rather than a job of its own.
 *
 * Only AI subscriptions move here. A school's own platform subscription (`app.subscriptions`) is
 * untouched: suspending a school stops its students' AI access, it does not touch what Studafy bills
 * the school itself.
 *
 * ## System-initiated, therefore `studafy_admin`
 *
 * This runs under `withSystemTx` + `setTenantScope`, the same pairing `handleStripeWebhook` uses --
 * not `withTenantTx`, which assumes an acting `studafy_app` user. There is no acting user here (a
 * school suspension is a platform decision, not a click), and just as importantly `app.students`
 * carries a second, role-scoped RLS policy beyond plain tenant isolation (`app.can_read_student`),
 * which returns false with no `app.user_id` set. `studafy_admin` is what every other unattended
 * system process in this codebase already uses for exactly that reason (see
 * `apps/workers/src/db/tenant-tx.ts`'s `withSystemTenantTx`), and it is what makes reading a
 * student's own email for the notification below possible at all.
 *
 * ## Why `paused`, not `closed`
 *
 * See packages/billing/src/state-machine.ts's "Pause/resume on school suspension" section.
 * `closed` is terminal; a suspension that must be undone by reactivation needs a real way back, so
 * this drives a new `paused` status via the `school_suspended`/`school_reactivated` intents instead.
 *
 * ## Ordering: provider call, then local transition
 *
 * Each subscription's Stripe call happens before its own `applySystemTransition`, inside the same
 * transaction as every other subscription being paused for this school -- the same order
 * `checkout-service.ts` already uses for creating a Stripe customer before recording it. Stripe's
 * `pause_collection` set/clear is idempotent, so if this transaction aborts partway (leaving some
 * subscriptions paused at Stripe but not yet recorded locally), a retry safely re-pauses the ones
 * already paused and finishes the rest -- the gap self-heals rather than double-charging or
 * double-pausing anything.
 *
 * ## Notification
 *
 * One `aiSubscription.paused` / `aiSubscription.resumed` outbox event per affected student, in the
 * same transaction as their status change -- the email dispatcher consumes it exactly the way it
 * already consumes `subscription.dunningSent` and `subscription.seatDriftReported`. Distinct from
 * `aiSubscription.statusChanged`, which `applySystemTransition` already emits for cache invalidation
 * alone and which nothing renders an email from.
 *
 * ## Audit
 *
 * `applySystemTransition` writes the audit row itself (one per affected AI subscription), the same
 * guarantee the dunning sweep rests on -- there is nothing extra to audit here.
 */

import { applySystemTransition, resolveTransition } from "@studafy/billing";
import { DOMAIN_EVENTS } from "@studafy/constants";

import { setTenantScope, withSystemTx } from "../../../db/tenant-tx";
import { emit } from "../../../lib/events/emitter";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { publishEntitlementChange } from "../entitlements/entitlement-change-publisher";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { PaymentProviderPort } from "../ports/payment-provider";
import type { BillingAuditWriter, BillingEventIntent } from "@studafy/billing";
import type { SubscriptionStatus } from "@studafy/constants";
import type { TransactionSql } from "postgres";

export interface SchoolAiSubscriptionTransitionResult {
  /** AI subscriptions the state machine actually moved. Excludes rows it refused (e.g. already paused). */
  affected: number;
}

interface AiSubscriptionRow {
  id: string;
  studentId: string;
  status: SubscriptionStatus;
  stripeSubscriptionId: string | null;
  studentEmail: string;
}

/** The API's audit writer, passed to the shared billing core -- same wiring as the webhook processor. */
const auditWriter: BillingAuditWriter = (tx, entry) => emitAuditLog(tx, entry);

/**
 * Every AI subscription under a school, with the student's own email for the notification and the
 * Stripe subscription id (when one has been linked yet) for the provider call.
 *
 * `FOR UPDATE OF ai` locks only app.ai_subscriptions -- app.students and app.users are read-only
 * here and carry no status this transition would race on.
 */
async function loadAiSubscriptions(
  tx: TransactionSql,
  schoolId: string,
): Promise<AiSubscriptionRow[]> {
  return tx<AiSubscriptionRow[]>`
    SELECT
      ai.id,
      ai.student_id AS "studentId",
      ai.status::text AS status,
      ai.stripe_subscription_id AS "stripeSubscriptionId",
      u.normalized_email AS "studentEmail"
    FROM app.ai_subscriptions AS ai
    JOIN app.students AS s ON s.id = ai.student_id AND s.school_id = ai.school_id
    JOIN app.users AS u ON u.id = s.user_id
    WHERE ai.school_id = ${schoolId}::uuid
    FOR UPDATE OF ai
  `;
}

/**
 * Move every eligible AI subscription under a school through one system-initiated intent, calling
 * the provider and notifying the student for each one that actually transitions.
 *
 * Shared by pause and resume: the two differ only in which intent, which provider call and which
 * outbox event apply, not in how the loop, the locking or the transaction boundary work.
 */
async function transitionSchoolAiSubscriptions(
  database: Database,
  provider: PaymentProviderPort,
  schoolId: string,
  logger: Logger,
  intent: BillingEventIntent,
  callProvider: (providerSubscriptionId: string) => Promise<void>,
  notificationEvent:
    typeof DOMAIN_EVENTS.AI_SUBSCRIPTION_PAUSED | typeof DOMAIN_EVENTS.AI_SUBSCRIPTION_RESUMED,
  requestId?: string,
): Promise<SchoolAiSubscriptionTransitionResult> {
  return withSystemTx(database, async (tx) => {
    await setTenantScope(tx, schoolId, requestId);

    const rows = await loadAiSubscriptions(tx, schoolId);
    let affected = 0;

    for (const row of rows) {
      // Skip rows the state machine would refuse anyway (already paused, or terminal) before
      // spending a Stripe call on them.
      if (resolveTransition("ai", row.status, intent) === null) continue;

      if (row.stripeSubscriptionId) {
        await callProvider(row.stripeSubscriptionId);
      }

      const outcome = await applySystemTransition(
        tx,
        { kind: "ai", schoolId, subscriptionId: row.id, intent },
        { emitAudit: auditWriter, publishEntitlementChange, logger, requestId },
      );

      if (outcome.outcome !== "transitioned") {
        logger.warn(
          { school_id: schoolId, ai_subscription_id: row.id, intent, outcome },
          "school-suspension transition refused by the state machine; skipping",
        );
        continue;
      }

      await emit(tx, notificationEvent, {
        schoolId,
        aiSubscriptionId: row.id,
        studentId: row.studentId,
        email: row.studentEmail,
      });

      affected += 1;
    }

    return { affected };
  });
}

/**
 * Pause every live AI subscription under a suspended school: stop Stripe billing and drop access
 * (see the module header for why `paused`, not `closed`), same-day and atomically with whatever
 * caller-side transaction flipped the school to suspended.
 */
export async function pauseAiSubscriptionsForSchoolSuspension(
  database: Database,
  provider: PaymentProviderPort,
  schoolId: string,
  logger: Logger,
  requestId?: string,
): Promise<SchoolAiSubscriptionTransitionResult> {
  return transitionSchoolAiSubscriptions(
    database,
    provider,
    schoolId,
    logger,
    "school_suspended",
    (providerSubscriptionId) => provider.pauseSubscription({ providerSubscriptionId }),
    DOMAIN_EVENTS.AI_SUBSCRIPTION_PAUSED,
    requestId,
  );
}

/**
 * Resume every paused AI subscription under a reactivated school: resume Stripe billing and
 * restore access. Always targets `active` -- see the state machine header for why a school
 * suspension is orthogonal to whatever payment-health status preceded it.
 */
export async function resumeAiSubscriptionsForSchoolReactivation(
  database: Database,
  provider: PaymentProviderPort,
  schoolId: string,
  logger: Logger,
  requestId?: string,
): Promise<SchoolAiSubscriptionTransitionResult> {
  return transitionSchoolAiSubscriptions(
    database,
    provider,
    schoolId,
    logger,
    "school_reactivated",
    (providerSubscriptionId) => provider.resumeSubscription({ providerSubscriptionId }),
    DOMAIN_EVENTS.AI_SUBSCRIPTION_RESUMED,
    requestId,
  );
}
