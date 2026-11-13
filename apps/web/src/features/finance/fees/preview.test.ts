// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { buildInvoicePreview, componentsSubtotal, scholarshipDiscount } from "./preview";

import type { FeeComponentDraft, PreviewScholarship } from "./preview";

const TUITION: FeeComponentDraft = { fee_category: "Tuition", amount: 1000 };
const TRANSPORT: FeeComponentDraft = { fee_category: "Transport", amount: 250.5 };

describe("componentsSubtotal", () => {
  test("sums component amounts", () => {
    expect(componentsSubtotal([TUITION, TRANSPORT])).toBe(1250.5);
  });

  test("is zero for no components", () => {
    expect(componentsSubtotal([])).toBe(0);
  });
});

describe("buildInvoicePreview", () => {
  test("is the structure's components at full price — no discounts are applied", () => {
    const preview = buildInvoicePreview([TUITION, TRANSPORT]);
    expect(preview.total).toBe(1250.5);
    expect(preview.lineItems).toEqual([
      { feeCategory: "Tuition", amount: 1000 },
      { feeCategory: "Transport", amount: 250.5 },
    ]);
  });
});

describe("scholarshipDiscount", () => {
  // Same cases as the billing worker's scholarship-discount.test.ts, so the preview and the real
  // invoice agree.
  const lines: FeeComponentDraft[] = [
    { fee_category: "Tuition", amount: 500 },
    { fee_category: "Transport", amount: 100 },
  ];
  const pct = (value: string, fee_category: string | null = null): PreviewScholarship => ({
    discount_type: "percentage",
    percentage: value,
    amount: null,
    currency: null,
    fee_category,
  });
  const fixed = (amount: string, currency = "JOD", fee_category: string | null = null) =>
    ({ discount_type: "fixed", percentage: null, amount, currency, fee_category }) as const;

  test("a percentage of every line, or of one category", () => {
    expect(scholarshipDiscount(lines, [pct("10.00")], "JOD")).toBe(60);
    expect(scholarshipDiscount(lines, [pct("50", "Tuition")], "JOD")).toBe(250);
  });

  test("rounds half up to the third decimal", () => {
    expect(
      scholarshipDiscount([{ fee_category: "Tuition", amount: 0.333 }], [pct("12.50")], "JOD"),
    ).toBe(0.042);
  });

  test("a fixed amount is capped, and skipped in another currency", () => {
    expect(scholarshipDiscount(lines, [fixed("150", "JOD", "Transport")], "JOD")).toBe(100);
    expect(scholarshipDiscount(lines, [fixed("50", "USD")], "JOD")).toBe(0);
  });

  test("stacked scholarships never exceed the subtotal", () => {
    expect(scholarshipDiscount(lines, [pct("10"), fixed("40")], "JOD")).toBe(100);
    expect(scholarshipDiscount(lines, [pct("100"), fixed("40")], "JOD")).toBe(600);
  });
});
