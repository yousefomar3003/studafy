/**
 * Cost & budget reporting sweep (ST-293).
 *
 * Two things this repo had no automated answer for: "what is the platform actually spending on AI
 * inference this month, in aggregate" and "did Stripe's own cut of revenue move". Per-tenant AI
 * cost attribution already exists (`GET /api/ai/admin/metrics`, ST-155,
 * apps/api/src/modules/ai/routes/metrics-routes.ts) — that endpoint is the source of truth for "which
 * school", and this sweep does not recompute it per tenant. What it adds is the *platform-wide*
 * total, published as a CloudWatch metric the budget alarms in
 * infra/terraform/modules/monitoring/alerts.tf watch (`AiEstimatedSpendUsd`), plus Stripe's own
 * processing fees (`StripeFeesUsd`) — a cost line nothing else in this codebase tracks.
 *
 * Deliberately NOT per-school-dimensioned on CloudWatch: this module's own README has a "cardinality
 * budget" section that is explicit about never labelling a metric by school id, and a monitoring
 * metric is exactly the wrong place to duplicate the per-tenant attribution the admin-metrics
 * endpoint already owns.
 *
 * ## Why a per-school loop, not one cross-tenant query
 *
 * `app.ai_subscriptions`/`app.ai_usage_meters` are RLS-FORCEd on `app.school_id`, and
 * `studafy_admin` is NOBYPASSRLS (db/migrations/000002, .../000006) — so a `SET LOCAL ROLE
 * studafy_admin` alone does not see every school's rows, only whichever school's GUC is armed. This
 * sweep totals by looping every school through `withSystemTenantTx` (one transaction per school,
 * GUC armed, `studafy_admin` inside it) and summing in application code — the exact shape
 * `runSeatReconciliation` already uses for its own daily per-school sweep. `app.schools` itself is
 * global and unscoped (`loadSchoolIds`), which is how the loop gets its list of schools to visit.
 *
 * ## Two pricing constants, one intentional duplication
 *
 * `PRICE_PER_M_TOKENS`/`estimateAiCostUsd`/`computeAiRevenueUsd` below mirror
 * apps/api/src/modules/ai/usage/costs.ts's `estimateCostByTier`/`computeAiRevenue` exactly (same
 * $/M-token rates, same 70/30 input/output blend, same $12/student/month add-on price). apps/api and
 * apps/workers are separate deployables with no shared pricing package yet, so this is a deliberate,
 * documented copy rather than a silent divergence — if the provider's pricing or the add-on price
 * changes, both files must be updated together until that pricing math is lifted into a shared
 * package.
 */

import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";

import { withSystemTenantTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import type { WorkerLogger } from "../../log";
import type { Sql } from "postgres";
import type Stripe from "stripe";

/** CloudWatch namespace every cost metric this sweep publishes lands under (Studafy/<component>). */
export const COST_METRIC_NAMESPACE = "Studafy/Cost";

// --- Pricing (mirrors apps/api/src/modules/ai/usage/costs.ts — see header) -----------------------

const INPUT_RATIO = 0.7;
const OUTPUT_RATIO = 1 - INPUT_RATIO;

const AI_COST_INPUT_PER_M_SMALL = 0.8;
const AI_COST_OUTPUT_PER_M_SMALL = 4.0;
const AI_COST_INPUT_PER_M_LARGE = 3.0;
const AI_COST_OUTPUT_PER_M_LARGE = 15.0;
const AI_ADDON_PRICE_PER_STUDENT_MONTHLY_USD = 12.0;

const SMALL_TIER_COST_PER_TOKEN =
  (INPUT_RATIO * AI_COST_INPUT_PER_M_SMALL + OUTPUT_RATIO * AI_COST_OUTPUT_PER_M_SMALL) / 1_000_000;
const LARGE_TIER_COST_PER_TOKEN =
  (INPUT_RATIO * AI_COST_INPUT_PER_M_LARGE + OUTPUT_RATIO * AI_COST_OUTPUT_PER_M_LARGE) / 1_000_000;

export function estimateAiCostUsd(smallTokens: number, largeTokens: number): number {
  const cost = smallTokens * SMALL_TIER_COST_PER_TOKEN + largeTokens * LARGE_TIER_COST_PER_TOKEN;
  return Math.round(cost * 100) / 100;
}

export function computeAiRevenueUsd(subscribedStudents: number): number {
  return Math.round(subscribedStudents * AI_ADDON_PRICE_PER_STUDENT_MONTHLY_USD * 100) / 100;
}

// --- Budget verdict --------------------------------------------------------------------------------

export interface BudgetVerdict {
  spendUsd: number;
  budgetUsd: number;
  breached: boolean;
  /** How far over budget, in USD; 0 when not breached. */
  overageUsd: number;
}

/**
 * Pure breach check — no I/O, so it is the piece of "budget breach alerts" this sweep can prove
 * with a unit test. The actual *paging* is the CloudWatch alarm on the metric this sweep publishes
 * (`AiSpendBudgetHigh`, alerts.tf); this function is what decides the monthly report's own verdict
 * line, evaluated against the same budget the alarm's threshold should be set to.
 */
export function evaluateBudgetBreach(spendUsd: number, budgetUsd: number): BudgetVerdict {
  const overageUsd = Math.round((spendUsd - budgetUsd) * 100) / 100;
  return {
    spendUsd,
    budgetUsd,
    breached: spendUsd > budgetUsd,
    overageUsd: Math.max(0, overageUsd),
  };
}

// --- AI cost totals (platform-wide, not per-tenant) -----------------------------------------------

export interface AiCostTotals {
  schoolsWithActiveAiSubscriptions: number;
  subscribedStudents: number;
  totalTokens: number;
  smallTokens: number;
  largeTokens: number;
  estimatedCostUsd: number;
  revenueUsd: number;
  marginPercent: number | null;
}

interface SchoolAiTotalsRow {
  subscribed_students: number;
  total_tokens: string;
  small_tokens: string;
  large_tokens: string;
}

/**
 * Sums active AI subscriptions across every school. One transaction per school
 * (`withSystemTenantTx`) — see this file's header for why a single cross-tenant query cannot do
 * this under RLS. Cheap enough to run daily: this is a handful of small aggregate queries per
 * school, not a per-row scan, and the sweep this feeds already runs once a day.
 */
export async function computeAiCostTotals(sql: Sql, now: Date): Promise<AiCostTotals> {
  const schoolIds = await loadSchoolIds(sql);

  let schoolsWithActiveAiSubscriptions = 0;
  let subscribedStudents = 0;
  let totalTokens = 0;
  let smallTokens = 0;
  let largeTokens = 0;

  for (const schoolId of schoolIds) {
    const [row] = await withSystemTenantTx(
      sql,
      { schoolId },
      (tx) =>
        tx<SchoolAiTotalsRow[]>`
        SELECT
          COUNT(*)::int AS subscribed_students,
          COALESCE(SUM(m.total_tokens), 0)::text AS total_tokens,
          COALESCE(SUM(m.small_tokens), 0)::text AS small_tokens,
          COALESCE(SUM(m.large_tokens), 0)::text AS large_tokens
        FROM app.ai_subscriptions ai
        LEFT JOIN app.ai_usage_meters m
          ON m.school_id = ai.school_id
         AND m.student_id = ai.student_id
         AND m.ai_subscription_id = ai.id
        WHERE ai.school_id = ${schoolId}::uuid
          AND ai.status = 'active'
          AND ai.current_period_end > ${now}
      `,
    );

    if (!row || row.subscribed_students === 0) continue;

    schoolsWithActiveAiSubscriptions += 1;
    subscribedStudents += row.subscribed_students;
    totalTokens += Number(row.total_tokens);
    smallTokens += Number(row.small_tokens);
    largeTokens += Number(row.large_tokens);
  }

  const estimatedCostUsd = estimateAiCostUsd(smallTokens, largeTokens);
  const revenueUsd = computeAiRevenueUsd(subscribedStudents);
  const marginPercent =
    revenueUsd > 0
      ? Math.round(((revenueUsd - estimatedCostUsd) / revenueUsd) * 10_000) / 100
      : null;

  return {
    schoolsWithActiveAiSubscriptions,
    subscribedStudents,
    totalTokens,
    smallTokens,
    largeTokens,
    estimatedCostUsd,
    revenueUsd,
    marginPercent,
  };
}

// --- Stripe processing fees -------------------------------------------------------------------------

/**
 * Sums Stripe's own `fee` field (its cut, in minor units) across every balance transaction created
 * in `[since, until)`. Non-USD transactions are counted separately and logged rather than summed in
 * — this platform's Stripe accounts bill in USD today (see docs/runbooks/deliverability.md's sender
 * conventions for the same USD-only assumption elsewhere), and silently mixing currencies into one
 * total would misreport the number rather than merely omit a rare case.
 */
export async function computeStripeFeesUsd(
  stripe: Stripe,
  since: Date,
  until: Date,
  log: WorkerLogger,
): Promise<number> {
  let feesMinorUnits = 0;
  let skippedNonUsd = 0;

  for await (const txn of stripe.balanceTransactions.list({
    created: { gte: Math.floor(since.getTime() / 1000), lt: Math.floor(until.getTime() / 1000) },
    limit: 100,
  })) {
    if (txn.currency !== "usd") {
      skippedNonUsd += 1;
      continue;
    }
    feesMinorUnits += txn.fee;
  }

  if (skippedNonUsd > 0) {
    log.warn(
      { skippedNonUsd, since: since.toISOString(), until: until.toISOString() },
      "cost-report: skipped non-USD Stripe balance transactions when summing fees",
    );
  }

  return Math.round(feesMinorUnits) / 100;
}

// --- CloudWatch publishing ---------------------------------------------------------------------------

export interface CostMetrics {
  aiEstimatedSpendUsd: number;
  /** Null when the Stripe portion was skipped (no STRIPE_SECRET_KEY) — nothing is published for it. */
  stripeFeesUsd: number | null;
}

export async function publishCostMetrics(
  cloudwatch: CloudWatchClient,
  namespace: string,
  metrics: CostMetrics,
  now: Date,
): Promise<void> {
  const metricData = [
    { MetricName: "AiEstimatedSpendUsd", Value: metrics.aiEstimatedSpendUsd },
    ...(metrics.stripeFeesUsd === null
      ? []
      : [{ MetricName: "StripeFeesUsd", Value: metrics.stripeFeesUsd }]),
  ].map((entry) => ({ ...entry, Unit: "None" as const, Timestamp: now }));

  await cloudwatch.send(new PutMetricDataCommand({ Namespace: namespace, MetricData: metricData }));
}

// --- Orchestration -----------------------------------------------------------------------------------

export interface CostReportDeps {
  sql: Sql;
  cloudwatch: CloudWatchClient;
  /** Undefined when STRIPE_SECRET_KEY is not configured — the Stripe portion is skipped, not faked. */
  stripe?: Stripe;
  log: WorkerLogger;
  /** Advisory budget for the monthly report's verdict line; the alarm's own threshold is separate
   *  Terraform state (alerts.tf's `ai_monthly_spend_budget_usd`) and must be kept in sync by hand. */
  monthlyBudgetUsd?: number;
  metricNamespace?: string;
}

export interface CostReportResult {
  mode: "daily" | "monthly";
  ai: AiCostTotals;
  stripeFeesUsd: number | null;
  budgetVerdict: BudgetVerdict | null;
}

function monthToDateWindow(now: Date): { since: Date; until: Date } {
  return { since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), until: now };
}

function previousMonthWindow(now: Date): { since: Date; until: Date } {
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const since = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth() - 1, 1));
  return { since, until };
}

/**
 * `mode: "daily"` publishes CloudWatch metrics only, cheaply, so the budget alarms stay current
 * intraday. `mode: "monthly"` additionally logs the previous calendar month's full structured
 * report — the "monthly report automated" acceptance criterion — read by the `<prefix>-cost`
 * CloudWatch dashboard's Logs Insights widget
 * (infra/terraform/modules/monitoring/cost.tf), the same "queryable log line, not an email"
 * pattern ST-255's deploy annotations already established.
 */
export async function runCostReport(
  deps: CostReportDeps,
  mode: "daily" | "monthly",
  now: Date,
): Promise<CostReportResult> {
  const { sql, cloudwatch, stripe, log } = deps;
  const namespace = deps.metricNamespace ?? COST_METRIC_NAMESPACE;
  const window = mode === "monthly" ? previousMonthWindow(now) : monthToDateWindow(now);

  const ai = await computeAiCostTotals(sql, now);

  let stripeFeesUsd: number | null = null;
  if (stripe) {
    stripeFeesUsd = await computeStripeFeesUsd(stripe, window.since, window.until, log);
  } else {
    log.warn({ mode }, "cost-report: STRIPE_SECRET_KEY not set, skipping Stripe fee reporting");
  }

  await publishCostMetrics(
    cloudwatch,
    namespace,
    { aiEstimatedSpendUsd: ai.estimatedCostUsd, stripeFeesUsd },
    now,
  );

  const budgetVerdict =
    deps.monthlyBudgetUsd === undefined
      ? null
      : evaluateBudgetBreach(ai.estimatedCostUsd, deps.monthlyBudgetUsd);

  const logFields = {
    mode,
    windowStart: window.since.toISOString(),
    windowEnd: window.until.toISOString(),
    schoolsWithActiveAiSubscriptions: ai.schoolsWithActiveAiSubscriptions,
    subscribedStudents: ai.subscribedStudents,
    totalTokens: ai.totalTokens,
    aiEstimatedCostUsd: ai.estimatedCostUsd,
    aiRevenueUsd: ai.revenueUsd,
    aiMarginPercent: ai.marginPercent,
    stripeFeesUsd,
    budgetBreached: budgetVerdict?.breached ?? null,
    budgetOverageUsd: budgetVerdict?.overageUsd ?? null,
  };

  if (mode === "monthly") {
    log.info(logFields, "cost-report: monthly cost report");
  } else {
    log.info(logFields, "cost-report: daily cost metrics published");
  }

  return { mode, ai, stripeFeesUsd, budgetVerdict };
}
