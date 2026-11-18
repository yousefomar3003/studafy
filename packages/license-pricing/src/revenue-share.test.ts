// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { DEFAULT_AI_PROGRAMME_SETTINGS, resolveAiProgramme } from "./ai-programme";
import {
  addDaysUtc,
  computeRevenueShare,
  conversionMeasureDay,
  instalmentPeriods,
  measurementDateOf,
  monthSlices,
  ratioBps,
  shareAmountOf,
  splitByWeight,
  studentPartOf,
} from "./revenue-share";
import { buildSchedule } from "./schedule";

import type { RevenueShareInput } from "./revenue-share";

const defaults = resolveAiProgramme(DEFAULT_AI_PROGRAMME_SETTINGS, null, "USD");
const input = (fields: Partial<RevenueShareInput>): RevenueShareInput => ({
  conversionBps: 7000,
  uploadConsistencyBps: 8500,
  seats: 350,
  commitment: "full_year",
  baseMinor: 0,
  ...fields,
});

describe("the spec's worked example", () => {
  test("500 enrolled, 350 opted in, uploads on 85% of days, $14,000 collected -> 13% = $1,820", () => {
    const conversion = ratioBps(350, 500);
    expect(conversion).toBe(7000);
    // $4 x 350 seats x 10 months, at the school's own licence price.
    const collected = defaults.licensePriceMinor! * 350 * 10;
    expect(collected).toBe(1_400_000);
    const share = computeRevenueShare(defaults, {
      conversionBps: conversion,
      uploadConsistencyBps: ratioBps(85, 100),
      seats: 350,
      commitment: "full_year",
      baseMinor: collected,
    });
    expect(share).toEqual({
      conversionShareBps: 1000,
      floorApplied: false,
      bonusBps: 300,
      fullYearBps: 1300,
      capped: false,
      multiplierBps: 10_000,
      totalBps: 1300,
      amountMinor: 182_000,
      conversionPending: false,
      bonusPending: false,
      final: true,
    });
    // Per student: $40 paid to Studafy, $5.20 back.
    expect(share.amountMinor / 350).toBe(520);
  });

  test("paid monthly, the ten monthly shares add up to the same $1,820", () => {
    const months = buildSchedule({
      plan: "monthly",
      totalMinor: 1_400_000,
      months: 10,
      startDate: "2026-09-01",
      issueDate: "2026-08-20",
      inFullDueDate: "2026-09-19",
    });
    const shares = months.map(
      (m) => computeRevenueShare(defaults, input({ baseMinor: m.amountMinor })).amountMinor,
    );
    expect(shares.every((s) => s === 18_200)).toBe(true);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(182_000);
  });
});

describe("another school: an 8-month year at its own price", () => {
  // A school whose academic year is 8 months, priced at 5.000 (a three-decimal currency, e.g. JOD)
  // per seat per month, 120 seats of 200 students (60%), uploads on 65% of school days.
  const school = {
    ...defaults,
    currencyCode: "JOD",
    licensePriceMinor: 5_000,
    parentPriceMinor: 6_000,
  };

  test("the base is what Studafy collects at that price for those months", () => {
    const collected = school.licensePriceMinor * 120 * 8;
    expect(collected).toBe(4_800_000);
    const share = computeRevenueShare(school, {
      conversionBps: ratioBps(120, 200),
      uploadConsistencyBps: 6500,
      seats: 120,
      commitment: "full_year",
      baseMinor: collected,
    });
    // 55-69% -> 8%, 60-79% uploads -> +1.5%: 9.5% of 4,800.000 = 456.000.
    expect(share).toMatchObject({ conversionShareBps: 800, bonusBps: 150, totalBps: 950 });
    expect(share.amountMinor).toBe(456_000);
  });

  test("eight monthly instalments, one per month of that school's year", () => {
    const schedule = buildSchedule({
      plan: "monthly",
      totalMinor: 4_800_000,
      months: 8,
      startDate: "2026-09-01",
      issueDate: "2026-08-20",
      inFullDueDate: "2026-09-19",
    });
    expect(schedule).toHaveLength(8);
    const periods = instalmentPeriods({
      plan: "monthly",
      startDate: "2026-09-01",
      endDate: "2027-05-01",
      months: 8,
      instalments: schedule,
    });
    expect(periods[0]).toEqual({ position: 1, from: "2026-09-01", to: "2026-09-30" });
    expect(periods[7]).toEqual({ position: 8, from: "2027-04-01", to: "2027-04-30" });
    const total = schedule
      .map(
        (i) =>
          computeRevenueShare(school, {
            conversionBps: 6000,
            uploadConsistencyBps: 6500,
            seats: 120,
            commitment: "full_year",
            baseMinor: i.amountMinor,
          }).amountMinor,
      )
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(456_000);
  });
});

describe("tiers, floor, bonus rule and cap", () => {
  test("each conversion tier, from its threshold", () => {
    const at = (bps: number) =>
      computeRevenueShare(defaults, input({ conversionBps: bps, uploadConsistencyBps: 0 }))
        .conversionShareBps;
    expect([0, 2499, 2500, 3999, 4000, 5499, 5500, 6999, 7000, 8499, 8500, 10_000].map(at)).toEqual(
      [0, 0, 400, 400, 600, 600, 800, 800, 1000, 1000, 1200, 1200],
    );
  });

  test("conversion rounds down: 69.99% stays in the 55-69% tier", () => {
    expect(ratioBps(6999, 10_000)).toBe(6999);
    expect(ratioBps(2, 3)).toBe(6666);
    expect(ratioBps(0, 0)).toBe(0);
    expect(ratioBps(5, 0)).toBe(0);
    expect(ratioBps(12, 10)).toBe(10_000);
  });

  test("the large-school floor goes by seats on the licence, not students enrolled", () => {
    const small = computeRevenueShare(defaults, input({ conversionBps: 2000, seats: 499 }));
    expect(small).toMatchObject({ conversionShareBps: 0, floorApplied: false, totalBps: 0 });
    const large = computeRevenueShare(defaults, input({ conversionBps: 2000, seats: 500 }));
    expect(large).toMatchObject({ conversionShareBps: 800, floorApplied: true, bonusBps: 300 });
    // Above the floor the tier wins.
    expect(computeRevenueShare(defaults, input({ conversionBps: 9000, seats: 900 }))).toMatchObject(
      { conversionShareBps: 1200, floorApplied: false },
    );
  });

  test("the bonus needs a conversion share above 0% when the rule is on", () => {
    expect(
      computeRevenueShare(defaults, input({ conversionBps: 1000, uploadConsistencyBps: 9000 })),
    ).toMatchObject({ conversionShareBps: 0, bonusBps: 0, totalBps: 0 });
    expect(
      computeRevenueShare(
        { ...defaults, bonusRequiresConversionShare: false },
        input({ conversionBps: 1000, uploadConsistencyBps: 9000 }),
      ),
    ).toMatchObject({ conversionShareBps: 0, bonusBps: 300, totalBps: 300 });
    // Bonus tiers.
    const bonus = (bps: number) =>
      computeRevenueShare(defaults, input({ uploadConsistencyBps: bps })).bonusBps;
    expect([0, 5999, 6000, 7999, 8000, 10_000].map(bonus)).toEqual([0, 0, 150, 150, 300, 300]);
  });

  test("the total is capped at the maximum share", () => {
    const top = computeRevenueShare(
      defaults,
      input({ conversionBps: 9000, uploadConsistencyBps: 9000 }),
    );
    expect(top).toMatchObject({ fullYearBps: 1500, capped: false });
    const capped = computeRevenueShare(
      { ...defaults, maxShareBps: 1200, conversionTiers: [{ fromBps: 0, shareBps: 1100 }] },
      input({ uploadConsistencyBps: 9000, baseMinor: 10_000 }),
    );
    expect(capped).toMatchObject({
      fullYearBps: 1200,
      capped: true,
      totalBps: 1200,
      amountMinor: 1200,
    });
  });
});

describe("month-to-month licences", () => {
  test("earn nothing by default, and nothing is pending", () => {
    const share = computeRevenueShare(
      defaults,
      input({
        commitment: "month_to_month",
        conversionBps: null,
        uploadConsistencyBps: null,
        baseMinor: 100_000,
      }),
    );
    expect(share).toMatchObject({
      multiplierBps: 0,
      totalBps: 0,
      amountMinor: 0,
      conversionPending: false,
      bonusPending: false,
      final: true,
    });
  });

  test("earn the set share of the full-year share, rounded half up to a basis point", () => {
    const half = { ...defaults, monthToMonthShareBps: 5000 };
    expect(
      computeRevenueShare(half, input({ commitment: "month_to_month", baseMinor: 100_000 })),
    ).toMatchObject({ fullYearBps: 1300, multiplierBps: 5000, totalBps: 650, amountMinor: 6500 });
    // 1.5% (150 bps) x 1/3 = 50 bps; 1.5% x 0.3333 = 49.995 -> 50 (half up).
    const third = {
      ...defaults,
      monthToMonthShareBps: 3333,
      conversionTiers: [{ fromBps: 0, shareBps: 150 }],
    };
    expect(
      computeRevenueShare(third, input({ commitment: "month_to_month", uploadConsistencyBps: 0 }))
        .totalBps,
    ).toBe(50);
  });
});

describe("pending parts", () => {
  test("conversion not locked: shown at 0%, pending", () => {
    const share = computeRevenueShare(defaults, input({ conversionBps: null, baseMinor: 100_000 }));
    expect(share).toMatchObject({ conversionPending: true, final: false, conversionShareBps: 0 });
    // The large-school floor still shows for a large licence.
    expect(
      computeRevenueShare(defaults, input({ conversionBps: null, seats: 600 })).conversionShareBps,
    ).toBe(800);
  });

  test("upload consistency unknown: the bonus is pending unless a 0% conversion share rules it out", () => {
    expect(
      computeRevenueShare(defaults, input({ uploadConsistencyBps: null, baseMinor: 100_000 })),
    ).toMatchObject({
      bonusBps: 0,
      totalBps: 1000,
      amountMinor: 10_000,
      bonusPending: true,
      final: false,
    });
    expect(
      computeRevenueShare(defaults, input({ conversionBps: 1000, uploadConsistencyBps: null })),
    ).toMatchObject({ bonusPending: false, final: true, totalBps: 0 });
    expect(
      computeRevenueShare(
        { ...defaults, bonusRequiresConversionShare: false },
        input({ conversionBps: 1000, uploadConsistencyBps: null }),
      ),
    ).toMatchObject({ bonusPending: true, final: false });
    // No bonus tier above 0%, or a conversion share already at the cap: the bonus cannot matter.
    expect(
      computeRevenueShare(
        { ...defaults, contentBonusTiers: [{ fromBps: 0, shareBps: 0 }] },
        input({ uploadConsistencyBps: null }),
      ),
    ).toMatchObject({ bonusPending: false, final: true, totalBps: 1000 });
    expect(
      computeRevenueShare(
        { ...defaults, maxShareBps: 1000 },
        input({ uploadConsistencyBps: null }),
      ),
    ).toMatchObject({ bonusPending: false, final: true, totalBps: 1000 });
  });
});

describe("rounding", () => {
  test("the amount is base x bps / 10,000, half up to a whole minor unit", () => {
    expect(shareAmountOf(1_234, 1300)).toBe(160); // 160.42
    expect(shareAmountOf(1_250, 1300)).toBe(163); // 162.5 -> 163
    expect(shareAmountOf(3, 1500)).toBe(0); // 0.45
    expect(shareAmountOf(10, 1500)).toBe(2); // 1.5 -> 2
    expect(shareAmountOf(0, 1500)).toBe(0);
    expect(() => shareAmountOf(-1, 100)).toThrow(RangeError);
    expect(() => shareAmountOf(1, 10_001)).toThrow(RangeError);
    // Large amounts stay exact (BigInt).
    expect(shareAmountOf(9_000_000_000_000, 1300)).toBe(1_170_000_000_000);
  });

  test("the Student AI part of a payment that also pays for teacher seats", () => {
    // Student seats 14,000.00 and teacher seats 6,000.00 on one invoice: 70% of each payment.
    expect(studentPartOf(500_000, 1_400_000, 2_000_000)).toBe(350_000);
    expect(studentPartOf(1, 1, 3)).toBe(0); // 0.33
    expect(studentPartOf(3, 1, 2)).toBe(2); // 1.5 -> 2
    expect(studentPartOf(500_000, 2_000_000, 2_000_000)).toBe(500_000);
    expect(studentPartOf(500_000, 0, 2_000_000)).toBe(0);
  });
});

describe("dates", () => {
  test("measurement date: the period's first day + the offset", () => {
    expect(measurementDateOf("2026-09-01", 30)).toBe("2026-10-01");
    expect(measurementDateOf("2027-01-15", 0)).toBe("2027-01-15");
    expect(addDaysUtc("2028-02-28", 1)).toBe("2028-02-29");
  });

  test("periods: at once, yearly and custom", () => {
    expect(
      instalmentPeriods({
        plan: "in_full",
        startDate: "2026-09-01",
        endDate: "2027-07-01",
        months: 10,
        instalments: [{ position: 1, dueDate: "2026-09-20" }],
      }),
    ).toEqual([{ position: 1, from: "2026-09-01", to: "2027-06-30" }]);
    expect(
      instalmentPeriods({
        plan: "yearly",
        startDate: "2026-09-01",
        endDate: "2028-03-01",
        months: 18,
        instalments: [
          { position: 1, dueDate: "2026-09-01" },
          { position: 2, dueDate: "2027-09-01" },
        ],
      }),
    ).toEqual([
      { position: 1, from: "2026-09-01", to: "2027-08-31" },
      { position: 2, from: "2027-09-01", to: "2028-02-29" },
    ]);
    expect(
      instalmentPeriods({
        plan: "custom",
        startDate: "2026-09-01",
        endDate: "2027-07-01",
        months: 10,
        instalments: [
          { position: 1, dueDate: "2026-08-25" },
          { position: 2, dueDate: "2027-01-10" },
          { position: 3, dueDate: "2027-04-01" },
        ],
      }),
    ).toEqual([
      { position: 1, from: "2026-09-01", to: "2027-01-09" },
      { position: 2, from: "2027-01-10", to: "2027-03-31" },
      { position: 3, from: "2027-04-01", to: "2027-06-30" },
    ]);
  });

  test("a monthly schedule that no longer matches its months pays for the whole term", () => {
    expect(
      instalmentPeriods({
        plan: "monthly",
        startDate: "2026-09-01",
        endDate: "2026-12-01",
        months: 3,
        instalments: [
          { position: 1, dueDate: "2026-09-01" },
          { position: 2, dueDate: "2026-10-01" },
        ],
      }),
    ).toEqual([
      { position: 1, from: "2026-09-01", to: "2026-11-30" },
      { position: 2, from: "2026-09-01", to: "2026-11-30" },
    ]);
  });
});

describe("monthly conversion: months and their measurement day", () => {
  test("a month is measured on its first day, or on the licence's first day when it starts later", () => {
    expect(conversionMeasureDay("2026-10-01", "2026-09-01")).toBe("2026-10-01");
    expect(conversionMeasureDay("2026-09-01", "2026-09-10")).toBe("2026-09-10");
  });

  const year = { startsOn: "2026-09-01", lastDay: "2027-06-30" };

  test("one month paid for is one slice, a whole month", () => {
    expect(monthSlices("2026-09-01", "2026-09-30", year)).toEqual([
      { month: "2026-09-01", from: "2026-09-01", to: "2026-09-30", weight: 1_000_000 },
    ]);
  });

  test("a year paid at once is one whole-month slice per counted month, 28 days or 31", () => {
    const slices = monthSlices("2026-09-01", "2027-06-30", year);
    expect(slices.map((s) => s.month)).toEqual([
      "2026-09-01",
      "2026-10-01",
      "2026-11-01",
      "2026-12-01",
      "2027-01-01",
      "2027-02-01",
      "2027-03-01",
      "2027-04-01",
      "2027-05-01",
      "2027-06-01",
    ]);
    expect(slices.every((s) => s.weight === 1_000_000)).toBe(true);
  });

  test("days of a month the licence does not count go to the nearest month it counts, adding no weight", () => {
    // A term from 25 Aug: August is not counted (a week of it), so its days belong to September,
    // and 3 Jul (past a 30 Jun year end that the rule counts) belongs to June.
    const counted = { startsOn: "2026-08-25", lastDay: "2027-07-03" };
    expect(monthSlices("2026-08-25", "2026-09-30", counted)).toEqual([
      { month: "2026-09-01", from: "2026-08-25", to: "2026-09-30", weight: 1_000_000 },
    ]);
    expect(monthSlices("2027-06-01", "2027-07-03", counted)).toEqual([
      { month: "2027-06-01", from: "2027-06-01", to: "2027-07-03", weight: 1_000_000 },
    ]);
  });

  test("a month the licence counts at its edge is whole as far as the licence goes", () => {
    // 19 Nov to 18 Sep: November (12 days) is folded into December; September (18 of 30 days)
    // counts, whole -- a year paid at once is ten equal months.
    const term = { startsOn: "2026-11-19", lastDay: "2027-09-18" };
    const slices = monthSlices("2026-11-19", "2027-09-18", term);
    expect(slices).toHaveLength(10);
    expect(slices[0]).toMatchObject({ month: "2026-12-01", from: "2026-11-19" });
    expect(slices.every((s) => s.weight === 1_000_000)).toBe(true);
    expect(splitByWeight(1_400_000, slices)).toEqual(Array(10).fill(140_000));
  });

  test("a part of a month weighs its share of the month's days", () => {
    expect(monthSlices("2026-09-20", "2026-10-05", null).map((s) => [s.month, s.weight])).toEqual([
      ["2026-09-01", 366_667],
      ["2026-10-01", 161_290],
    ]);
  });
});

describe("splitting an amount over months", () => {
  const year = { startsOn: "2026-09-01", lastDay: "2027-06-30" };

  test("a year paid at once: every month the same, the parts adding up exactly", () => {
    const slices = monthSlices("2026-09-01", "2027-06-30", year);
    expect(splitByWeight(1_400_000, slices)).toEqual(Array(10).fill(140_000));
    for (const amount of [1, 0, 99_999, 7_777_777, -4_200]) {
      const parts = splitByWeight(amount, slices);
      expect(parts.reduce((sum, p) => sum + p, 0)).toBe(amount);
      expect(parts).toHaveLength(10);
    }
  });

  test("in proportion to the weights, the leftover unit to the largest remainder (earliest on a tie)", () => {
    expect(splitByWeight(100, [{ weight: 1 }, { weight: 1 }, { weight: 1 }])).toEqual([34, 33, 33]);
    expect(splitByWeight(10, [{ weight: 3 }, { weight: 1 }])).toEqual([8, 2]);
    expect(splitByWeight(9, [{ weight: 0 }, { weight: 0 }])).toEqual([5, 4]);
  });

  test("a single slice takes it all", () => {
    expect(splitByWeight(12_345, [{ weight: 1_000_000 }])).toEqual([12_345]);
  });
});
