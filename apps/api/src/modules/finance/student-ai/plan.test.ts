// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  academicYearMonths,
  allocatePortions,
  chargedMonths,
  monthIndex,
  monthKey,
  portionMonths,
  portionsFingerprint,
} from "./plan";

import type { MonthRange } from "./plan";

const m = (key: string) => monthIndex(`${key}-01`);
const keys = (months: readonly number[]) => months.map(monthKey);
const sum = (portions: readonly { amountMinor: number }[]) =>
  portions.reduce((total, p) => total + p.amountMinor, 0);

const TEN: MonthRange = academicYearMonths("2026-09-01", "2027-06-30")!;
const EIGHT: MonthRange = academicYearMonths("2026-09-01", "2027-04-30")!;

describe("academicYearMonths", () => {
  test("follows the school's year: 10 months, 8 months, never assumed", () => {
    expect(TEN.last - TEN.first + 1).toBe(10);
    expect(monthKey(TEN.first)).toBe("2026-09");
    expect(monthKey(TEN.last)).toBe("2027-06");
    expect(EIGHT.last - EIGHT.first + 1).toBe(8);
    expect(monthKey(EIGHT.last)).toBe("2027-04");
  });

  test("a month counts when the year covers at least half of it", () => {
    // 25 Aug - 10 Jun: a week of August and ten days of June are not charged as whole months.
    const year = academicYearMonths("2026-08-25", "2027-06-10")!;
    expect(monthKey(year.first)).toBe("2026-09");
    expect(monthKey(year.last)).toBe("2027-05");
    // 15 Feb (14 of 28 days) counts; 16 Sep - 15 Jun: September (15 of 30) counts, June (15) too.
    expect(monthKey(academicYearMonths("2027-02-15", "2027-06-30")!.first)).toBe("2027-02");
    const half = academicYearMonths("2026-09-16", "2027-06-15")!;
    expect(keys([half.first, half.last])).toEqual(["2026-09", "2027-06"]);
  });

  test("a year shorter than half a month has no months", () => {
    expect(academicYearMonths("2027-01-10", "2027-01-20")).toBeNull();
  });
});

describe("chargedMonths", () => {
  test("from the start month to the year's end", () => {
    expect(chargedMonths(TEN, m("2026-09"), null)).toHaveLength(10);
    expect(chargedMonths(EIGHT, m("2026-09"), null)).toHaveLength(8);
  });

  test("a start before the year is clamped to its first month", () => {
    expect(keys(chargedMonths(TEN, m("2026-06"), null))[0]).toBe("2026-09");
  });

  test("a late opt-in pays the remaining months only", () => {
    expect(keys(chargedMonths(TEN, m("2027-02"), null))).toEqual([
      "2027-02",
      "2027-03",
      "2027-04",
      "2027-05",
      "2027-06",
    ]);
  });

  test("a released seat stops from its stop month", () => {
    // Released in December: charges stop from January.
    expect(keys(chargedMonths(TEN, m("2026-09"), m("2027-01")))).toEqual([
      "2026-09",
      "2026-10",
      "2026-11",
      "2026-12",
    ]);
    expect(chargedMonths(TEN, m("2027-02"), m("2027-02"))).toEqual([]);
  });

  test("a start after the year's end charges nothing", () => {
    expect(chargedMonths(TEN, m("2027-07"), null)).toEqual([]);
  });
});

describe("allocatePortions", () => {
  const price = 600; // $6.00

  test("10 months over three instalments: 4 + 3 + 3 months, whole months, exact total", () => {
    const portions = allocatePortions({
      year: TEN,
      startMonth: m("2026-09"),
      charged: chargedMonths(TEN, m("2026-09"), null),
      instalmentDueDates: ["2027-04-01", "2026-09-01", "2027-01-01", "2026-09-01"],
      monthlyPriceMinor: price,
    });
    expect(portions).toEqual([
      { dueDate: "2026-09-01", firstMonth: "2026-09-01", monthCount: 4, amountMinor: 2400 },
      { dueDate: "2027-01-01", firstMonth: "2027-01-01", monthCount: 3, amountMinor: 1800 },
      { dueDate: "2027-04-01", firstMonth: "2027-04-01", monthCount: 3, amountMinor: 1800 },
    ]);
    expect(sum(portions)).toBe(6000);
  });

  test("8 months over three instalments: 3 + 3 + 2", () => {
    const portions = allocatePortions({
      year: EIGHT,
      startMonth: m("2026-09"),
      charged: chargedMonths(EIGHT, m("2026-09"), null),
      instalmentDueDates: ["2026-09-05", "2026-12-05", "2027-03-05"],
      monthlyPriceMinor: price,
    });
    expect(portions.map((p) => p.monthCount)).toEqual([3, 3, 2]);
    expect(sum(portions)).toBe(4800);
  });

  test("months before the first instalment are paid by it", () => {
    const portions = allocatePortions({
      year: TEN,
      startMonth: m("2026-09"),
      charged: chargedMonths(TEN, m("2026-09"), null),
      instalmentDueDates: ["2026-10-15", "2027-02-15"],
      monthlyPriceMinor: price,
    });
    expect(portions).toEqual([
      { dueDate: "2026-10-15", firstMonth: "2026-09-01", monthCount: 5, amountMinor: 3000 },
      { dueDate: "2027-02-15", firstMonth: "2027-02-01", monthCount: 5, amountMinor: 3000 },
    ]);
  });

  test("a late opt-in spreads only over instalments from its start month", () => {
    const portions = allocatePortions({
      year: TEN,
      startMonth: m("2027-02"),
      charged: chargedMonths(TEN, m("2027-02"), null),
      instalmentDueDates: ["2026-09-01", "2027-01-01", "2027-04-01"],
      monthlyPriceMinor: price,
    });
    expect(portions).toEqual([
      { dueDate: "2027-04-01", firstMonth: "2027-02-01", monthCount: 5, amountMinor: 3000 },
    ]);
  });

  test("with no instalment in range the line is billed month by month", () => {
    const portions = allocatePortions({
      year: TEN,
      startMonth: m("2027-05"),
      charged: chargedMonths(TEN, m("2027-05"), null),
      instalmentDueDates: ["2026-09-01", "2027-07-01"],
      monthlyPriceMinor: 4500,
    });
    expect(portions).toEqual([
      { dueDate: "2027-05-01", firstMonth: "2027-05-01", monthCount: 1, amountMinor: 4500 },
      { dueDate: "2027-06-01", firstMonth: "2027-06-01", monthCount: 1, amountMinor: 4500 },
    ]);
  });

  test("a release removes the future months; invoiced months are never planned again", () => {
    const billed = new Set(portionMonths("2026-09-01", 4));
    const portions = allocatePortions({
      year: TEN,
      startMonth: m("2026-09"),
      charged: chargedMonths(TEN, m("2026-09"), m("2027-02")),
      instalmentDueDates: ["2026-09-01", "2027-01-01", "2027-04-01"],
      monthlyPriceMinor: price,
      billedMonths: billed,
    });
    // Sep-Dec invoiced; released from February: only January is left, on the January instalment.
    expect(portions).toEqual([
      { dueDate: "2027-01-01", firstMonth: "2027-01-01", monthCount: 1, amountMinor: 600 },
    ]);
  });

  test("auto-billing switched back on bills from that month only", () => {
    const portions = allocatePortions({
      year: TEN,
      startMonth: m("2026-09"),
      charged: chargedMonths(TEN, m("2026-09"), null),
      instalmentDueDates: ["2026-09-01", "2027-01-01", "2027-04-01"],
      monthlyPriceMinor: price,
      billingFrom: m("2027-02"),
    });
    expect(portions).toEqual([
      { dueDate: "2027-01-01", firstMonth: "2027-02-01", monthCount: 2, amountMinor: 1200 },
      { dueDate: "2027-04-01", firstMonth: "2027-04-01", monthCount: 3, amountMinor: 1800 },
    ]);
  });

  test("a hole of invoiced months splits a portion into runs", () => {
    const portions = allocatePortions({
      year: TEN,
      startMonth: m("2026-09"),
      charged: chargedMonths(TEN, m("2026-09"), null),
      instalmentDueDates: ["2026-09-01"],
      monthlyPriceMinor: price,
      billedMonths: new Set([m("2026-11")]),
    });
    expect(portions.map((p) => [p.firstMonth, p.monthCount])).toEqual([
      ["2026-09-01", 2],
      ["2026-12-01", 7],
    ]);
    expect(sum(portions)).toBe(5400);
  });

  test("the same input always gives the same plan", () => {
    const input = {
      year: TEN,
      startMonth: m("2026-11"),
      charged: chargedMonths(TEN, m("2026-11"), null),
      instalmentDueDates: ["2027-01-01", "2026-09-01", "2027-04-01"],
      monthlyPriceMinor: 333,
    };
    const first = allocatePortions(input);
    const again = allocatePortions({
      ...input,
      instalmentDueDates: [...input.instalmentDueDates].reverse(),
    });
    expect(portionsFingerprint(first)).toBe(portionsFingerprint(again));
    expect(sum(first)).toBe(333 * 8);
  });
});
