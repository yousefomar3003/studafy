/**
 * The seat-reconciliation sweep (ST-136): the scheduled job that keeps billed seats aligned with
 * enrolled students.
 *
 * Once a day, per active subscription, this compares the number of enrolled students against the
 * quantity Stripe is billing and moves the billed quantity to match:
 *
 *   - students > billed seats (upgrade): Stripe's invoice preview tells us the prorated charge,
 *     the quantity is raised with `proration_behavior: "always_invoice"` (charged immediately),
 *     and the school's ORG_ADMINs get a drift report naming the prorated amount;
 *   - students < billed seats (downgrade): the quantity is lowered with `proration_behavior:
 *     "none"` — no credit today, the lower seat count bills from the next renewal — and the
 *     ORG_ADMINs get a drift report naming that renewal date;
 *   - equal: nothing happens. Because reconciliation converges billed == enrolled, a re-run is a
 *     natural no-op, which is what makes the job idempotent without any marker.
 *
 * The local `student_cap` follows the reconciled seat count in both directions (cap == billed is
 * the invariant), and a stale cap with matching Stripe quantity — the footprint of a prior run
 * whose Stripe call landed but whose local commit rolled back — is silently re-synced without
 * touching Stripe again or emailing anyone.
 *
 * Each school runs in its own `withSystemTenantTx` with `FOR UPDATE` locking, mirroring the dunning
 * sweep: a Stripe or database error rolls that school's transaction back (no partial cap change,
 * no half-written report) and is counted as a failure for ops telemetry, while the schools after
 * it proceed. `loadSchoolIds` runs on the plain connection — `app.schools` is a global table with
 * no RLS. Only `active` subscriptions are reconciled: `trialing` is not being billed yet, and
 * `past_due`/`grace_period` are owned by the dunning sweep (ST-134) with Stripe billing already
 * failing.
 */

import { DOMAIN_EVENTS } from "@studafy/constants";

import { withSystemTenantTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import { seatDriftDirection } from "./seat-reconciliation-schedule";

import type { SeatDriftDirection } from "./seat-reconciliation-schedule";
import type { SeatSubscriptionProvider } from "./stripe-seat-provider";
import type { BillingLogger } from "@studafy/billing";
import type { Sql, TransactionSql } from "postgres";

export interface SeatReconciliationResult {
  schools: number;
  upgrades: number;
  downgrades: number;
  unchanged: number;
  /** Schools whose Stripe quantity already matched but whose local cap lagged (bookkeeping fix). */
  capSyncs: number;
  /** Schools skipped because they have no Stripe subscription to reconcile against. */
  skipped: number;
  /** Schools whose transaction aborted (Stripe or database error) — ops telemetry, job continues. */
  failed: number;
  /** Outbox rows written (one per addressed ORG_ADMIN, not one per subscription). */
  emails: number;
}

interface SeatSubscriptionRow {
  id: string;
  planName: string;
  studentCap: number;
  stripeSubscriptionId: string | null;
  stripeSubscriptionItemId: string | null;
  currentPeriodEnd: string;
}

interface PerSchoolResult {
  upgrades: number;
  downgrades: number;
  unchanged: number;
  capSyncs: number;
  skipped: number;
  emails: number;
}

/**
 * The payload each drift report carries, one per recipient. Mirrored in apps/api's
 * `eventPayloadSchemas[DOMAIN_EVENTS.SUBSCRIPTION_SEAT_DRIFT_REPORTED]` — see
 * entitlement-change-publisher.ts's header for why the two must not diverge.
 */
interface SeatDriftOutboxPayload {
  schoolId: string;
  subscriptionId: string;
  email: string;
  planName: string;
  activeSeatCount: number;
  billedSeatCount: number;
  delta: number;
  direction: Exclude<SeatDriftDirection, "none">;
  proratedAmountMinor: number | null;
  currency: string | null;
  effectivePeriodEnd: string | null;
}

export async function runSeatReconciliation(
  sql: Sql,
  provider: SeatSubscriptionProvider,
  now: Date,
  log: BillingLogger,
): Promise<SeatReconciliationResult> {
  const schoolIds = await loadSchoolIds(sql);
  const result: SeatReconciliationResult = {
    schools: schoolIds.length,
    upgrades: 0,
    downgrades: 0,
    unchanged: 0,
    capSyncs: 0,
    skipped: 0,
    failed: 0,
    emails: 0,
  };

  for (const schoolId of schoolIds) {
    try {
      const perSchool = await withSystemTenantTx(sql, { schoolId }, (tx) =>
        processSchool(tx, schoolId, now, provider),
      );
      result.upgrades += perSchool.upgrades;
      result.downgrades += perSchool.downgrades;
      result.unchanged += perSchool.unchanged;
      result.capSyncs += perSchool.capSyncs;
      result.skipped += perSchool.skipped;
      result.emails += perSchool.emails;
    } catch (error) {
      // Per-school failure (Stripe unreachable, unknown subscription, DB error). The transaction
      // rolled back, so no partial cap change and no half-written report; count it for ops and
      // keep the schools after it moving.
      result.failed += 1;
      log.warn(
        { school_id: schoolId, error },
        "seat reconciliation failed for school; rolled back and skipped",
      );
    }
  }

  log.info({ ...result }, "seat reconciliation complete");
  return result;
}

/**
 * One school's share of the sweep. Runs inside a system tenant transaction: the cap update and the
 * outbox rows commit or roll back together with the Stripe calls around them, so a re-run never
 * finds a report claiming a change that did not land.
 */
async function processSchool(
  tx: TransactionSql,
  schoolId: string,
  now: Date,
  provider: SeatSubscriptionProvider,
): Promise<PerSchoolResult> {
  const result: PerSchoolResult = {
    upgrades: 0,
    downgrades: 0,
    unchanged: 0,
    capSyncs: 0,
    skipped: 0,
    emails: 0,
  };

  // Only `active` subscriptions are billed for seats right now. The `AS "camelCase"` aliases are
  // load-bearing: postgres.js returns column names verbatim, so without them the row keys would be
  // `stripe_subscription_id` and the typed accessors below would be undefined at runtime.
  const rows = await tx<SeatSubscriptionRow[]>`
    SELECT
      s.id,
      p.display_name::text AS "planName",
      s.student_cap AS "studentCap",
      s.stripe_subscription_id AS "stripeSubscriptionId",
      s.stripe_subscription_item_id AS "stripeSubscriptionItemId",
      s.current_period_end::text AS "currentPeriodEnd"
    FROM app.subscriptions AS s
    JOIN app.plans AS p ON p.id = s.plan_id
    WHERE s.school_id = ${schoolId}::uuid
      AND s.status = 'active'
    FOR UPDATE
  `;

  for (const row of rows) {
    if (
      row.stripeSubscriptionId === null ||
      row.stripeSubscriptionItemId === null ||
      row.currentPeriodEnd === null
    ) {
      // No Stripe subscription to reconcile against — there is no "subscribed seats" to compare
      // the enrolled count to. Normal for schools that predate Stripe checkout.
      result.skipped += 1;
      continue;
    }

    const activeSeatCount = await countEnrolledStudents(tx, schoolId);
    const billed = await provider.fetchBilledSeats(
      row.stripeSubscriptionId,
      row.stripeSubscriptionItemId,
    );

    const direction = seatDriftDirection(activeSeatCount, billed.quantity);

    if (direction === "none" && row.studentCap === activeSeatCount) {
      result.unchanged += 1;
      continue;
    }

    if (direction === "none") {
      // Stripe already bills the right number of seats; only the local cap lagged. This is the
      // footprint of a prior run whose Stripe call landed but whose commit rolled back — close the
      // bookkeeping gap without billing Stripe again or emailing anyone.
      await setStudentCap(tx, row.id, activeSeatCount);
      result.capSyncs += 1;
      continue;
    }

    if (direction === "upgrade") {
      const preview = await provider.previewUpgrade(
        row.stripeSubscriptionId,
        row.stripeSubscriptionItemId,
        activeSeatCount,
      );
      await provider.setQuantity(
        row.stripeSubscriptionId,
        row.stripeSubscriptionItemId,
        activeSeatCount,
        "always_invoice",
      );
      await setStudentCap(tx, row.id, activeSeatCount);
      result.emails += await sendDriftReports(tx, schoolId, row, {
        direction: "upgrade",
        activeSeatCount,
        billedSeatCount: billed.quantity,
        proratedAmountMinor: preview.prorationAmountMinor,
        currency: billed.currency,
        effectivePeriodEnd: null,
      });
      result.upgrades += 1;
      continue;
    }

    await provider.setQuantity(
      row.stripeSubscriptionId,
      row.stripeSubscriptionItemId,
      activeSeatCount,
      "none",
    );
    await setStudentCap(tx, row.id, activeSeatCount);
    result.emails += await sendDriftReports(tx, schoolId, row, {
      direction: "downgrade",
      activeSeatCount,
      billedSeatCount: billed.quantity,
      proratedAmountMinor: null,
      currency: null,
      effectivePeriodEnd: new Date(row.currentPeriodEnd).toISOString(),
    });
    result.downgrades += 1;
  }

  return result;
}

async function countEnrolledStudents(tx: TransactionSql, schoolId: string): Promise<number> {
  const rows = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM app.students
    WHERE school_id = ${schoolId}::uuid
      AND status = 'enrolled'
  `;
  return rows[0].count;
}

async function setStudentCap(
  tx: TransactionSql,
  subscriptionId: string,
  cap: number,
): Promise<void> {
  await tx`
    UPDATE app.subscriptions
    SET student_cap = ${cap}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${subscriptionId}::uuid
  `;
}

/**
 * One outbox row per addressed ORG_ADMIN (the email dispatcher claims one recipient per row — see
 * claim.ts's "every email-relevant event has a single recipient" note). A school with no ORG_ADMIN
 * gets no report: the drift was reconciled either way, and unlike the dunning stage there is no
 * sequence marker to advance.
 */
async function sendDriftReports(
  tx: TransactionSql,
  schoolId: string,
  row: SeatSubscriptionRow,
  report: {
    direction: Exclude<SeatDriftDirection, "none">;
    activeSeatCount: number;
    billedSeatCount: number;
    proratedAmountMinor: number | null;
    currency: string | null;
    effectivePeriodEnd: string | null;
  },
): Promise<number> {
  const recipients = await tx<{ email: string }[]>`
    SELECT u.normalized_email AS email
    FROM app.user_roles AS ur
    JOIN app.users AS u ON u.id = ur.user_id
    WHERE ur.school_id = ${schoolId}::uuid
      AND ur.role = 'ORG_ADMIN'::app.user_role
  `;

  for (const recipient of recipients) {
    const payload = {
      schoolId,
      subscriptionId: row.id,
      email: recipient.email,
      planName: row.planName,
      activeSeatCount: report.activeSeatCount,
      billedSeatCount: report.billedSeatCount,
      delta: report.activeSeatCount - report.billedSeatCount,
      direction: report.direction,
      proratedAmountMinor: report.proratedAmountMinor,
      currency: report.currency,
      effectivePeriodEnd: report.effectivePeriodEnd,
    } satisfies SeatDriftOutboxPayload;

    await tx`
      INSERT INTO app.outbox_events (school_id, event_name, payload)
      VALUES (${schoolId}::uuid, ${DOMAIN_EVENTS.SUBSCRIPTION_SEAT_DRIFT_REPORTED}, ${tx.json(payload)})
    `;
  }

  return recipients.length;
}
