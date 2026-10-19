// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { buildInvoicePreview, componentsSubtotal } from "./preview";

import type { FeeComponentDraft } from "./preview";

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
