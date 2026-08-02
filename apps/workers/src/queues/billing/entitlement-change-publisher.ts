import { DOMAIN_EVENTS } from "@studafy/constants";

import type { EntitlementChangePublisher } from "@studafy/billing";
import type { TransactionSql } from "postgres";

/**
 * The workers' entitlement change publisher (ST-133), for the billing retry path.
 *
 * Same contract as apps/api's implementation: bump the subject's durable version counter, then write
 * the domain event carrying the version the bump returned, both inside the caller's transaction. A
 * retried event that finally applies its transition must invalidate caches exactly as the original
 * webhook would have.
 *
 * The outbox row is written raw rather than through apps/api's `emit` helper, because that helper
 * and its Zod payload schemas live in the API app and this package cannot import them. The same
 * applies to `attendance-alert.worker.ts` and `notifications/dead-letter.ts`, which write outbox rows
 * the same way. **The payload shape below is mirrored in apps/api's `eventPayloadSchemas`** -- the
 * pub/sub subscriber and the invalidator both re-validate against it, so a divergence here surfaces
 * as a dropped invalidation rather than a crash.
 */
export const publishEntitlementChange: EntitlementChangePublisher = async (tx, change) => {
  if (change.kind === "school") {
    const version = await bumpVersion(tx, "school", change.schoolId);

    await insertOutboxRow(tx, change.schoolId, DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED, {
      schoolId: change.schoolId,
      subscriptionId: change.subscriptionId,
      previousStatus: change.previousStatus,
      status: change.status,
      entitlementsVersion: version,
    });
    return;
  }

  const { studentId } = change;
  if (studentId === null) {
    throw new Error(
      `ai entitlement change for subscription ${change.subscriptionId} carries no student id`,
    );
  }

  const version = await bumpVersion(tx, "ai", studentId);

  await insertOutboxRow(tx, change.schoolId, DOMAIN_EVENTS.AI_SUBSCRIPTION_STATUS_CHANGED, {
    schoolId: change.schoolId,
    studentId,
    aiSubscriptionId: change.subscriptionId,
    previousStatus: change.previousStatus,
    status: change.status,
    entitlementsVersion: version,
  });
};

/**
 * Atomic upsert-and-increment. Mirrors `bumpEntitlementVersion` in
 * apps/api/src/modules/subscriptions/entitlements/version.ts -- see it for why INSERT ... ON CONFLICT
 * DO UPDATE is race-safe under concurrent redelivery.
 *
 * `school_id` is written from the GUC rather than from the change, so the row can never land outside
 * the tenant scope the surrounding transaction armed.
 */
async function bumpVersion(
  tx: TransactionSql,
  subject: "school" | "ai",
  subjectId: string,
): Promise<number> {
  const [row] = await tx<{ version: string }[]>`
    INSERT INTO app.entitlement_versions (school_id, subject_type, subject_id, version)
    VALUES (
      current_setting('app.school_id')::uuid,
      ${subject}::app.entitlement_subject,
      ${subjectId}::uuid,
      2
    )
    ON CONFLICT ON CONSTRAINT pk_entitlement_versions
    DO UPDATE SET version = app.entitlement_versions.version + 1,
                  updated_at = CURRENT_TIMESTAMP
    RETURNING version::text AS version
  `;

  if (!row) {
    throw new Error(`entitlement version bump returned no row for ${subject}:${subjectId}`);
  }

  return Number(row.version);
}

/**
 * The two payload shapes, spelled out rather than widened to `Record<string, unknown>` — `tx.json`
 * only accepts a structurally JSON-serializable type, and that check is worth keeping.
 */
type EntitlementEventPayload =
  | {
      schoolId: string;
      subscriptionId: string;
      previousStatus: string;
      status: string;
      entitlementsVersion: number;
    }
  | {
      schoolId: string;
      studentId: string;
      aiSubscriptionId: string;
      previousStatus: string;
      status: string;
      entitlementsVersion: number;
    };

async function insertOutboxRow(
  tx: TransactionSql,
  schoolId: string,
  eventName: string,
  payload: EntitlementEventPayload,
): Promise<void> {
  // tx.json(), not JSON.stringify() + ::jsonb — app.outbox_events has no CHECK to catch that
  // mistake, so it would store a jsonb *string* silently and corrupt every consumer downstream.
  const body = tx.json(payload);

  await tx`
    INSERT INTO app.outbox_events (school_id, event_name, payload)
    VALUES (${schoolId}::uuid, ${eventName}, ${body})
  `;
}
