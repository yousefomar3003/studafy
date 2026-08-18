// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { buildInvoicePreview, componentsSubtotal } from "./preview";

import type { FeeComponentDraft, PreviewAward, PreviewDiscountConfig } from "./preview";

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
  test("no awards: total equals the components subtotal", () => {
    const preview = buildInvoicePreview([TUITION, TRANSPORT], [], []);
    expect(preview.subtotal).toBe(1250.5);
    expect(preview.discountAmount).toBe(0);
    expect(preview.total).toBe(1250.5);
    expect(preview.lineItems).toEqual([
      { feeCategory: "Tuition", amount: 1000 },
      { feeCategory: "Transport", amount: 250.5 },
    ]);
  });

  test("fixed discounts sum directly", () => {
    const awards: PreviewAward[] = [
      { scholarship_discount_id: "d1" },
      { scholarship_discount_id: "d2" },
    ];
    const configs: PreviewDiscountConfig[] = [
      { id: "d1", discount_type: "fixed", amount: 50 },
      { id: "d2", discount_type: "fixed", amount: 25 },
    ];
    const preview = buildInvoicePreview([TUITION], awards, configs);
    expect(preview.discountAmount).toBe(75);
    expect(preview.total).toBe(925);
  });

  test("percentage discounts combine before applying once, not compounding", () => {
    const awards: PreviewAward[] = [
      { scholarship_discount_id: "d1" },
      { scholarship_discount_id: "d2" },
    ];
    const configs: PreviewDiscountConfig[] = [
      { id: "d1", discount_type: "percentage", amount: 10 },
      { id: "d2", discount_type: "percentage", amount: 10 },
    ];
    // 20% combined off 1000, not 1000 * 0.9 * 0.9.
    const preview = buildInvoicePreview([TUITION], awards, configs);
    expect(preview.discountAmount).toBe(200);
    expect(preview.total).toBe(800);
  });

  test("mixes fixed and percentage awards", () => {
    const awards: PreviewAward[] = [
      { scholarship_discount_id: "d1" },
      { scholarship_discount_id: "d2" },
    ];
    const configs: PreviewDiscountConfig[] = [
      { id: "d1", discount_type: "fixed", amount: 50 },
      { id: "d2", discount_type: "percentage", amount: 10 },
    ];
    const preview = buildInvoicePreview([TUITION], awards, configs);
    // 10% of 1000 = 100, plus the fixed 50 = 150.
    expect(preview.discountAmount).toBe(150);
    expect(preview.total).toBe(850);
  });

  test("ignores awards whose discount config isn't in the active list", () => {
    const awards: PreviewAward[] = [{ scholarship_discount_id: "missing" }];
    const preview = buildInvoicePreview([TUITION], awards, []);
    expect(preview.discountAmount).toBe(0);
    expect(preview.total).toBe(1000);
  });

  test("does not apply scope filtering — matches the worker's own unscoped discount application", () => {
    const awards: PreviewAward[] = [{ scholarship_discount_id: "d1" }];
    // A fee-category-scoped discount still discounts the whole invoice, same as
    // apps/workers/src/queues/billing/invoice.service.ts does today.
    const configs: PreviewDiscountConfig[] = [{ id: "d1", discount_type: "fixed", amount: 100 }];
    const preview = buildInvoicePreview([TUITION, TRANSPORT], awards, configs);
    expect(preview.discountAmount).toBe(100);
    expect(preview.total).toBe(1150.5);
  });

  test("clamps a total that would go negative", () => {
    const awards: PreviewAward[] = [{ scholarship_discount_id: "d1" }];
    const configs: PreviewDiscountConfig[] = [{ id: "d1", discount_type: "fixed", amount: 5000 }];
    const preview = buildInvoicePreview([TUITION], awards, configs);
    expect(preview.total).toBe(0);
  });
});
