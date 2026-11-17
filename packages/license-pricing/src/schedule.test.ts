// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  addMonthsUtc,
  allocatePayments,
  amountsFromShares,
  buildSchedule,
  customScheduleErrors,
  evenProposal,
  licenceYears,
  proposalErrors,
  splitByLicenceYears,
  splitEvenly,
  termsChanges,
  yearTotals,
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

describe("licence years", () => {
  test("a 13-month licence is a full year and one month", () => {
    expect(licenceYears("2026-09-01", 13)).toEqual([
      { year: 1, startDate: "2026-09-01", endDate: "2027-09-01", months: 12 },
      { year: 2, startDate: "2027-09-01", endDate: "2027-10-01", months: 1 },
    ]);
  });

  test("a short licence is one short year", () => {
    expect(licenceYears("2026-09-01", 3)).toEqual([
      { year: 1, startDate: "2026-09-01", endDate: "2026-12-01", months: 3 },
    ]);
  });

  test("a leap-day start keeps to the end of February in other years", () => {
    expect(licenceYears("2028-02-29", 24).map((y) => [y.startDate, y.endDate])).toEqual([
      ["2028-02-29", "2029-02-28"],
      ["2029-02-28", "2030-02-28"],
    ]);
  });

  test("a month-end start ends each year on the month's last day", () => {
    expect(licenceYears("2026-01-31", 14).map((y) => y.endDate)).toEqual([
      "2027-01-31",
      "2027-03-31",
    ]);
  });

  test("each year pays for its months; the remainder goes on year one", () => {
    expect(splitByLicenceYears(130_000, 13)).toEqual([120_000, 10_000]);
    expect(splitByLicenceYears(100_000, 13)).toEqual([92_308, 7_692]);
    expect(splitByLicenceYears(100_000, 13).reduce((a, b) => a + b, 0)).toBe(100_000);
    expect(splitByLicenceYears(99_999, 36)).toEqual([33_333, 33_333, 33_333]);
    expect(splitByLicenceYears(100_000, 36)).toEqual([33_334, 33_333, 33_333]);
  });
});

describe("yearly plan", () => {
  const base = {
    totalMinor: 130_000,
    months: 13,
    startDate: "2026-09-01",
    issueDate: "2026-08-20",
    inFullDueDate: "2026-09-19",
  };

  test("one instalment per licence year, due on the start and its anniversary", () => {
    expect(buildSchedule({ ...base, plan: "yearly" })).toEqual([
      { position: 1, amountMinor: 120_000, dueDate: "2026-09-01" },
      { position: 2, amountMinor: 10_000, dueDate: "2027-09-01" },
    ]);
  });

  test("a licence of a year or less is paid once, on its start", () => {
    expect(buildSchedule({ ...base, plan: "yearly", months: 6 })).toEqual([
      { position: 1, amountMinor: 130_000, dueDate: "2026-09-01" },
    ]);
  });

  test("a start before the issue date moves the first payment to the issue date", () => {
    expect(
      buildSchedule({ ...base, plan: "yearly", months: 24, issueDate: "2026-10-05" }).map(
        (i) => i.dueDate,
      ),
    ).toEqual(["2026-10-05", "2027-09-01"]);
  });

  test("a year whose share rounds to nothing has no instalment", () => {
    expect(buildSchedule({ ...base, plan: "yearly", totalMinor: 1 })).toEqual([
      { position: 1, amountMinor: 1, dueDate: "2026-09-01" },
    ]);
  });
});

describe("yearTotals", () => {
  test("monthly over 13 months: twelve payments in year one, one in year two", () => {
    const schedule = buildSchedule({
      plan: "monthly",
      totalMinor: 130_003,
      months: 13,
      startDate: "2026-09-01",
      issueDate: "2026-08-20",
      inFullDueDate: "2026-09-19",
    });
    const years = yearTotals(schedule, "2026-09-01", 13);
    expect(years.map((y) => [y.year, y.payments, y.amountMinor])).toEqual([
      [1, 12, 120_003],
      [2, 1, 10_000],
    ]);
    expect(years.reduce((sum, y) => sum + y.amountMinor, 0)).toBe(130_003);
  });

  test("a payment before the start counts in year one, one after the end in the last year", () => {
    const years = yearTotals(
      [
        { amountMinor: 10, dueDate: "2026-08-01" },
        { amountMinor: 20, dueDate: "2027-09-01" },
        { amountMinor: 30, dueDate: "2030-01-01" },
      ],
      "2026-09-01",
      24,
    );
    expect(years.map((y) => y.amountMinor)).toEqual([10, 50]);
  });
});

describe("the school's custom proposal", () => {
  const bounds = { today: "2026-08-20", termEnd: "2027-09-01" };

  test("an even proposal splits the term and the total", () => {
    expect(evenProposal("2026-09-01", 12, 4)).toEqual([
      { dueDate: "2026-09-01", shareBps: 2_500 },
      { dueDate: "2026-12-01", shareBps: 2_500 },
      { dueDate: "2027-03-01", shareBps: 2_500 },
      { dueDate: "2027-06-01", shareBps: 2_500 },
    ]);
    expect(evenProposal("2026-09-01", 12, 3).map((i) => i.shareBps)).toEqual([3_334, 3_333, 3_333]);
    expect(proposalErrors(evenProposal("2026-09-01", 12, 24), bounds)).toEqual([]);
  });

  test("reports every problem", () => {
    expect(proposalErrors([], bounds)).toEqual(["empty"]);
    expect(
      proposalErrors(
        [
          { dueDate: "2026-08-01", shareBps: 5_000 },
          { dueDate: "2027-09-01", shareBps: 4_000 },
          { dueDate: "2027-02-30", shareBps: 0 },
        ],
        bounds,
      ).sort(),
    ).toEqual(["after_term", "before_today", "invalid_date", "non_positive", "share_mismatch"]);
    expect(
      proposalErrors(
        [
          { dueDate: "2027-01-01", shareBps: 5_000 },
          { dueDate: "2026-10-01", shareBps: 5_000 },
        ],
        bounds,
      ),
    ).toEqual(["not_ascending"]);
    expect(proposalErrors([{ dueDate: "2027-08-31", shareBps: 10_000 }], bounds)).toEqual([]);
  });

  test("shares become amounts that add up to the total exactly", () => {
    const proposal = [
      { dueDate: "2026-09-01", shareBps: 3_000 },
      { dueDate: "2027-01-01", shareBps: 7_000 },
    ];
    expect(amountsFromShares(100_001, proposal)).toEqual([
      { amountMinor: 30_001, dueDate: "2026-09-01" },
      { amountMinor: 70_000, dueDate: "2027-01-01" },
    ]);
    const thirds = evenProposal("2026-09-01", 12, 3);
    const amounts = amountsFromShares(100_000, thirds);
    expect(amounts.reduce((sum, i) => sum + i.amountMinor, 0)).toBe(100_000);
    expect(customScheduleErrors(100_000, amounts)).toEqual([]);
  });
});

describe("termsChanges", () => {
  const requested = {
    months: 12,
    startDate: "2026-09-01",
    paymentPlan: "monthly" as const,
    proposal: null,
  };
  const offered = {
    months: 12,
    startDate: "2026-09-01T00:00:00.000Z",
    paymentPlan: "monthly" as const,
    custom: null,
    totalMinor: 100_000,
  };

  test("the school's own choice is no change", () => {
    expect(termsChanges(requested, offered)).toEqual([]);
  });

  test("names each part the super admin changed", () => {
    expect(
      termsChanges(requested, {
        ...offered,
        months: 6,
        startDate: "2026-10-01",
        paymentPlan: "yearly",
      }),
    ).toEqual(["months", "start", "plan"]);
  });

  test("what the school left open, or the quote kind fixes, is not a change", () => {
    expect(
      termsChanges(
        { months: null, startDate: null, paymentPlan: null, proposal: null },
        { ...offered, paymentPlan: "in_full" },
      ),
    ).toEqual([]);
    expect(termsChanges(requested, { ...offered, months: null, startDate: null })).toEqual([]);
  });

  test("a custom schedule matches only the school's dates and shares", () => {
    const proposal = [
      { dueDate: "2026-09-01", shareBps: 5_000 },
      { dueDate: "2027-03-01", shareBps: 5_000 },
    ];
    const custom = { ...requested, paymentPlan: "custom" as const, proposal };
    const asked = amountsFromShares(100_000, proposal);
    expect(termsChanges(custom, { ...offered, paymentPlan: "custom", custom: asked })).toEqual([]);
    expect(
      termsChanges(custom, {
        ...offered,
        paymentPlan: "custom",
        custom: [
          { amountMinor: 40_000, dueDate: "2026-09-01" },
          { amountMinor: 60_000, dueDate: "2027-03-01" },
        ],
      }),
    ).toEqual(["schedule"]);
  });
});
