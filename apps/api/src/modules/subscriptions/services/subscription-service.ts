import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";

import type { TransactionSql } from "postgres";

export interface SchoolSubscription {
  id: string;
  schoolId: string;
  planId: string;
  status: string;
  studentCap: number;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  stripeSubscriptionId: string | null;
  stripeSubscriptionItemId: string | null;
}

export interface PlanWithPrices {
  id: string;
  code: string;
  displayName: string;
  description: string | null;
  prices: {
    id: string;
    currencyCode: string;
    billingInterval: string;
    amountMinor: number;
    stripePriceId: string | null;
  }[];
}

export async function getSchoolSubscription(
  tx: TransactionSql,
  schoolId: string,
): Promise<SchoolSubscription | null> {
  const rows = await tx<SchoolSubscription[]>`
    SELECT
      s.id,
      s.school_id AS "schoolId",
      s.plan_id AS "planId",
      s.status::text AS status,
      s.student_cap AS "studentCap",
      s.current_period_start AS "currentPeriodStart",
      s.current_period_end AS "currentPeriodEnd",
      s.stripe_subscription_id AS "stripeSubscriptionId",
      s.stripe_subscription_item_id AS "stripeSubscriptionItemId"
    FROM app.subscriptions s
    WHERE s.school_id = ${schoolId}::uuid
    LIMIT 1
  `;
  return rows.length > 0 ? rows[0] : null;
}

export async function requireSchoolSubscription(
  tx: TransactionSql,
  schoolId: string,
): Promise<SchoolSubscription> {
  const sub = await getSchoolSubscription(tx, schoolId);
  if (!sub) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.SUBSCRIPTION_NOT_FOUND,
      "School has no subscription",
    );
  }
  return sub;
}

// transitionSubscriptionStatus and updateSubscriptionPeriod lived here until ST-132. The first took
// a `currentStatus` argument and never read it -- it applied whatever status it was handed, which is
// precisely the unguarded transition this module now refuses to perform. Both were only ever called
// by the old webhook handler; the status change, the period write and the audit row are now one
// statement in stripe/webhook-processor.ts, guarded by the state machine, so leaving these behind
// would leave a second, unguarded way to move a subscription.

export async function getActivePlans(database: import("postgres").Sql): Promise<PlanWithPrices[]> {
  const plans = await database<
    {
      id: string;
      code: string;
      display_name: string;
      description: string | null;
    }[]
  >`
    SELECT id, code, display_name, description
    FROM app.plans
    WHERE is_active = true
    ORDER BY code
  `;

  const result: PlanWithPrices[] = [];

  for (const plan of plans) {
    const prices = await database<
      {
        id: string;
        currency_code: string;
        billing_interval: string;
        amount_minor: number;
        stripe_price_id: string | null;
      }[]
    >`
      SELECT
        pp.id,
        c.code AS currency_code,
        pp.billing_interval::text AS billing_interval,
        pp.amount_minor,
        pp.stripe_price_id
      FROM app.plan_prices pp
      JOIN app.currencies c ON c.id = pp.currency_id
      WHERE pp.plan_id = ${plan.id}::uuid AND pp.is_active = true
      ORDER BY pp.billing_interval, c.code
    `;

    result.push({
      id: plan.id,
      code: plan.code,
      displayName: plan.display_name,
      description: plan.description,
      prices: prices.map((p) => ({
        id: p.id,
        currencyCode: p.currency_code,
        billingInterval: p.billing_interval,
        amountMinor: Number(p.amount_minor),
        stripePriceId: p.stripe_price_id,
      })),
    });
  }

  return result;
}
