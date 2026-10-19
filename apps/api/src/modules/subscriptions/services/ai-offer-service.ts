import { LIVE_STATUSES } from "@studafy/billing";

import { withTenantTx } from "../../../db/tenant-tx";

import type { Database } from "../../../db";
import type { TenantContext } from "../../../db/tenant-tx";
import type { SubscriptionStatus } from "@studafy/constants";

/** The catalog plan the AI add-on is sold as (migration 000127). */
export const AI_ADDON_PLAN_CODE = "ai_addon";

export interface AiOfferPrice {
  id: string;
  amountMinor: number;
  currency: string;
  interval: "monthly" | "yearly";
}

export interface AiOfferStudent {
  id: string;
  name: string;
  /** Whether this student's AI add-on is live already (bought on the web or in the app). */
  active: boolean;
}

export interface AiOffer {
  /** The add-on's current price; null until one is set in the catalog. */
  price: AiOfferPrice | null;
  /** Whom the caller may buy it for: themselves as a student, and the children they are linked to. */
  students: AiOfferStudent[];
}

/**
 * What the signed-in user can buy on the website: the AI add-on's price and the students it can be
 * bought for. The same students `createAiCheckoutSession` accepts, so the page never offers a
 * purchase the checkout would refuse.
 */
export async function getAiOffer(
  database: Database,
  context: TenantContext & { userId: string },
): Promise<AiOffer> {
  return withTenantTx(database, context, async (tx) => {
    const [price] = await tx<
      { id: string; amount_minor: string; currency: string; billing_interval: string }[]
    >`
      SELECT pp.id, pp.amount_minor::text AS amount_minor, cur.code AS currency,
             pp.billing_interval::text AS billing_interval
      FROM app.plan_prices pp
      JOIN app.plans p ON p.id = pp.plan_id
      JOIN app.currencies cur ON cur.id = pp.currency_id
      WHERE p.code = ${AI_ADDON_PLAN_CODE} AND p.is_active AND pp.is_active
      ORDER BY (pp.billing_interval = 'monthly') DESC, pp.created_at DESC
      LIMIT 1
    `;

    const students = await tx<
      {
        id: string;
        first_name: string;
        last_name: string;
        preferred_name: string | null;
        ai_status: string | null;
      }[]
    >`
      SELECT s.id, s.first_name, s.last_name, s.preferred_name, ai.status::text AS ai_status
      FROM app.students s
      LEFT JOIN app.ai_subscriptions ai ON ai.school_id = s.school_id AND ai.student_id = s.id
      WHERE s.school_id = ${context.schoolId}::uuid
        AND s.status = 'enrolled'
        AND (
          s.user_id = ${context.userId}::uuid
          OR EXISTS (
            SELECT 1 FROM app.parent_child_links l
            WHERE l.school_id = s.school_id
              AND l.student_id = s.id
              AND l.parent_user_id = ${context.userId}::uuid
          )
        )
      ORDER BY s.first_name, s.last_name
    `;

    return {
      price: price
        ? {
            id: price.id,
            amountMinor: Number(price.amount_minor),
            currency: price.currency,
            interval: price.billing_interval === "yearly" ? "yearly" : "monthly",
          }
        : null,
      students: students.map((s) => ({
        id: s.id,
        name: s.preferred_name?.trim() || `${s.first_name} ${s.last_name}`,
        active: s.ai_status !== null && LIVE_STATUSES.has(s.ai_status as SubscriptionStatus),
      })),
    };
  });
}
