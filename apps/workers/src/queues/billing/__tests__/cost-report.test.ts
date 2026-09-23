/**
 * Cost & budget reporting sweep (ST-293) — pure-logic and fake-injected unit tests.
 *
 * `evaluateBudgetBreach` is the piece of "budget breach alerts fire in test" this module can prove
 * without a live CloudWatch alarm: the alarm itself (alerts.tf's `AiSpendBudgetHigh`) fires from the
 * same `AiEstimatedSpendUsd` metric `publishCostMetrics` sends, so this file proves the sweep would
 * report a breach for the same numbers the alarm's threshold would trip on. `computeAiCostTotals`'s
 * real-database path (per-school RLS-scoped transactions) is not covered here — mirroring
 * apps/api/src/modules/ai/routes/metrics-routes.test.ts's own fake-database approach for the
 * equivalent admin-metrics endpoint, not a new gap this ticket introduces.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  computeAiRevenueUsd,
  computeStripeFeesUsd,
  estimateAiCostUsd,
  evaluateBudgetBreach,
  publishCostMetrics,
} from "../cost-report";

import type { WorkerLogger } from "../../../log";

const silentLogger: WorkerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("evaluateBudgetBreach", () => {
  test("fires (breached: true) when spend exceeds the budget", () => {
    const verdict = evaluateBudgetBreach(650, 500);

    expect(verdict.breached).toBe(true);
    expect(verdict.overageUsd).toBe(150);
    expect(verdict.spendUsd).toBe(650);
    expect(verdict.budgetUsd).toBe(500);
  });

  test("does not fire when spend is within budget", () => {
    const verdict = evaluateBudgetBreach(300, 500);

    expect(verdict.breached).toBe(false);
    expect(verdict.overageUsd).toBe(0);
  });

  test("does not fire when spend exactly equals the budget (strictly greater-than)", () => {
    const verdict = evaluateBudgetBreach(500, 500);

    expect(verdict.breached).toBe(false);
    expect(verdict.overageUsd).toBe(0);
  });

  test("rounds overageUsd to the cent", () => {
    const verdict = evaluateBudgetBreach(100.006, 100);

    expect(verdict.breached).toBe(true);
    expect(verdict.overageUsd).toBe(0.01);
  });
});

describe("estimateAiCostUsd", () => {
  test("large-tier tokens cost more per token than small-tier tokens", () => {
    const smallOnly = estimateAiCostUsd(1_000_000, 0);
    const largeOnly = estimateAiCostUsd(0, 1_000_000);

    expect(largeOnly).toBeGreaterThan(smallOnly);
  });

  test("zero tokens cost nothing", () => {
    expect(estimateAiCostUsd(0, 0)).toBe(0);
  });

  test("is additive across tiers", () => {
    const combined = estimateAiCostUsd(500_000, 500_000);
    const small = estimateAiCostUsd(500_000, 0);
    const large = estimateAiCostUsd(0, 500_000);

    expect(combined).toBeCloseTo(small + large, 2);
  });
});

describe("computeAiRevenueUsd", () => {
  test("is students times the $12/student/month add-on price", () => {
    expect(computeAiRevenueUsd(50)).toBe(600);
  });

  test("zero students yields zero revenue", () => {
    expect(computeAiRevenueUsd(0)).toBe(0);
  });
});

describe("publishCostMetrics", () => {
  test("publishes both metrics under the given namespace when Stripe fees are known", async () => {
    const sent: unknown[] = [];
    const fakeCloudWatch = { send: async (command: unknown) => sent.push(command) };
    const now = new Date("2026-09-01T06:15:00.000Z");

    await publishCostMetrics(
      fakeCloudWatch as never,
      "Studafy/Cost",
      { aiEstimatedSpendUsd: 123.45, stripeFeesUsd: 67.89 },
      now,
    );

    expect(sent).toHaveLength(1);
    const input = (sent[0] as { input: { Namespace: string; MetricData: unknown[] } }).input;
    expect(input.Namespace).toBe("Studafy/Cost");
    expect(input.MetricData).toHaveLength(2);
    expect(input.MetricData).toContainEqual(
      expect.objectContaining({ MetricName: "AiEstimatedSpendUsd", Value: 123.45 }),
    );
    expect(input.MetricData).toContainEqual(
      expect.objectContaining({ MetricName: "StripeFeesUsd", Value: 67.89 }),
    );
  });

  test("omits StripeFeesUsd when Stripe fees are unknown (null)", async () => {
    const sent: unknown[] = [];
    const fakeCloudWatch = { send: async (command: unknown) => sent.push(command) };

    await publishCostMetrics(
      fakeCloudWatch as never,
      "Studafy/Cost",
      { aiEstimatedSpendUsd: 10, stripeFeesUsd: null },
      new Date("2026-09-01T06:15:00.000Z"),
    );

    const input = (sent[0] as { input: { MetricData: { MetricName: string }[] } }).input;
    expect(input.MetricData).toHaveLength(1);
    expect(input.MetricData[0]!.MetricName).toBe("AiEstimatedSpendUsd");
  });
});

describe("computeStripeFeesUsd", () => {
  function fakeStripe(transactions: { currency: string; fee: number }[]) {
    return {
      balanceTransactions: {
        list: () => ({
          async *[Symbol.asyncIterator]() {
            for (const txn of transactions) yield txn;
          },
        }),
      },
    };
  }

  test("sums fee (minor units) across USD transactions, converted to dollars", async () => {
    const stripe = fakeStripe([
      { currency: "usd", fee: 320 },
      { currency: "usd", fee: 180 },
    ]);

    const feesUsd = await computeStripeFeesUsd(
      stripe as never,
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-09-02T00:00:00.000Z"),
      silentLogger,
    );

    expect(feesUsd).toBe(5); // (320 + 180) / 100
  });

  test("skips non-USD transactions and logs a warning rather than mixing currencies", async () => {
    const warnings: unknown[] = [];
    const logger: WorkerLogger = {
      ...silentLogger,
      warn: (fields) => warnings.push(fields),
    };
    const stripe = fakeStripe([
      { currency: "usd", fee: 100 },
      { currency: "eur", fee: 9999 },
    ]);

    const feesUsd = await computeStripeFeesUsd(
      stripe as never,
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-09-02T00:00:00.000Z"),
      logger,
    );

    expect(feesUsd).toBe(1); // only the USD transaction counts
    expect(warnings).toHaveLength(1);
  });

  test("returns 0 when there are no transactions in the window", async () => {
    const stripe = fakeStripe([]);

    const feesUsd = await computeStripeFeesUsd(
      stripe as never,
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-09-02T00:00:00.000Z"),
      silentLogger,
    );

    expect(feesUsd).toBe(0);
  });
});
