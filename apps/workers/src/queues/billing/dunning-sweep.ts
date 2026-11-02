/**
 * The dunning sweep (ST-134): the scheduled job that enforces grace periods.
 *
 * Once a day, per school, this:
 *
 *  1. sends each subscription's currently-due reminder (one outbox row per ORG_ADMIN) and records
 *     the stage, or
 *  2. suspends a subscription whose grace period has elapsed via `applySystemTransition`, which
 *     carries the audit, entitlement invalidation (ST-133) and AI cascade with it.
 *
 * The sweep owns the clock and the schedule; the state machine owns legality. Nothing here decides
 * whether `grace_exhausted` is a legal move -- `applySystemTransition` resolves that from the row's
 * live status, so a re-run (or a school suspension whose cascade already closed an AI row) reports
 * a no-op instead of re-auditing a change that did not happen. That is what makes this idempotent.
 *
 * Each school is handled in its own `withSystemTenantTx`, so a failure in one school cannot strand
 * the schools after it, and rows are `FOR UPDATE` locked so concurrent sweeps serialize instead of
 * double-sending reminders. `loadSchoolIds` runs on the plain connection: `app.schools` is a global
 * table with no RLS.
 */

import { applySystemTransition } from "@studafy/billing";
import { DOMAIN_EVENTS } from "@studafy/constants";

import { emitAuditLog } from "../../db/audit";
import { withSystemTenantTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import { dunningStageFor, graceStartedAtFor, isGraceExpired } from "./dunning-schedule";
import { publishEntitlementChange } from "./entitlement-change-publisher";

import type { BillingLogger } from "@studafy/billing";
import type { Sql, TransactionSql } from "postgres";

export interface DunningSweepResult {
  schools: number;
  /** Outbox rows written (one per addressed ORG_ADMIN, not one per subscription). */
  emails: number;
  schoolSuspensions: number;
  aiSuspensions: number;
}

interface GraceSubscriptionRow {
  id: string;
  planName: string;
  currentPeriodEnd: string;
  gracePeriodEndsAt: string;
  dunningEmailStage: number;
}

interface GraceAiSubscriptionRow {
  id: string;
  gracePeriodEndsAt: string | null;
}

/**
 * The payload each reminder carries, one per recipient. Mirrored in apps/api's
 * `eventPayloadSchemas[DOMAIN_EVENTS.SUBSCRIPTION_DUNNING_SENT]` -- see
 * entitlement-change-publisher.ts's header for why the two must not diverge.
 */
interface DunningOutboxPayload {
  schoolId: string;
  subscriptionId: string;
  email: string;
  planName: string;
  dueDate: string;
  gracePeriodEndsAt: string;
}

export async function runDunningSweep(
  sql: Sql,
  now: Date,
  log: BillingLogger,
): Promise<DunningSweepResult> {
  const schoolIds = await loadSchoolIds(sql);
  const result: DunningSweepResult = {
    schools: schoolIds.length,
    emails: 0,
    schoolSuspensions: 0,
    aiSuspensions: 0,
  };

  for (const schoolId of schoolIds) {
    const perSchool = await withSystemTenantTx(sql, { schoolId }, (tx) =>
      processSchool(tx, schoolId, now, log),
    );
    result.emails += perSchool.emails;
    result.schoolSuspensions += perSchool.schoolSuspensions;
    result.aiSuspensions += perSchool.aiSuspensions;
  }

  log.info({ ...result }, "dunning sweep complete");
  return result;
}

/**
 * One school's share of the sweep. Errors here abort that school's transaction (the audit and the
 * outbox rows commit or roll back together) and bubble to the caller, which has already decided the
 * next school is a separate transaction.
 */
async function processSchool(
  tx: TransactionSql,
  schoolId: string,
  now: Date,
  log: BillingLogger,
): Promise<Pick<DunningSweepResult, "emails" | "schoolSuspensions" | "aiSuspensions">> {
  const result = { emails: 0, schoolSuspensions: 0, aiSuspensions: 0 };
  const options = { emitAudit: emitAuditLog, publishEntitlementChange, logger: log };

  // School phase. `dunning_email_stage` is read inside the same FOR UPDATE lock that guards the
  // suspension decision, so a concurrent sweep sees the stage we just stored rather than re-sending.
  //
  // The `AS "camelCase"` aliases are load-bearing: postgres.js returns column names verbatim, so
  // without them the row keys would be `plan_name`/`current_period_end`/`grace_period_ends_at` and
  // the typed accessors below would be undefined at runtime. The timestamps are cast to text so the
  // typed row values are the strings the ISO re-parse expects.
  const schoolRows = await tx<GraceSubscriptionRow[]>`
    SELECT
      s.id,
      p.display_name::text AS "planName",
      s.current_period_end::text AS "currentPeriodEnd",
      s.grace_period_ends_at::text AS "gracePeriodEndsAt",
      s.dunning_email_stage AS "dunningEmailStage"
    FROM app.subscriptions AS s
    JOIN app.plans AS p ON p.id = s.plan_id
    WHERE s.school_id = ${schoolId}::uuid
      AND s.status = 'grace_period'
    FOR UPDATE
  `;

  for (const row of schoolRows) {
    if (row.gracePeriodEndsAt === null) {
      log.warn(
        { school_id: schoolId, subscription_id: row.id },
        "grace_period subscription has no deadline; left untouched",
      );
      continue;
    }

    const deadline = new Date(row.gracePeriodEndsAt);
    if (isGraceExpired(deadline, now)) {
      result.schoolSuspensions += await closeSubscription(
        tx,
        { kind: "school", schoolId, subscriptionId: row.id },
        options,
        log,
      );
      continue;
    }

    result.emails += await sendDunningReminders(tx, schoolId, row, now);
  }

  // AI phase. Runs after the school phase on purpose: when a school suspension closes an AI row via
  // the state machine's cascade, that row is no longer `grace_period` here, so this pass only ever
  // sees AI subscriptions whose school is still live -- the ones a school suspension cannot reach.
  const aiRows = await tx<GraceAiSubscriptionRow[]>`
    SELECT id, grace_period_ends_at::text AS "gracePeriodEndsAt"
    FROM app.ai_subscriptions
    WHERE school_id = ${schoolId}::uuid
      AND status = 'grace_period'
    FOR UPDATE
  `;

  for (const row of aiRows) {
    if (row.gracePeriodEndsAt === null) continue;

    if (!isGraceExpired(new Date(row.gracePeriodEndsAt), now)) continue;

    result.aiSuspensions += await closeSubscription(
      tx,
      { kind: "ai", schoolId, subscriptionId: row.id },
      options,
      log,
    );
  }

  return result;
}

/**
 * Ask the state machine to close one overdue subscription. Returns 1 when the transition actually
 * happened, 0 when it was a no-op (a concurrent sweep got there first, or the cascade did).
 */
async function closeSubscription(
  tx: TransactionSql,
  input: { kind: "school" | "ai"; schoolId: string; subscriptionId: string },
  options: Parameters<typeof applySystemTransition>[2],
  log: BillingLogger,
): Promise<number> {
  const outcome = await applySystemTransition(tx, { ...input, intent: "grace_exhausted" }, options);
  if (outcome.outcome !== "transitioned") {
    if (outcome.outcome === "noop" && outcome.reason === "illegal") {
      log.warn(
        {
          school_id: input.schoolId,
          subscription_id: input.subscriptionId,
          status: outcome.status,
        },
        "grace_exhausted refused by the state machine; skipping",
      );
    }
    return 0;
  }
  log.info(
    { school_id: input.schoolId, subscription_id: input.subscriptionId, ...outcome },
    "subscription suspended after grace period",
  );
  return 1;
}

/**
 * Send the currently-due reminder, if the schedule has advanced past the stored stage.
 *
 * One outbox row per addressed ORG_ADMIN (the email dispatcher claims one recipient per row — see
 * claim.ts's "every email-relevant event has a single recipient" note). Stage advancement is
 * per-subscription: either every recipient gets the stage's reminder or none does, since both the
 * inserts and the stage write sit in the same transaction.
 */
async function sendDunningReminders(
  tx: TransactionSql,
  schoolId: string,
  row: GraceSubscriptionRow,
  now: Date,
): Promise<number> {
  const graceStartedAt = graceStartedAtFor("school", new Date(row.gracePeriodEndsAt));
  const stage = dunningStageFor("school", graceStartedAt, now);
  if (stage <= row.dunningEmailStage) return 0;

  const recipients = await tx<{ email: string }[]>`
    SELECT u.normalized_email AS email
    FROM app.user_roles AS ur
    JOIN app.users AS u ON u.id = ur.user_id
    WHERE ur.school_id = ${schoolId}::uuid
      AND ur.role = 'ORG_ADMIN'::app.user_role
  `;

  // No recipients to advance the stage past. A retry will not conjure an ORG_ADMIN, and the email
  // would be a reminder addressed to nobody — store the stage so the sequence is not queued late,
  // on the day the deadline falls, the moment an admin finally exists.
  if (recipients.length === 0) {
    await tx`
      UPDATE app.subscriptions
      SET dunning_email_stage = ${stage}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${row.id}::uuid
    `;
    return 0;
  }

  for (const recipient of recipients) {
    const payload = {
      schoolId,
      subscriptionId: row.id,
      email: recipient.email,
      planName: row.planName,
      dueDate: new Date(row.currentPeriodEnd).toISOString(),
      gracePeriodEndsAt: new Date(row.gracePeriodEndsAt).toISOString(),
    } satisfies DunningOutboxPayload;

    await tx`
      INSERT INTO app.outbox_events (school_id, event_name, payload)
      VALUES (${schoolId}::uuid, ${DOMAIN_EVENTS.SUBSCRIPTION_DUNNING_SENT}, ${tx.json(payload)})
    `;
  }

  await tx`
    UPDATE app.subscriptions
    SET dunning_email_stage = ${stage}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${row.id}::uuid
  `;

  return recipients.length;
}
