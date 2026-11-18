import { REVENUE_SHARE_MEASURES } from "@studafy/billing";

import { auditLicenseChange } from "./context";

import type { LicenseActor } from "./context";
import type { RevenueShareContext, RevenueShareMeasures } from "@studafy/billing";
import type { TransactionSql } from "postgres";

/**
 * How the API runs the shared revenue share engine (@studafy/billing, migration 000237): in the
 * caller's school transaction, every change audited as the actor (a super admin's change writes the
 * school's system row and the operator's own row, as every licensing change does).
 */

let measures: RevenueShareMeasures = REVENUE_SHARE_MEASURES;

/**
 * Replace the engine's measures (the opt-in count, the upload consistency, the commitment) for the
 * API process; returns a function that puts the previous ones back. The integration tests use it to
 * stand in for phases 2 and 4. Production uses REVENUE_SHARE_MEASURES: the adapters are swapped in
 * packages/billing/src/ai-revenue-share/measures.ts, not here.
 */
export function useRevenueShareMeasures(next: RevenueShareMeasures): () => void {
  const previous = measures;
  measures = next;
  return () => {
    measures = previous;
  };
}

/** The measures in use (REVENUE_SHARE_MEASURES unless a test replaced them). */
export function revenueShareMeasures(): RevenueShareMeasures {
  return measures;
}

export function shareContext(
  tx: TransactionSql,
  schoolId: string,
  actor: LicenseActor,
  now: Date,
): RevenueShareContext {
  return {
    schoolId,
    now,
    measures,
    audit: async (entries) => {
      for (const entry of entries) {
        await auditLicenseChange(tx, schoolId, actor, {
          action: entry.action,
          targetTable: entry.targetTable,
          targetId: entry.targetId,
          ...(entry.oldValues ? { oldValues: entry.oldValues } : {}),
          ...(entry.newValues ? { newValues: entry.newValues } : {}),
        });
      }
    },
  };
}
