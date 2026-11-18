// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  academicYearMonths,
  monthCount,
  monthEnd,
  monthIndex,
  monthKey,
  monthStart,
} from "./academic-months";
import { aiOptInPeriod } from "./ai-optin";
import { instalmentPeriods } from "./revenue-share";

describe("academicYearMonths (the one month rule)", () => {
  test("a calendar month counts when the range covers at least half of it", () => {
    expect(monthCount(academicYearMonths("2026-09-01", "2027-06-30"))).toBe(10);
    expect(monthCount(academicYearMonths("2026-09-01", "2027-04-30"))).toBe(8);
    const late = academicYearMonths("2026-08-25", "2027-06-10")!;
    expect([monthKey(late.first), monthKey(late.last)]).toEqual(["2026-09", "2027-05"]);
    expect(academicYearMonths("2027-01-10", "2027-01-20")).toBeNull();
    expect(monthCount(null)).toBe(0);
  });

  test("month helpers", () => {
    expect(monthStart(monthIndex("2026-11-17"))).toBe("2026-11-01");
    expect(monthEnd(monthIndex("2028-02-10"))).toBe("2028-02-29");
    expect(monthEnd(monthIndex("2026-09-10"))).toBe("2026-09-30");
  });
});

describe("the licence, the parent's opt-in and the school's payments count the same months", () => {
  // A year that starts on 25 Aug and ends on 10 Jun: Sep..May by the rule (9 months).
  const year = { startsOn: "2026-08-25", endsOn: "2027-06-10" };
  const rule = academicYearMonths(year.startsOn, year.endsOn)!;

  test("phase 2: an early opt-in covers the rule's months, not the calendar's", () => {
    const period = aiOptInPeriod(year, "2026-08-26")!;
    expect(period).toEqual({ startMonth: "2026-09-01", endMonth: "2027-05-01", months: 9 });
    expect(period.months).toBe(monthCount(rule));
    // Opting in during June (not a counted month): nothing left to opt into.
    expect(aiOptInPeriod(year, "2027-06-05")).toBeNull();
  });

  test("phase 5: a monthly schedule over the same term pays for the same calendar months", () => {
    const instalments = Array.from({ length: monthCount(rule) }, (_, i) => ({
      position: i + 1,
      dueDate: monthStart(rule.first + i),
    }));
    const periods = instalmentPeriods({
      plan: "monthly",
      startDate: year.startsOn,
      endDate: "2027-06-11",
      months: 10, // the licence's own month count may differ; the rule decides when it matches
      instalments,
    });
    expect(periods).toHaveLength(9);
    // The first stretches back to the term's first day, the last on to its last day.
    expect(periods[0]).toEqual({ position: 1, from: "2026-08-25", to: "2026-09-30" });
    expect(periods[1]).toEqual({ position: 2, from: "2026-10-01", to: "2026-10-31" });
    expect(periods[8]).toEqual({ position: 9, from: "2027-05-01", to: "2027-06-10" });
  });

  test("phase 5: a term starting mid-month counts from the first month it covers half of", () => {
    // 17 Sep - 16 Jul: September has 14 of 30 days (not counted), July 16 of 31 (counted).
    const periods = instalmentPeriods({
      plan: "monthly",
      startDate: "2026-09-17",
      endDate: "2027-07-17",
      months: 10,
      instalments: Array.from({ length: 10 }, (_, i) => ({
        position: i + 1,
        dueDate: monthStart(monthIndex("2026-10-01") + i),
      })),
    });
    expect(periods[0]).toEqual({ position: 1, from: "2026-09-17", to: "2026-10-31" });
    expect(periods[9]).toEqual({ position: 10, from: "2027-07-01", to: "2027-07-16" });
  });
});
