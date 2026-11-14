// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  addMonthsUtc,
  allocatePayments,
  buildSchedule,
  customScheduleErrors,
  splitEvenly,
} from "./schedule";

describe("splitEvenly", () => {
  test("puts the rounding remainder on the first part", () => {
    expect(splitEvenly(100_000, 8)).toEqual([
      12_500, 12_500, 12_500, 12_500, 12_500, 12_500, 12_500, 12_500,
    ]);
    expect(splitEvenly(100_003, 8)).toEqual([
      12_503, 12_500, 12_500, 12_500, 12_500, 12_500, 12_500, 12_500,
    ]);
    expect(splitEvenly(100_003, 8).reduce((a, b) => a + b, 0)).toBe(100_003);
  });

  test("never makes a part of zero", () => {
    expect(splitEvenly(5, 8)).toEqual([1, 1, 1, 1, 1]);
    expect(splitEvenly(0, 8)).toEqual([0]);
  });
});

describe("addMonthsUtc", () => {
  test("keeps the day, or the last day of a shorter month", () => {
    expect(addMonthsUtc("2026-09-01", 1)).toBe("2026-10-01");
    expect(addMonthsUtc("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsUtc("2026-11-15", 3)).toBe("2027-02-15");
  });
});

describe("buildSchedule", () => {
  const base = {
    totalMinor: 80_000,
    months: 8,
    startDate: "2026-09-01",
    issueDate: "2026-08-20",
    inFullDueDate: "2026-09-19",
  };

  test("in full is one instalment due on the usual due date", () => {
    expect(buildSchedule({ ...base, plan: "in_full" })).toEqual([
      { position: 1, amountMinor: 80_000, dueDate: "2026-09-19" },
    ]);
  });

  test("monthly is one instalment per licence month from the start", () => {
    const schedule = buildSchedule({ ...base, plan: "monthly" });
    expect(schedule).toHaveLength(8);
    expect(schedule[0]).toEqual({ position: 1, amountMinor: 10_000, dueDate: "2026-09-01" });
    expect(schedule[7]).toEqual({ position: 8, amountMinor: 10_000, dueDate: "2027-04-01" });
  });

  test("monthly due dates before the issue date move to the issue date", () => {
    const schedule = buildSchedule({ ...base, plan: "monthly", issueDate: "2026-10-10" });
    expect(schedule.map((i) => i.dueDate).slice(0, 3)).toEqual([
      "2026-10-10",
      "2026-10-10",
      "2026-11-01",
    ]);
  });

  test("custom keeps the super admin's amounts and dates", () => {
    const custom = [
      { amountMinor: 40_000, dueDate: "2026-09-01" },
      { amountMinor: 40_000, dueDate: "2027-01-01" },
    ];
    expect(buildSchedule({ ...base, plan: "custom", custom })).toEqual([
      { position: 1, amountMinor: 40_000, dueDate: "2026-09-01" },
      { position: 2, amountMinor: 40_000, dueDate: "2027-01-01" },
    ]);
  });

  test("a custom schedule that does not add up is refused", () => {
    expect(() =>
      buildSchedule({
        ...base,
        plan: "custom",
        custom: [{ amountMinor: 1, dueDate: "2026-09-01" }],
      }),
    ).toThrow(RangeError);
  });

  test("nothing to pay is a single paid-at-once instalment of zero", () => {
    expect(buildSchedule({ ...base, plan: "monthly", totalMinor: 0 })).toEqual([
      { position: 1, amountMinor: 0, dueDate: "2026-09-19" },
    ]);
  });
});

describe("customScheduleErrors", () => {
  test("reports every problem", () => {
    expect(customScheduleErrors(100, [])).toEqual(["empty"]);
    expect(
      customScheduleErrors(100, [
        { amountMinor: 60, dueDate: "2026-10-01" },
        { amountMinor: 0, dueDate: "2026-09-01" },
        { amountMinor: 30, dueDate: "2026-13-01" },
      ]).sort(),
    ).toEqual(["invalid_date", "non_positive", "not_ascending", "sum_mismatch"]);
    expect(customScheduleErrors(100, [{ amountMinor: 100, dueDate: "2026-09-01" }])).toEqual([]);
  });
});

describe("allocatePayments", () => {
  const instalments = [
    { position: 1, amountMinor: 100 },
    { position: 2, amountMinor: 100 },
    { position: 3, amountMinor: 100 },
  ];

  test("fills the earliest instalment first", () => {
    expect(allocatePayments(instalments, 150).map((i) => [i.paidMinor, i.status])).toEqual([
      [100, "paid"],
      [50, "partially_paid"],
      [0, "due"],
    ]);
  });

  test("re-applies from scratch, so a voided payment comes off the latest", () => {
    expect(allocatePayments(instalments, 80).map((i) => i.status)).toEqual([
      "partially_paid",
      "due",
      "due",
    ]);
    expect(allocatePayments(instalments, 300).every((i) => i.status === "paid")).toBe(true);
  });

  test("a zero instalment is paid", () => {
    expect(allocatePayments([{ position: 1, amountMinor: 0 }], 0)[0]!.status).toBe("paid");
  });
});
