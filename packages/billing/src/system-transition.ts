/**
 * Applying one *system-initiated* transition to subscription state (ST-134).
 *
 * The webhook path (process.ts) applies transitions the provider asked for; this is the sibling for
 * transitions nobody asks for but the calendar does. The scheduled dunning job is the only caller:
 * a subscription whose `grace_period_ends_at` has passed must be closed with `grace_exhausted`, and
 * there is no Stripe event for "a deadline elapsed" -- the provider already told us this subscription
 * was doomed when it exhausted its own dunning.
 *
 * Reusing `applyTransition` rather than writing a second, quieter UPDATE is the whole point. That
 * one function owns the status write, the audit row, the entitlement version bump and outbox event
 * (ST-133), and the AI cascade -- the same guarantees the webhook path rests on. A suspension that
 * bypassed it would move a subscription while its caches and every outstanding token still believed
 * the old state, which is precisely the failure ST-133 exists to remove.
 *
 * ## Precondition: tenant scope
 *
 * The transaction must already have `app.school_id` set (run it through `withSystemTenantTx`, not a
 * bare transaction): every row this reads and writes is under FORCE'd RLS, and the audit and outbox
 * writes take the tenant from the same GUC. The caller also decides *when* the transition is due --
 * this function never checks the clock, so the sweep's cutoff and the deadline stay the sweep's
 * responsibility and the state machine's `(from, intent)` table stays the only legality check.
 */

import { applyTransition } from "./process";
import { resolveTransition } from "./state-machine";

import type { AttributionTarget } from "./attribution";
import type { ProcessOptions } from "./process";
import type { BillingEventIntent, SubscriptionKind } from "./state-machine";
import type { SubscriptionStatus } from "@studafy/constants";
import type { TransactionSql } from "postgres";

export interface SystemTransitionInput {
  kind: SubscriptionKind;
  schoolId: string;
  subscriptionId: string;
  intent: BillingEventIntent;
}

export type SystemTransitionOutcome =
  | { outcome: "transitioned"; previousStatus: SubscriptionStatus; status: SubscriptionStatus }
  | {
      outcome: "noop";
      reason: "not-found" | "illegal";
      status: SubscriptionStatus | null;
    };

/**
 * Apply one system transition, or report why nothing happened.
 *
 * `noop` is not an error: a row that was already `closed` (a re-run, or a school suspension whose
 * cascade got there first) resolves no `grace_exhausted` transition and returns `illegal` rather
 * than re-auditing a change that did not happen. That is what makes the sweep idempotent under
 * concurrency and retries.
 */
export async function applySystemTransition(
  tx: TransactionSql,
  input: SystemTransitionInput,
  options: ProcessOptions,
): Promise<SystemTransitionOutcome> {
  const row = await loadRowForUpdate(tx, input.kind, input.schoolId, input.subscriptionId);
  if (row === null) return { outcome: "noop", reason: "not-found", status: null };

  const next = resolveTransition(input.kind, row.status, input.intent);
  if (next === null) return { outcome: "noop", reason: "illegal", status: row.status };

  const target: AttributionTarget = {
    kind: input.kind,
    id: input.subscriptionId,
    schoolId: input.schoolId,
    studentId: row.studentId,
    status: row.status,
  };

  await applyTransition(tx, options, target, next, {});

  return { outcome: "transitioned", previousStatus: row.status, status: next };
}

/**
 * Read and lock the row the transition would move, scoped to the armed tenant.
 *
 * `FOR UPDATE` so two concurrent sweeps serialize on the row instead of both folding the same
 * transition; the second one then sees the new status and resolves no transition. The row is also
 * the source of the audit's `from` value, which is why it is read (and locked) before the UPDATE
 * rather than reported by `RETURNING`.
 */
async function loadRowForUpdate(
  tx: TransactionSql,
  kind: SubscriptionKind,
  schoolId: string,
  subscriptionId: string,
): Promise<{ status: SubscriptionStatus; studentId: string | null } | null> {
  if (kind === "school") {
    const rows = await tx<{ status: SubscriptionStatus }[]>`
      SELECT status::text AS status
      FROM app.subscriptions
      WHERE id = ${subscriptionId}::uuid AND school_id = ${schoolId}::uuid
      FOR UPDATE
    `;
    return rows.length > 0 ? { status: rows[0]!.status, studentId: null } : null;
  }

  const rows = await tx<{ status: SubscriptionStatus; student_id: string }[]>`
    SELECT status::text AS status, student_id
    FROM app.ai_subscriptions
    WHERE id = ${subscriptionId}::uuid AND school_id = ${schoolId}::uuid
    FOR UPDATE
  `;
  return rows.length > 0 ? { status: rows[0]!.status, studentId: rows[0]!.student_id } : null;
}
