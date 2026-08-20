// Invoice line parsing (ST-202) — pure, DB-free coverage. `parseInvoiceLines` reads an ERPNext
// Sales Invoice's own `items` array (cached verbatim as `invoice_cache.erpnext_payload`), which
// this gateway does not own or validate — every case here is about degrading honestly on data
// this module cannot control, matching the "refuse to guess" posture `invoices/projection.ts`
// documents for the invoice as a whole. The exact-match search fast path and batch-creation
// validation in the rest of this file need a real Postgres (RLS, enrollments joins) and are
// exercised as integration tests once TEST_DATABASE_URL is available in CI, not here.

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { parseInvoiceLines } from "./service";

describe("parseInvoiceLines", () => {
  test("parses a well-formed ERPNext Sales Invoice items array", () => {
    const payload = {
      items: [
        { item_code: "tuition", description: "Tuition fee", qty: 1, rate: 1000 },
        { item_code: "transport", qty: 2, amount: 100 },
      ],
    };
    expect(parseInvoiceLines(payload)).toEqual([
      { fee_category: "tuition", description: "Tuition fee", quantity: 1, amount: 1000 },
      { fee_category: "transport", description: null, quantity: 2, amount: 100 },
    ]);
  });

  test("prefers item_code over item_name, and amount over rate, when both are present", () => {
    const payload = {
      items: [{ item_code: "tuition", item_name: "Tuition", rate: 1000, amount: 950 }],
    };
    expect(parseInvoiceLines(payload)).toEqual([
      { fee_category: "tuition", description: null, quantity: 1, amount: 950 },
    ]);
  });

  test("falls back to item_name when item_code is absent", () => {
    const payload = { items: [{ item_name: "Tuition", rate: 1000 }] };
    expect(parseInvoiceLines(payload)).toEqual([
      { fee_category: "Tuition", description: null, quantity: 1, amount: 1000 },
    ]);
  });

  test("drops an item with no usable fee category rather than guessing", () => {
    const payload = { items: [{ description: "mystery line", rate: 1000 }] };
    expect(parseInvoiceLines(payload)).toEqual([]);
  });

  test("drops an item whose amount is not a finite number", () => {
    const payload = { items: [{ item_code: "tuition", rate: "not-a-number" }] };
    expect(parseInvoiceLines(payload)).toEqual([]);
  });

  test("returns an empty array for a payload with no items array", () => {
    expect(parseInvoiceLines({})).toEqual([]);
    expect(parseInvoiceLines(null)).toEqual([]);
    expect(parseInvoiceLines({ items: "not-an-array" })).toEqual([]);
  });

  test("skips non-object entries inside items without throwing", () => {
    const payload = { items: [null, "garbage", 42, { item_code: "tuition", rate: 1000 }] };
    expect(parseInvoiceLines(payload)).toEqual([
      { fee_category: "tuition", description: null, quantity: 1, amount: 1000 },
    ]);
  });
});
