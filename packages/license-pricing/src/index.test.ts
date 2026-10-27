// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { calculateLicensePrice, PricingError } from "./index";

import type { PriceSettings, PricingInput, SeatInput, SeatLine } from "./index";

/**
 * Real numbers, worked by hand. The house settings: 1-99 seats 0%, 100-499 10%, 500+ 20%;
 * 12 months 10%, 24 months 15%. Student Plus lists at 30.00 USD per seat per month (3000 cents).
 */
const SETTINGS: PriceSettings = {
  volumeBasis: "per_audience",
  volumeBrackets: [
    { audience: null, minSeats: 1, discountBps: 0 },
    { audience: null, minSeats: 100, discountBps: 1000 },
    { audience: null, minSeats: 500, discountBps: 2000 },
  ],
  durationDiscounts: [
    { minMonths: 12, discountBps: 1000 },
    { minMonths: 24, discountBps: 1500 },
  ],
};

const students = (seats: number, overrides: Partial<SeatInput> = {}): SeatInput => ({
  audience: "student",
  tierCode: "student_plus",
  tierName: "Student Plus",
  seats,
  listPricePerSeatMonthMinor: 3000,
  ...overrides,
});

function price(overrides: Partial<PricingInput>) {
  return calculateLicensePrice({
    currencyCode: "USD",
    months: 12,
    includeFamilyPlus: false,
    seats: [students(150)],
    settings: SETTINGS,
    ...overrides,
  });
}

const seatLine = (result: ReturnType<typeof price>, index = 0) =>
  result.lines.filter((line): line is SeatLine => line.kind === "seats")[index]!;

describe("a 12-month license for 150 students", () => {
  const result = price({});
  const line = seatLine(result);

  test("list, volume, duration, net", () => {
    // 30.00 x 150 seats x 12 months.
    expect(line.listAmountMinor).toBe(5_400_000);
    // 150 seats: the 100-499 bracket, 10%.
    expect(line.volumeDiscountBps).toBe(1000);
    expect(line.volumeDiscountMinor).toBe(540_000);
    // 12 months, 10%, on what is left after the volume discount.
    expect(line.durationDiscountBps).toBe(1000);
    expect(line.durationDiscountMinor).toBe(486_000);
    expect(line.amountMinor).toBe(4_374_000);
    expect(result.totalMinor).toBe(4_374_000);
  });

  test("price per seat before and after, and what the school saves", () => {
    expect(line.listPricePerSeatMonthMinor).toBe(3000);
    expect(line.pricePerSeatMonthMinor).toBe(2430);
    expect(line.savingsMinor).toBe(1_026_000);
    expect(result.savingsMinor).toBe(1_026_000);
    // 1,026,000 / 5,400,000 = 19%.
    expect(result.savingsBps).toBe(1900);
  });

  test("the better offer: 350 more seats reach 20% and 21.60 a seat", () => {
    expect(line.nextVolumeBracket).toEqual({
      minSeats: 500,
      discountBps: 2000,
      seatsToAdd: 350,
      // 30.00 - 20% = 24.00, - 10% = 21.60.
      pricePerSeatMonthMinor: 2160,
    });
  });
});

describe("volume bracket edges", () => {
  const at = (seats: number) => seatLine(price({ months: 1, seats: [students(seats)] }));

  test("99 seats: no volume discount, 1 seat short of 10%", () => {
    const line = at(99);
    expect(line.volumeDiscountBps).toBe(0);
    expect(line.amountMinor).toBe(297_000);
    expect(line.nextVolumeBracket).toEqual({
      minSeats: 100,
      discountBps: 1000,
      seatsToAdd: 1,
      pricePerSeatMonthMinor: 2700,
    });
  });

  test("100 seats: 10%, and 100 seats cost less than 99", () => {
    const line = at(100);
    expect(line.volumeDiscountBps).toBe(1000);
    expect(line.amountMinor).toBe(270_000);
    expect(line.amountMinor).toBeLessThan(at(99).amountMinor);
  });

  test("499 seats: still 10%", () => {
    const line = at(499);
    expect(line.volumeDiscountBps).toBe(1000);
    expect(line.nextVolumeBracket?.seatsToAdd).toBe(1);
  });

  test("500 seats: 20%, and no bracket above", () => {
    const line = at(500);
    expect(line.volumeDiscountBps).toBe(2000);
    expect(line.amountMinor).toBe(1_200_000);
    expect(line.nextVolumeBracket).toBeNull();
  });

  test("a next bracket at the same rate is not offered", () => {
    const line = seatLine(
      price({
        months: 1,
        seats: [students(10)],
        settings: {
          ...SETTINGS,
          volumeBrackets: [
            { audience: null, minSeats: 1, discountBps: 500 },
            { audience: null, minSeats: 50, discountBps: 500 },
            { audience: null, minSeats: 200, discountBps: 1500 },
          ],
        },
      }),
    );
    expect(line.nextVolumeBracket?.minSeats).toBe(200);
  });
});

describe("duration discount edges", () => {
  const at = (months: number) => seatLine(price({ months, seats: [students(10)] }));

  test("11 months: none; 12: 10%; 23: 10%; 24: 15%", () => {
    expect(at(11).durationDiscountBps).toBe(0);
    expect(at(12).durationDiscountBps).toBe(1000);
    expect(at(23).durationDiscountBps).toBe(1000);
    expect(at(24).durationDiscountBps).toBe(1500);
  });

  test("24 months for 10 students: 30.00 x 10 x 24 less 15%", () => {
    const line = at(24);
    expect(line.listAmountMinor).toBe(720_000);
    expect(line.durationDiscountMinor).toBe(108_000);
    expect(line.amountMinor).toBe(612_000);
    expect(line.pricePerSeatMonthMinor).toBe(2550);
  });
});

describe("rounding", () => {
  const flat10: PriceSettings = {
    volumeBasis: "per_audience",
    volumeBrackets: [{ audience: null, minSeats: 1, discountBps: 1000 }],
    durationDiscounts: [],
  };

  test("a discount rounds to the nearest minor unit", () => {
    // 29.99 x 7 = 209.93; 10% = 20.993 -> 20.99.
    const line = seatLine(
      price({
        months: 1,
        settings: flat10,
        seats: [students(7, { listPricePerSeatMonthMinor: 2999 })],
      }),
    );
    expect(line.listAmountMinor).toBe(20_993);
    expect(line.volumeDiscountMinor).toBe(2099);
    expect(line.amountMinor).toBe(18_894);
    // 188.94 / 7 = 26.991... -> 26.99.
    expect(line.pricePerSeatMonthMinor).toBe(2699);
  });

  test("an exact half rounds up", () => {
    // 41.99 x 5 = 209.95; 10% = 20.995 -> 21.00.
    const line = seatLine(
      price({
        months: 1,
        settings: flat10,
        seats: [students(5, { listPricePerSeatMonthMinor: 4199 })],
      }),
    );
    expect(line.volumeDiscountMinor).toBe(2100);
    expect(line.amountMinor).toBe(18_895);
  });

  test("the discounts compound, each rounded on its own", () => {
    // 10.01: 10% = 1.001 -> 1.00, leaving 9.01; 15% of that = 1.3515 -> 1.35; net 7.66.
    const line = seatLine(
      price({
        months: 24,
        settings: { ...flat10, durationDiscounts: [{ minMonths: 24, discountBps: 1500 }] },
        seats: [students(1, { listPricePerSeatMonthMinor: 1001 })],
      }),
    );
    expect(line.listAmountMinor).toBe(24_024);
    expect(line.volumeDiscountMinor).toBe(2402);
    expect(line.durationDiscountMinor).toBe(3243);
    expect(line.amountMinor).toBe(18_379);
    expect(line.listAmountMinor - line.volumeDiscountMinor - line.durationDiscountMinor).toBe(
      line.amountMinor,
    );
  });

  test("large licenses stay exact", () => {
    const line = seatLine(
      price({
        months: 120,
        seats: [students(100_000, { listPricePerSeatMonthMinor: 9_999_999 })],
      }),
    );
    // 99,999.99 x 100,000 x 120 = 119,999,988,000,000 minor units.
    expect(line.listAmountMinor).toBe(119_999_988_000_000);
    expect(Number.isSafeInteger(line.amountMinor)).toBe(true);
  });
});

describe("prorating a seat increase", () => {
  test("50 added seats for the 146 days left, discounted at the license's 150 seats", () => {
    const result = price({
      months: 12,
      prorateDays: 146,
      seats: [students(50, { volumeSeats: 150 })],
    });
    const line = seatLine(result);
    // 30.00 x 50 x 146 x 12 / 365 = 7,200.00.
    expect(line.listAmountMinor).toBe(720_000);
    expect(line.volumeSeats).toBe(150);
    expect(line.volumeDiscountBps).toBe(1000);
    expect(line.amountMinor).toBe(583_200);
    // The same 24.30 per seat-month the original 150 seats pay.
    expect(line.pricePerSeatMonthMinor).toBe(2430);
    expect(result.prorateDays).toBe(146);
  });

  test("one seat for one day rounds to the minor unit", () => {
    // 30.00 x 12 / 365 = 0.98630... -> 0.99.
    const line = seatLine(
      price({
        months: 1,
        prorateDays: 1,
        seats: [students(1)],
        settings: { ...SETTINGS, durationDiscounts: [] },
      }),
    );
    expect(line.listAmountMinor).toBe(99);
  });
});

describe("volume basis", () => {
  const teachers = (seats: number): SeatInput => ({
    audience: "teacher",
    tierCode: "teacher_pro",
    tierName: "Teacher Pro",
    seats,
    listPricePerSeatMonthMinor: 5000,
  });

  test("overall: 60 students and 50 teachers count as 110 together", () => {
    const result = price({
      seats: [students(60), teachers(50)],
      settings: { ...SETTINGS, volumeBasis: "overall" },
    });
    expect(seatLine(result, 0)).toMatchObject({ audience: "student", volumeDiscountBps: 1000 });
    expect(seatLine(result, 1)).toMatchObject({
      audience: "teacher",
      volumeDiscountBps: 1000,
      listAmountMinor: 3_000_000,
      amountMinor: 2_430_000,
    });
    expect(seatLine(result, 0).amountMinor).toBe(1_749_600);
    expect(result.totalMinor).toBe(4_179_600);
    expect(seatLine(result, 0).nextVolumeBracket?.seatsToAdd).toBe(390);
  });

  test("per audience: neither reaches 100 on its own", () => {
    const result = price({ seats: [students(60), teachers(50)] });
    expect(seatLine(result, 0).volumeDiscountBps).toBe(0);
    expect(seatLine(result, 1).volumeDiscountBps).toBe(0);
  });

  test("an audience with its own brackets uses them; the others use the general ones", () => {
    const result = price({
      months: 1,
      seats: [students(25), teachers(25)],
      settings: {
        ...SETTINGS,
        volumeBrackets: [
          ...SETTINGS.volumeBrackets,
          { audience: "teacher", minSeats: 1, discountBps: 0 },
          { audience: "teacher", minSeats: 20, discountBps: 500 },
        ],
      },
    });
    expect(seatLine(result, 0).volumeDiscountBps).toBe(0);
    expect(seatLine(result, 1).volumeDiscountBps).toBe(500);
  });
});

describe("credits and the manual adjustment", () => {
  test("overlap credits come off the total, each as its own line", () => {
    const result = price({
      credits: [
        { reference: "overlap-1", description: "Sara: 44 days", amountMinor: 4438 },
        { reference: "overlap-2", description: "Omar: 10 days", amountMinor: 1000 },
      ],
    });
    expect(result.lines.map((line) => [line.kind, line.amountMinor])).toEqual([
      ["seats", 4_374_000],
      ["overlap_credit", -4438],
      ["overlap_credit", -1000],
    ]);
    expect(result.creditTotalMinor).toBe(5438);
    expect(result.totalMinor).toBe(4_368_562);
  });

  test("credits never take the seats below zero", () => {
    const result = price({
      months: 1,
      seats: [students(1)],
      credits: [
        { reference: "a", description: "a", amountMinor: 2500 },
        { reference: "b", description: "b", amountMinor: 1000 },
      ],
    });
    expect(result.lines.slice(1)).toEqual([
      {
        kind: "overlap_credit",
        reference: "a",
        description: "a",
        creditMinor: 2500,
        amountMinor: -2500,
      },
      {
        kind: "overlap_credit",
        reference: "b",
        description: "b",
        creditMinor: 1000,
        amountMinor: -500,
      },
    ]);
    expect(result.totalMinor).toBe(0);
  });

  test("an adjustment with a reason moves the total either way", () => {
    const down = price({ adjustment: { amountMinor: -74_000, reason: "Launch partner" } });
    expect(down.lines.at(-1)).toEqual({
      kind: "adjustment",
      reason: "Launch partner",
      amountMinor: -74_000,
    });
    expect(down.totalMinor).toBe(4_300_000);

    const up = price({ adjustment: { amountMinor: 25_000, reason: "On-site training" } });
    expect(up.totalMinor).toBe(4_399_000);
    // The savings figure is the discounts only.
    expect(up.savingsMinor).toBe(1_026_000);
  });

  test("an adjustment needs a reason", () => {
    expect(() => price({ adjustment: { amountMinor: -100, reason: "  " } })).toThrow(
      expect.objectContaining({ code: "adjustment_reason_required" }),
    );
  });

  test("an adjustment cannot take the total below zero", () => {
    expect(() =>
      price({ months: 1, seats: [students(1)], adjustment: { amountMinor: -3001, reason: "x" } }),
    ).toThrow(expect.objectContaining({ code: "total_negative" }));
    expect(
      price({ months: 1, seats: [students(1)], adjustment: { amountMinor: -3000, reason: "x" } })
        .totalMinor,
    ).toBe(0);
  });
});

describe("Family+ and validation", () => {
  const parents = (seats: number): SeatInput => ({
    audience: "parent",
    tierCode: "family",
    tierName: "Family+",
    seats,
    listPricePerSeatMonthMinor: 1500,
  });

  test("parent seats are priced only on a license that includes Family+", () => {
    expect(() => price({ seats: [students(10), parents(5)] })).toThrow(
      expect.objectContaining({ code: "family_plus_not_included" }),
    );
    const result = price({ includeFamilyPlus: true, seats: [parents(5), students(10)] });
    // Lines come in audience order: students, then parents.
    expect(result.lines.map((line) => (line as SeatLine).audience)).toEqual(["student", "parent"]);
    expect(seatLine(result, 1).listAmountMinor).toBe(90_000);
  });

  test("an audience with no seats has no line", () => {
    const result = price({ seats: [students(0)] });
    expect(result.lines).toEqual([]);
    expect(result.totalMinor).toBe(0);
    expect(result.savingsBps).toBe(0);
  });

  test.each([
    [{ months: 0 }, "invalid_months"],
    [{ months: 1.5 }, "invalid_months"],
    [{ months: 121 }, "invalid_months"],
    [{ prorateDays: 0 }, "invalid_prorate_days"],
    [{ seats: [students(-1)] }, "invalid_seats"],
    [{ seats: [students(1, { listPricePerSeatMonthMinor: 10.5 })] }, "invalid_price"],
    [{ seats: [students(1), students(2)] }, "duplicate_audience"],
    [
      {
        settings: {
          ...SETTINGS,
          volumeBrackets: [
            { audience: null, minSeats: 100, discountBps: 1000 },
            { audience: null, minSeats: 100, discountBps: 2000 },
          ],
        },
      },
      "invalid_bracket",
    ],
    [
      { settings: { ...SETTINGS, durationDiscounts: [{ minMonths: 12, discountBps: 10_001 }] } },
      "invalid_bracket",
    ],
    [{ credits: [{ reference: "x", description: "x", amountMinor: -1 }] }, "invalid_credit"],
  ] as const)("%p is refused with %s", (overrides, code) => {
    let error: unknown;
    try {
      price(overrides as Partial<PricingInput>);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(PricingError);
    expect((error as PricingError).code).toBe(code);
  });
});
