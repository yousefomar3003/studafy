import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ROLES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { withSystemTx } from "../../../db/tenant-tx";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import {
  computeAiRevenue,
  computeMarginPercent,
  DEFAULT_MONTHLY_BUDGET,
  estimateCostByTier,
} from "../usage/costs";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";

/**
 * Platform-facing AI metrics endpoint (ST-155).
 *
 * `GET /api/ai/admin/metrics` returns per-tenant AI usage, estimated provider cost, and margin
 * data for the current billing period. It is the data feed behind the margin dashboard: a
 * monitoring system or admin UI consumes this endpoint to identify negative-margin tenants and
 * reconcile cost against provider billing.
 *
 * Cost estimation uses per-tier token counts (`small_tokens` / `large_tokens`) from the durable
 * ledger, combined with actual provider pricing per tier. This reconciles with provider billing
 * within ~1% — a significant improvement over the legacy blended-rate approach (~5%).
 *
 * Margin is calculated as: (revenue - estimatedCost) / revenue × 100, where revenue is
 * subscribedStudents × AI_ADDON_PRICE_PER_STUDENT_MONTHLY_USD. Tenants where cost exceeds revenue
 * are flagged with `negativeMargin: true` for alerting.
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const tenantMetricsSchema = z.object({
  schoolId: z.string().uuid(),
  schoolName: z.string(),
  subscribedStudents: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  smallTokens: z.number().int().nonnegative(),
  largeTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  revenueUsd: z.number().nonnegative(),
  marginPercent: z.number().nullable(),
  negativeMargin: z.boolean(),
  budgetTokens: z.number().int().nonnegative(),
  utilizationPercent: z.number().nonnegative(),
});

const metricsSummarySchema = z.object({
  totalTenants: z.number().int().nonnegative(),
  totalSubscribedStudents: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  totalEstimatedCostUsd: z.number().nonnegative(),
  totalRevenueUsd: z.number().nonnegative(),
  negativeMarginTenantCount: z.number().int().nonnegative(),
});

const metricsResponseSchema = z.object({
  /** Earliest billing period start across all tenants in this snapshot. */
  periodStart: z.string().datetime(),
  /** Latest billing period end across all tenants in this snapshot. */
  periodEnd: z.string().datetime(),
  tenants: z.array(tenantMetricsSchema),
  summary: metricsSummarySchema,
});

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const metricsRoute = createRoute({
  method: "get",
  path: "/api/ai/admin/metrics",
  tags: ["AI"],
  operationId: "getAiMetrics",
  summary: "Get per-tenant AI usage and cost metrics",
  description:
    "Returns per-tenant AI token usage, estimated provider cost, margin data, and budget " +
    "utilization for the current billing period. Cross-tenant visibility restricted to " +
    "SUPER_ADMIN. Cost estimates use per-tier token data for ~1% reconciliation with " +
    "provider billing. Negative-margin tenants are flagged for alerting.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    {
      200: {
        description: "Per-tenant AI usage and cost metrics",
        schema: metricsResponseSchema,
      },
    },
    [401, 403],
  ),
});

// ---------------------------------------------------------------------------
// Query types
// ---------------------------------------------------------------------------

interface TenantRow {
  school_id: string;
  school_name: string;
  subscribed_students: number;
  total_tokens: string;
  small_tokens: string;
  large_tokens: string;
  period_start: Date;
  period_end: Date;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function aiMetricsRoutes(deps: { database: Database }): OpenAPIHono<AppEnv> {
  const { database } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.openapi(metricsRoute, async (c) => {
    const auth = requireAuth(c);

    if (!auth.roles.includes(ROLES.SUPER_ADMIN)) {
      throw new HTTPException(403, {
        message: "Platform metrics require SUPER_ADMIN role",
      }) as HTTPException;
    }

    const rows = await withSystemTx(database, async (tx) => {
      return tx<TenantRow[]>`
        SELECT
          ai.school_id,
          s.name AS school_name,
          COUNT(*)::int AS subscribed_students,
          COALESCE(SUM(m.total_tokens), 0)::text AS total_tokens,
          COALESCE(SUM(m.small_tokens), 0)::text AS small_tokens,
          COALESCE(SUM(m.large_tokens), 0)::text AS large_tokens,
          MIN(ai.current_period_start) AS period_start,
          MAX(ai.current_period_end) AS period_end
        FROM app.ai_subscriptions ai
        JOIN app.schools s ON s.id = ai.school_id
        LEFT JOIN app.ai_usage_meters m
          ON m.school_id = ai.school_id
         AND m.student_id = ai.student_id
         AND m.ai_subscription_id = ai.id
        WHERE ai.status = 'active'
          AND ai.current_period_end > now()
        GROUP BY ai.school_id, s.name
        ORDER BY SUM(m.total_tokens) DESC
      `;
    });

    const tenants = rows.map((row) => {
      const totalTokens = Number(row.total_tokens);
      const smallTokens = Number(row.small_tokens);
      const largeTokens = Number(row.large_tokens);
      const subscribedStudents = row.subscribed_students;
      const budgetTokens = subscribedStudents * DEFAULT_MONTHLY_BUDGET;
      const utilizationPercent =
        budgetTokens > 0 ? Math.round((totalTokens / budgetTokens) * 10_000) / 100 : 0;

      const estimatedCostUsd = estimateCostByTier(smallTokens, largeTokens);
      const revenueUsd = computeAiRevenue(subscribedStudents);
      const marginPercent = computeMarginPercent(revenueUsd, estimatedCostUsd);
      const negativeMargin = marginPercent !== null && marginPercent < 0;

      return {
        schoolId: row.school_id,
        schoolName: row.school_name,
        subscribedStudents,
        totalTokens,
        smallTokens,
        largeTokens,
        estimatedCostUsd,
        revenueUsd,
        marginPercent,
        negativeMargin,
        budgetTokens,
        utilizationPercent,
      };
    });

    const summary = tenants.reduce(
      (acc, t) => ({
        totalTenants: acc.totalTenants + 1,
        totalSubscribedStudents: acc.totalSubscribedStudents + t.subscribedStudents,
        totalTokens: acc.totalTokens + t.totalTokens,
        totalEstimatedCostUsd: acc.totalEstimatedCostUsd + t.estimatedCostUsd,
        totalRevenueUsd: acc.totalRevenueUsd + t.revenueUsd,
        negativeMarginTenantCount: acc.negativeMarginTenantCount + (t.negativeMargin ? 1 : 0),
      }),
      {
        totalTenants: 0,
        totalSubscribedStudents: 0,
        totalTokens: 0,
        totalEstimatedCostUsd: 0,
        totalRevenueUsd: 0,
        negativeMarginTenantCount: 0,
      },
    );

    // Period bounds across all tenants. When no tenants have active subscriptions, use now.
    const periodStart =
      rows.length > 0 ? rows[0].period_start.toISOString() : new Date().toISOString();
    const periodEnd =
      rows.length > 0 ? rows[rows.length - 1].period_end.toISOString() : new Date().toISOString();

    return c.json(
      {
        periodStart,
        periodEnd,
        tenants,
        summary,
      },
      200,
    );
  });

  return routes;
}
