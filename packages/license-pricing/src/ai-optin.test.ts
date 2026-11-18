// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  aiOptInPeriod,
  aiOptInTotal,
  firstOfMonth,
  firstOfNextMonth,
  monthsBetween,
} from "./ai-optin";

describe("aiOptInPeriod", () => {
  const year = { startsOn: "2026-09-01", endsOn: "2027-06-30" };

  test("before the year starts: the whole academic year", () => {
    expect(aiOptInPeriod(year, "2026-08-20")).toEqual({
      startMonth: "2026-09-01",
      endMonth: "2027-06-01",
      months: 10,
    });
  });

  test("late opt-in: only the months left, from this month", () => {
    expect(aiOptInPeriod(year, "2026-11-17")).toEqual({
      startMonth: "2026-11-01",
      endMonth: "2027-06-01",
      months: 8,
    });
    expect(aiOptInPeriod(year, "2027-06-30")?.months).toBe(1);
  });

  test("months follow the school's year, never an assumed 10", () => {
    expect(
      aiOptInPeriod({ startsOn: "2026-09-15", endsOn: "2027-04-30" }, "2026-01-01")?.months,
    ).toBe(8);
    expect(
      aiOptInPeriod({ startsOn: "2026-01-05", endsOn: "2026-12-20" }, "2026-01-01")?.months,
    ).toBe(12);
  });

  test("after the year: nothing to opt into", () => {
    expect(aiOptInPeriod(year, "2027-07-01")).toBeNull();
  });
});

describe("month helpers", () => {
  test("first of month, next month, and months between", () => {
    expect(firstOfMonth("2026-11-17")).toBe("2026-11-01");
    expect(firstOfNextMonth("2026-12-31")).toBe("2027-01-01");
    expect(monthsBetween("2026-09-01", "2027-06-01")).toBe(10);
    expect(aiOptInTotal(600, 8)).toBe(4800);
  });
});
