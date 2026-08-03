import { withTenantTx } from "../../../db/tenant-tx";
import { checkStudentCap } from "../../students/services/student-cap";

import { requireSchoolSubscription } from "./subscription-service";

import type { Database } from "../../../db";
import type { TenantContext } from "../../../db/tenant-tx";

export interface BillingOverview {
  subscription: {
    id: string;
    status: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    cancellationRequestedAt: Date | null;
    cancellationReason: string | null;
    retentionState: string;
  };
  plan: {
    id: string;
    code: string;
    displayName: string;
  };
  seats: {
    used: number;
    cap: number;
  };
}

/**
 * The portal's single "current plan" read: subscription lifecycle state, the plan it is on, and
 * seat usage against the cap -- one tenant transaction, three already-existing sources joined for
 * display rather than duplicated.
 */
export async function getBillingOverview(
  database: Database,
  schoolId: string,
  tenantContext: TenantContext,
): Promise<BillingOverview> {
  return withTenantTx(database, tenantContext, async (tx) => {
    const subscription = await requireSchoolSubscription(tx, schoolId);

    const [plan] = await tx<{ id: string; code: string; display_name: string }[]>`
      SELECT id, code, display_name
      FROM app.plans
      WHERE id = ${subscription.planId}::uuid
      LIMIT 1
    `;

    const seats = await checkStudentCap(tx, 0);

    return {
      subscription: {
        id: subscription.id,
        status: subscription.status,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        cancellationRequestedAt: subscription.cancellationRequestedAt,
        cancellationReason: subscription.cancellationReason,
        retentionState: subscription.retentionState,
      },
      plan: {
        id: plan?.id ?? subscription.planId,
        code: plan?.code ?? "",
        displayName: plan?.display_name ?? "",
      },
      seats: {
        used: seats.currentCount,
        cap: seats.cap,
      },
    };
  });
}
