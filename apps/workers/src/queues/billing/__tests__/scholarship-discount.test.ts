// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { scholarshipDiscountMinor, type ApprovedScholarship } from "../scholarship-discount";

// JOD has three minor digits: 500.000 JOD tuition, 100.000 JOD transport.
const LINES = [
  { fee_category: "Tuition", amount_minor: 500_000n },
  { fee_category: "Transport", amount_minor: 100_000n },
];

function percentage(value: string, fee_category: string | null = null): ApprovedScholarship {
  return {
    discount_type: "percentage",
    percentage: value,
    amount_minor: null,
    currency_code: null,
    fee_category,
  };
}

function fixed(
  amount_minor: bigint,
  currency_code = "JOD",
  fee_category: string | null = null,
): ApprovedScholarship {
  return { discount_type: "fixed", percentage: null, amount_minor, currency_code, fee_category };
}

describe("scholarshipDiscountMinor", () => {
  test("no scholarships, no discount", () => {
    expect(scholarshipDiscountMinor(LINES, [], "JOD")).toBe(0n);
  });

  test("a percentage applies to every line", () => {
    expect(scholarshipDiscountMinor(LINES, [percentage("10.00")], "JOD")).toBe(60_000n);
  });

  test("a percentage limited to a fee category applies to that category only", () => {
    expect(scholarshipDiscountMinor(LINES, [percentage("50", "Tuition")], "JOD")).toBe(250_000n);
  });

  test("fractional percentages round half up to the minor unit", () => {
    // 12.5% of 0.333 JOD = 0.041625 JOD -> 0.042
    const lines = [{ fee_category: "Tuition", amount_minor: 333n }];
    expect(scholarshipDiscountMinor(lines, [percentage("12.50")], "JOD")).toBe(42n);
  });

  test("a fixed amount is capped at the lines it covers", () => {
    expect(scholarshipDiscountMinor(LINES, [fixed(150_000n, "JOD", "Transport")], "JOD")).toBe(
      100_000n,
    );
  });

  test("a fixed amount in another currency is not applied", () => {
    expect(scholarshipDiscountMinor(LINES, [fixed(50_000n, "USD")], "JOD")).toBe(0n);
  });

  test("scholarships stack and the total never exceeds the subtotal", () => {
    expect(scholarshipDiscountMinor(LINES, [percentage("10"), fixed(40_000n)], "JOD")).toBe(
      100_000n,
    );
    expect(scholarshipDiscountMinor(LINES, [percentage("100"), fixed(40_000n)], "JOD")).toBe(
      600_000n,
    );
  });

  test("a category with no matching line discounts nothing", () => {
    expect(scholarshipDiscountMinor(LINES, [percentage("50", "Uniform")], "JOD")).toBe(0n);
  });
});
