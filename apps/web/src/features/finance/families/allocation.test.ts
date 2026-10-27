// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { allocateOldestFirst, fromMinor, payingOrder, toMinor } from "./allocation";

import type { OpenInvoice } from "./allocation";

const invoice = (
  invoice_id: string,
  due_date: string | null,
  outstanding_minor: number,
): OpenInvoice => ({
  invoice_id,
  student_id: "s",
  due_date,
  issued_date: "2026-01-01",
  outstanding_minor,
});

describe("payingOrder", () => {
  test("oldest due first, undated last", () => {
    const ordered = payingOrder([
      invoice("C", null, 1),
      invoice("B", "2026-09-01", 1),
      invoice("A", "2026-08-01", 1),
    ]);
    expect(ordered.map((row) => row.invoice_id)).toEqual(["A", "B", "C"]);
  });
});

describe("allocateOldestFirst", () => {
  const open = [invoice("NEW", "2026-11-30", 450_000), invoice("OLD", "2026-08-22", 600_000)];

  test("pays the oldest invoice before the next", () => {
    expect(allocateOldestFirst(800_000, open)).toEqual([
      { invoice_id: "OLD", amount_minor: 600_000 },
      { invoice_id: "NEW", amount_minor: 200_000 },
    ]);
  });

  test("a small amount stays on the oldest invoice", () => {
    expect(allocateOldestFirst(100_000, open)).toEqual([
      { invoice_id: "OLD", amount_minor: 100_000 },
    ]);
  });

  test("never allocates more than an invoice owes", () => {
    const plan = allocateOldestFirst(5_000_000, open);
    expect(plan.reduce((sum, row) => sum + row.amount_minor, 0)).toBe(1_050_000);
  });
});

describe("toMinor / fromMinor", () => {
  test("respects the currency's precision", () => {
    expect(toMinor("12.5", 3)).toBe(12_500);
    expect(toMinor("600", 3)).toBe(600_000);
    expect(toMinor("1.2345", 3)).toBeNull();
    expect(toMinor("-1", 3)).toBeNull();
    expect(toMinor("abc", 2)).toBeNull();
    expect(fromMinor(600_000, 3)).toBe("600.000");
    expect(fromMinor(5, 2)).toBe("0.05");
  });
});
