// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  BLENDED_COST_PER_TOKEN,
  computeAiRevenue,
  computeMarginPercent,
  DEFAULT_MONTHLY_BUDGET,
  estimateCostByTier,
  estimateCostUsd,
} from "./costs";

describe("usage/costs", () => {
  describe("estimateCostByTier", () => {
    test("returns zero for zero tokens", () => {
      expect(estimateCostByTier(0, 0)).toBe(0);
    });

    test("small-tier tokens cost less than large-tier for the same count", () => {
      const smallCost = estimateCostByTier(1_000_000, 0);
      const largeCost = estimateCostByTier(0, 1_000_000);
      expect(smallCost).toBeLessThan(largeCost);
    });

    test("mixed tier cost is between pure small and pure large", () => {
      const pureSmall = estimateCostByTier(2_000_000, 0);
      const pureLarge = estimateCostByTier(0, 2_000_000);
      const mixed = estimateCostByTier(1_000_000, 1_000_000);
      expect(mixed).toBeGreaterThan(pureSmall);
      expect(mixed).toBeLessThan(pureLarge);
    });

    test("cost is rounded to cents", () => {
      // 100 small tokens: (0.7 * 0.8 + 0.3 * 4.0) / 1M * 100 = ~0.000136 → rounded to 0
      const cost = estimateCostByTier(100, 0);
      expect(cost).toBe(Math.round(cost * 100) / 100);
    });
  });

  describe("estimateCostUsd (legacy blended rate)", () => {
    test("returns zero for zero tokens", () => {
      expect(estimateCostUsd(0)).toBe(0);
    });

    test("cost scales linearly within rounding tolerance", () => {
      const cost1x = estimateCostUsd(1_000_000);
      const cost2x = estimateCostUsd(2_000_000);
      // Each call rounds to cents independently, so allow 1 cent tolerance.
      expect(Math.abs(cost2x - cost1x * 2)).toBeLessThanOrEqual(0.01);
    });

    test("blended cost per token is between small and large tier costs", () => {
      const smallTierCost = (0.7 * 0.8 + 0.3 * 4.0) / 1_000_000;
      const largeTierCost = (0.7 * 3.0 + 0.3 * 15.0) / 1_000_000;
      expect(BLENDED_COST_PER_TOKEN).toBeGreaterThan(smallTierCost);
      expect(BLENDED_COST_PER_TOKEN).toBeLessThan(largeTierCost);
    });
  });

  describe("computeAiRevenue", () => {
    test("revenue is students × $12/month", () => {
      expect(computeAiRevenue(0)).toBe(0);
      expect(computeAiRevenue(1)).toBe(12);
      expect(computeAiRevenue(10)).toBe(120);
      expect(computeAiRevenue(50)).toBe(600);
    });

    test("revenue is rounded to cents", () => {
      const revenue = computeAiRevenue(3);
      expect(revenue).toBe(36);
      expect(revenue).toBe(Math.round(revenue * 100) / 100);
    });
  });

  describe("computeMarginPercent", () => {
    test("returns null when revenue is zero", () => {
      expect(computeMarginPercent(0, 0)).toBeNull();
      expect(computeMarginPercent(0, 10)).toBeNull();
    });

    test("returns 100% margin when cost is zero", () => {
      expect(computeMarginPercent(100, 0)).toBe(100);
    });

    test("returns negative margin when cost exceeds revenue", () => {
      const margin = computeMarginPercent(100, 150);
      expect(margin).not.toBeNull();
      expect(margin!).toBeLessThan(0);
      expect(margin!).toBe(-50);
    });

    test("returns positive margin when revenue exceeds cost", () => {
      const margin = computeMarginPercent(600, 30);
      expect(margin).not.toBeNull();
      expect(margin!).toBeGreaterThan(0);
      // (600 - 30) / 600 × 100 = 95%
      expect(margin!).toBe(95);
    });

    test("margin is rounded to two decimal places", () => {
      const margin = computeMarginPercent(100, 33);
      expect(margin).toBe(Math.round(margin! * 100) / 100);
    });
  });

  test("DEFAULT_MONTHLY_BUDGET is exported", () => {
    expect(DEFAULT_MONTHLY_BUDGET).toBe(1_000_000);
  });
});
