// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { formatCurrency, formatDate, formatNumber } from "./format";

describe("formatDate", () => {
  test("renders a fixed date in each locale's own convention", () => {
    const date = new Date(Date.UTC(2026, 0, 15));
    expect(formatDate(date, "en", { dateStyle: "long", timeZone: "UTC" })).toBe("January 15, 2026");
    expect(
      formatDate(date, "ar", { dateStyle: "long", timeZone: "UTC", numberingSystem: "latn" }),
    ).toContain("2026");
  });
});

describe("formatNumber", () => {
  test("uses the locale's grouping and digit conventions", () => {
    expect(formatNumber(1234.5, "en")).toBe("1,234.5");
    // Arabic renders Arabic-Indic digits by default; opting into "latn" restores Western digits.
    expect(formatNumber(1234.5, "ar", { numberingSystem: "latn" })).toBe("1,234.5");
  });
});

describe("formatCurrency", () => {
  test("places the currency symbol per locale", () => {
    expect(formatCurrency(99.9, "USD", "en")).toBe("$99.90");
    expect(formatCurrency(99.9, "USD", "ar", { numberingSystem: "latn" })).toContain("99.90");
  });
});
