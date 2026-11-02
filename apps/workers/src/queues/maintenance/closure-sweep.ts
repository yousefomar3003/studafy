/**
 * The tenant-closure sweep (ST-268): the scheduled job that turns "this school's subscription
 * reached `closed`" (packages/billing's state machine, driven today by the dunning sweep's
 * `grace_exhausted` transition) into the two data subject requests closure requires -- an export
 * first, an erasure once its retention hold has elapsed.
 *
 * Two stages, one idempotency rule each: never file a `tenant`-scope request of a given type for a
 * school that already has one (whatever its status), checked via
 * findLatestTenantClosureRequest. A closed school is swept every run until both requests exist;
 * once they do, every later run is a no-op for it. Same "one school, one transaction, errors don't
 * strand later schools" shape dunning-sweep.ts uses, for the same reason.
 */

import { withSystemTenantTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import { resolveAdminActor } from "./admin-actor";
import { createDsrRequest, findLatestTenantClosureRequest } from "./dsr-store";

import type { BillingLogger } from "@studafy/billing";
import type { Sql, TransactionSql } from "postgres";

/**
 * How long a completed closure export sits before the erasure that follows it is filed. Gives an
 * accidentally- or fraudulently-closed school a real window to reactivate before its data is
 * touched -- deliberately distinct from retention-registry.ts's LEGAL_HOLD_TABLES, which governs
 * what erasure itself may never touch, not when erasure runs.
 */
export const CLOSURE_ERASURE_RETENTION_HOLD_DAYS = 30;

const MILLIS_PER_DAY = 86_400_000;

/** GDPR Art. 12(3)'s one-month response deadline, from the moment a request is filed. */
function slaDueAt(now: Date): Date {
  return new Date(now.getTime() + 30 * MILLIS_PER_DAY);
}

export interface ClosureSweepResult {
  schoolsClosed: number;
  exportsQueued: number;
  erasuresQueued: number;
}

export type EnqueueDsrJob = (input: {
  schoolId: string;
  requestId: string;
  kind: "export" | "erasure";
}) => Promise<void>;

export async function runTenantClosureSweep(
  sql: Sql,
  now: Date,
  enqueue: EnqueueDsrJob,
  log: BillingLogger,
): Promise<ClosureSweepResult> {
  const schoolIds = await loadSchoolIds(sql);
  const result: ClosureSweepResult = { schoolsClosed: 0, exportsQueued: 0, erasuresQueued: 0 };

  for (const schoolId of schoolIds) {
    const outcome = await withSystemTenantTx(sql, { schoolId }, (tx) =>
      processSchoolClosure(tx, schoolId, now, log),
    );
    if (!outcome) continue;
    result.schoolsClosed += 1;

    if (outcome.export) {
      await enqueue({ schoolId, requestId: outcome.export.id, kind: "export" });
      result.exportsQueued += 1;
    }
    if (outcome.erasure) {
      await enqueue({ schoolId, requestId: outcome.erasure.id, kind: "erasure" });
      result.erasuresQueued += 1;
    }
  }

  log.info({ ...result }, "tenant closure sweep complete");
  return result;
}

interface SchoolClosureOutcome {
  export?: { id: string };
  erasure?: { id: string };
}

async function processSchoolClosure(
  tx: TransactionSql,
  schoolId: string,
  now: Date,
  log: BillingLogger,
): Promise<SchoolClosureOutcome | null> {
  const [closed] = await tx`
    SELECT 1 FROM app.subscriptions WHERE school_id = ${schoolId}::uuid AND status = 'closed' LIMIT 1
  `;
  if (!closed) return null;

  let adminUserId: string;
  try {
    adminUserId = await resolveAdminActor(tx, schoolId);
  } catch (error) {
    // No admin left to attribute the request to (requested_by_user_id is NOT NULL). Logged, not
    // thrown -- one school missing an admin must not abort the sweep for every school after it.
    log.warn(
      { school_id: schoolId, error: String(error) },
      "closed school has no admin to file a DSR as",
    );
    return null;
  }

  const outcome: SchoolClosureOutcome = {};

  const existingExport = await findLatestTenantClosureRequest(tx, schoolId, "export");
  if (!existingExport) {
    const created = await createDsrRequest(tx, {
      schoolId,
      requestType: "export",
      subjectScope: "tenant",
      reason: "tenant_closure",
      subjectUserId: null,
      requestedByUserId: adminUserId,
      slaDueAt: slaDueAt(now),
    });
    outcome.export = { id: created.id };
    return outcome;
  }

  // Erasure only follows a *completed* export, and only after the retention hold has elapsed.
  if (existingExport.status !== "completed" || !existingExport.completedAt) return outcome;
  const holdElapsedMs = now.getTime() - existingExport.completedAt.getTime();
  if (holdElapsedMs < CLOSURE_ERASURE_RETENTION_HOLD_DAYS * MILLIS_PER_DAY) return outcome;

  const existingErasure = await findLatestTenantClosureRequest(tx, schoolId, "erasure");
  if (existingErasure) return outcome;

  const created = await createDsrRequest(tx, {
    schoolId,
    requestType: "erasure",
    subjectScope: "tenant",
    reason: "tenant_closure",
    subjectUserId: null,
    requestedByUserId: adminUserId,
    slaDueAt: slaDueAt(now),
  });
  outcome.erasure = { id: created.id };
  return outcome;
}
