import { OpenAPIHono } from "@hono/zod-openapi";
import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { AUTH_CHANNELS } from "../../auth/channels";

import { aiMetricsRoutes } from "./metrics-routes";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000003";

const silentLogger: Logger = {
  level: "info",
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

function authWithRoles(roles: readonly string[]): AuthContext {
  return {
    userId: USER_ID,
    schoolId: SCHOOL_ID,
    roles: roles as AuthContext["roles"],
    channel: AUTH_CHANNELS.API,
    jti: "jti-1",
    entitlementsVer: 1,
    subscriptionStatus: "active",
  };
}

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

/**
 * Fake database that captures the query and returns configurable rows.
 *
 * `withSystemTx` calls `database.begin(fn)` where `fn` receives a TransactionSql. The fake tx
 * handles both the `SET LOCAL ROLE studafy_admin` call (`tx.unsafe()`) and the tagged-template
 * query that returns tenant rows.
 */
function fakeDatabase(rows: TenantRow[]) {
  const queries: string[] = [];

  const tx = Object.assign(
    // Tagged template query: tx`SELECT ...` — postgres.js returns the array itself with rows
    // attached. The tagged template receives an array of strings and returns a promise of rows.
    (() => {
      queries.push("query");
      return Promise.resolve(rows);
    }) as unknown as Database,
    {
      unsafe: async (sql: string) => {
        queries.push(sql);
        return [];
      },
    },
  );

  const database = Object.assign((() => undefined) as unknown as Database, {
    begin: async (fn: (t: unknown) => Promise<unknown>) => {
      await fn(tx);
    },
  });

  return { database, queries };
}

function buildMetricsApp(authCtx: AuthContext, database: Database): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", authCtx);
    c.set("locale", "en");
    await next();
  });
  app.route("/", aiMetricsRoutes({ database }));
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

const SCHOOL_A = "00000000-0000-4000-8000-000000000010";
const SCHOOL_B = "00000000-0000-4000-8000-000000000020";

const ROWS: TenantRow[] = [
  {
    school_id: SCHOOL_B,
    school_name: "Beta School",
    subscribed_students: 30,
    total_tokens: "1200000",
    small_tokens: "480000",
    large_tokens: "720000",
    period_start: new Date("2026-08-05T00:00:00.000Z"),
    period_end: new Date("2026-09-04T23:59:59.000Z"),
  },
  {
    school_id: SCHOOL_A,
    school_name: "Alpha Academy",
    subscribed_students: 50,
    total_tokens: "500000",
    small_tokens: "200000",
    large_tokens: "300000",
    period_start: new Date("2026-08-01T00:00:00.000Z"),
    period_end: new Date("2026-08-31T23:59:59.000Z"),
  },
];

describe("GET /api/ai/admin/metrics", () => {
  test("returns per-tenant metrics for SUPER_ADMIN", async () => {
    const { database } = fakeDatabase(ROWS);
    const app = buildMetricsApp(authWithRoles([ROLES.SUPER_ADMIN]), database);

    const res = await app.request("/api/ai/admin/metrics");
    const body = (await res.json()) as {
      periodStart: string;
      periodEnd: string;
      tenants: {
        schoolId: string;
        schoolName: string;
        subscribedStudents: number;
        totalTokens: number;
        smallTokens: number;
        largeTokens: number;
        estimatedCostUsd: number;
        revenueUsd: number;
        marginPercent: number | null;
        negativeMargin: boolean;
        budgetTokens: number;
        utilizationPercent: number;
      }[];
      summary: {
        totalTenants: number;
        totalSubscribedStudents: number;
        totalTokens: number;
        totalEstimatedCostUsd: number;
        totalRevenueUsd: number;
        negativeMarginTenantCount: number;
      };
    };

    expect(res.status).toBe(200);

    // Two tenants returned, ordered by total tokens descending.
    expect(body.tenants).toHaveLength(2);
    expect(body.tenants[0]!.schoolId).toBe(SCHOOL_B);
    expect(body.tenants[0]!.schoolName).toBe("Beta School");
    expect(body.tenants[0]!.subscribedStudents).toBe(30);
    expect(body.tenants[0]!.totalTokens).toBe(1_200_000);
    expect(body.tenants[0]!.smallTokens).toBe(480_000);
    expect(body.tenants[0]!.largeTokens).toBe(720_000);
    expect(body.tenants[0]!.budgetTokens).toBe(30_000_000);
    expect(body.tenants[0]!.estimatedCostUsd).toBeGreaterThan(0);
    expect(body.tenants[0]!.revenueUsd).toBe(360); // 30 × $12
    expect(body.tenants[0]!.marginPercent).toBeTypeOf("number");
    expect(typeof body.tenants[0]!.negativeMargin).toBe("boolean");

    expect(body.tenants[1]!.schoolId).toBe(SCHOOL_A);
    expect(body.tenants[1]!.schoolName).toBe("Alpha Academy");
    expect(body.tenants[1]!.subscribedStudents).toBe(50);
    expect(body.tenants[1]!.totalTokens).toBe(500_000);
    expect(body.tenants[1]!.smallTokens).toBe(200_000);
    expect(body.tenants[1]!.largeTokens).toBe(300_000);
    expect(body.tenants[1]!.revenueUsd).toBe(600); // 50 × $12

    // Summary aggregates.
    expect(body.summary.totalTenants).toBe(2);
    expect(body.summary.totalSubscribedStudents).toBe(80);
    expect(body.summary.totalTokens).toBe(1_700_000);
    expect(body.summary.totalEstimatedCostUsd).toBeGreaterThan(0);
    expect(body.summary.totalRevenueUsd).toBe(960); // 360 + 600
    expect(typeof body.summary.negativeMarginTenantCount).toBe("number");

    // Period bounds from first row's start to last row's end.
    expect(body.periodStart).toBe("2026-08-05T00:00:00.000Z");
    expect(body.periodEnd).toBe("2026-08-31T23:59:59.000Z");
  });

  test("returns empty state when no tenants have active subscriptions", async () => {
    const { database } = fakeDatabase([]);
    const app = buildMetricsApp(authWithRoles([ROLES.SUPER_ADMIN]), database);

    const res = await app.request("/api/ai/admin/metrics");
    const body = (await res.json()) as {
      tenants: unknown[];
      summary: {
        totalTenants: number;
        totalTokens: number;
        totalRevenueUsd: number;
        negativeMarginTenantCount: number;
      };
    };

    expect(res.status).toBe(200);
    expect(body.tenants).toHaveLength(0);
    expect(body.summary.totalTenants).toBe(0);
    expect(body.summary.totalTokens).toBe(0);
    expect(body.summary.negativeMarginTenantCount).toBe(0);
  });

  test("rejects non-SUPER_ADMIN with 403", async () => {
    const { database } = fakeDatabase(ROWS);
    const app = buildMetricsApp(authWithRoles([ROLES.ORG_ADMIN]), database);

    const res = await app.request("/api/ai/admin/metrics");

    expect(res.status).toBe(403);
  });

  test("rejects STUDENT role with 403", async () => {
    const { database } = fakeDatabase(ROWS);
    const app = buildMetricsApp(authWithRoles([ROLES.STUDENT]), database);

    const res = await app.request("/api/ai/admin/metrics");

    expect(res.status).toBe(403);
  });

  test("utilization percent is computed from tokens vs budget", async () => {
    const singleRow: TenantRow[] = [
      {
        school_id: SCHOOL_A,
        school_name: "Alpha Academy",
        subscribed_students: 10,
        total_tokens: "250000",
        small_tokens: "100000",
        large_tokens: "150000",
        period_start: new Date("2026-08-01T00:00:00.000Z"),
        period_end: new Date("2026-08-31T23:59:59.000Z"),
      },
    ];
    const { database } = fakeDatabase(singleRow);
    const app = buildMetricsApp(authWithRoles([ROLES.SUPER_ADMIN]), database);

    const res = await app.request("/api/ai/admin/metrics");
    const body = (await res.json()) as {
      tenants: {
        utilizationPercent: number;
        budgetTokens: number;
        totalTokens: number;
        smallTokens: number;
        largeTokens: number;
      }[];
      summary: { totalTenants: number; totalTokens: number };
    };

    expect(res.status).toBe(200);
    const tenant = body.tenants[0]!;
    // 10 students × 1,000,000 budget = 10,000,000 total budget.
    expect(tenant.budgetTokens).toBe(10_000_000);
    expect(tenant.totalTokens).toBe(250_000);
    expect(tenant.smallTokens).toBe(100_000);
    expect(tenant.largeTokens).toBe(150_000);
    // 250,000 / 10,000,000 = 2.5%
    expect(tenant.utilizationPercent).toBe(2.5);
  });

  test("flags negative-margin tenants when cost exceeds revenue", async () => {
    // 1 student, high token usage → cost > $12 revenue
    const highUsageRow: TenantRow[] = [
      {
        school_id: SCHOOL_A,
        school_name: "Alpha Academy",
        subscribed_students: 1,
        total_tokens: "5000000",
        small_tokens: "2000000",
        large_tokens: "3000000",
        period_start: new Date("2026-08-01T00:00:00.000Z"),
        period_end: new Date("2026-08-31T23:59:59.000Z"),
      },
    ];
    const { database } = fakeDatabase(highUsageRow);
    const app = buildMetricsApp(authWithRoles([ROLES.SUPER_ADMIN]), database);

    const res = await app.request("/api/ai/admin/metrics");
    const body = (await res.json()) as {
      tenants: {
        negativeMargin: boolean;
        marginPercent: number | null;
        revenueUsd: number;
        estimatedCostUsd: number;
      }[];
      summary: { negativeMarginTenantCount: number };
    };

    expect(res.status).toBe(200);
    const tenant = body.tenants[0]!;
    // Revenue: 1 × $12 = $12. Cost at 5M tokens is well above $12.
    expect(tenant.revenueUsd).toBe(12);
    expect(tenant.estimatedCostUsd).toBeGreaterThan(tenant.revenueUsd);
    expect(tenant.negativeMargin).toBe(true);
    expect(tenant.marginPercent).not.toBeNull();
    expect(tenant.marginPercent!).toBeLessThan(0);
    expect(body.summary.negativeMarginTenantCount).toBe(1);
  });

  test("margin is positive when cost is below revenue", async () => {
    // 50 students, low usage → cost < $600 revenue
    const lowUsageRow: TenantRow[] = [
      {
        school_id: SCHOOL_A,
        school_name: "Alpha Academy",
        subscribed_students: 50,
        total_tokens: "50000",
        small_tokens: "20000",
        large_tokens: "30000",
        period_start: new Date("2026-08-01T00:00:00.000Z"),
        period_end: new Date("2026-08-31T23:59:59.000Z"),
      },
    ];
    const { database } = fakeDatabase(lowUsageRow);
    const app = buildMetricsApp(authWithRoles([ROLES.SUPER_ADMIN]), database);

    const res = await app.request("/api/ai/admin/metrics");
    const body = (await res.json()) as {
      tenants: {
        negativeMargin: boolean;
        marginPercent: number | null;
        revenueUsd: number;
        estimatedCostUsd: number;
      }[];
    };

    expect(res.status).toBe(200);
    const tenant = body.tenants[0]!;
    expect(tenant.revenueUsd).toBe(600); // 50 × $12
    expect(tenant.estimatedCostUsd).toBeLessThan(tenant.revenueUsd);
    expect(tenant.negativeMargin).toBe(false);
    expect(tenant.marginPercent).not.toBeNull();
    expect(tenant.marginPercent!).toBeGreaterThan(0);
  });
});
