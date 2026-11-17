// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_AI_PROGRAMME_SETTINGS,
  EMPTY_AI_PROGRAMME_OVERRIDE,
  aiProgrammeChanges,
  isEmptyAiProgrammeOverride,
  nextTierFor,
  previewRevenueShare,
  resolveAiProgramme,
  schoolMarginOf,
  tierFor,
  validateAiProgrammeOverride,
  validateAiProgrammeSettings,
} from "./ai-programme";

import type { AiProgrammeOverride, AiProgrammeSettings } from "./ai-programme";

const G = DEFAULT_AI_PROGRAMME_SETTINGS;
const override = (fields: Partial<AiProgrammeOverride>): AiProgrammeOverride => ({
  ...EMPTY_AI_PROGRAMME_OVERRIDE,
  ...fields,
});
const codes = (issues: { field: string; code: string }[]) =>
  issues.map((i) => `${i.field}:${i.code}`);

describe("defaults", () => {
  test("the approved defaults are valid and in USD minor units / basis points", () => {
    expect(validateAiProgrammeSettings(G)).toEqual([]);
    // The owner's prices (2026-11-18): in-app $5.99 (reference), school-offer $4, licence $4.
    expect(G.prices).toEqual([
      { currencyCode: "USD", iapPriceMinor: 599, licensePriceMinor: 400, parentPriceMinor: 400 },
    ]);
    expect(G.maxShareBps).toBe(1500);
    expect(G.conversionTiers.map((t) => [t.fromBps, t.shareBps])).toEqual([
      [0, 0],
      [2500, 400],
      [4000, 600],
      [5500, 800],
      [7000, 1000],
      [8500, 1200],
    ]);
    expect(G.contentBonusTiers.map((t) => [t.fromBps, t.shareBps])).toEqual([
      [0, 0],
      [6000, 150],
      [8000, 300],
    ]);
  });
});

describe("resolveAiProgramme", () => {
  test("no override: the global values for the currency", () => {
    const r = resolveAiProgramme(G, null, "USD");
    expect(r.licensePriceMinor).toBe(400);
    expect(r.parentPriceMinor).toBe(400);
    expect(r.iapPriceMinor).toBe(599);
    expect(r.overridden).toEqual([]);
    expect(r.nonpaymentGraceDays).toBe(30);
  });

  test("the school's value wins wherever it sets one, and only there", () => {
    const r = resolveAiProgramme(
      G,
      override({
        minSeats: 50,
        maxShareBps: 2000,
        conversionTiers: [
          { fromBps: 2000, shareBps: 500 },
          { fromBps: 0, shareBps: 0 },
        ],
        nonpaymentGraceDays: 45,
        payoutMode: "payout",
      }),
      "USD",
    );
    expect(r.minSeats).toBe(50);
    expect(r.maxShareBps).toBe(2000);
    // Sorted by threshold.
    expect(r.conversionTiers).toEqual([
      { fromBps: 0, shareBps: 0 },
      { fromBps: 2000, shareBps: 500 },
    ]);
    expect(r.contentBonusTiers).toEqual([...G.contentBonusTiers]);
    expect(r.nonpaymentGraceDays).toBe(45);
    expect(r.payoutMode).toBe("payout");
    expect(r.measurementOffsetDays).toBe(30);
    expect(r.overridden).toEqual([
      "minSeats",
      "maxShareBps",
      "conversionTiers",
      "nonpaymentGraceDays",
      "payoutMode",
    ]);
  });

  test("an override's prices count only in their own currency", () => {
    const o = override({ priceCurrencyCode: "USD", licensePriceMinor: 350, parentPriceMinor: 500 });
    const usd = resolveAiProgramme(G, o, "USD");
    expect([usd.licensePriceMinor, usd.parentPriceMinor]).toEqual([350, 500]);
    expect(usd.iapPriceMinor).toBe(599);
    expect(usd.overridden).toEqual(["licensePriceMinor", "parentPriceMinor"]);

    const eur = resolveAiProgramme(G, o, "EUR");
    expect([eur.iapPriceMinor, eur.licensePriceMinor, eur.parentPriceMinor]).toEqual([
      null,
      null,
      null,
    ]);
    expect(eur.overridden).toEqual([]);
  });

  test("a currency the global version does not price can be priced by the school", () => {
    const r = resolveAiProgramme(
      G,
      override({ priceCurrencyCode: "KWD", licensePriceMinor: 1200, parentPriceMinor: 1800 }),
      "KWD",
    );
    expect([r.iapPriceMinor, r.licensePriceMinor, r.parentPriceMinor]).toEqual([null, 1200, 1800]);
  });

  test("an empty override is recognised and changes nothing", () => {
    expect(isEmptyAiProgrammeOverride(EMPTY_AI_PROGRAMME_OVERRIDE)).toBe(true);
    expect(isEmptyAiProgrammeOverride(override({ minSeats: 1 }))).toBe(false);
    expect(
      aiProgrammeChanges(
        resolveAiProgramme(G, null, "USD"),
        resolveAiProgramme(G, EMPTY_AI_PROGRAMME_OVERRIDE, "USD"),
      ),
    ).toEqual([]);
  });

  test("aiProgrammeChanges names every field that differs", () => {
    const next: AiProgrammeSettings = {
      ...G,
      prices: [{ ...G.prices[0]!, iapPriceMinor: 700 }],
      contentBonusTiers: [{ fromBps: 0, shareBps: 0 }],
    };
    expect(
      aiProgrammeChanges(resolveAiProgramme(G, null, "USD"), resolveAiProgramme(next, null, "USD")),
    ).toEqual(["iapPriceMinor", "contentBonusTiers"]);
  });
});

describe("validateAiProgrammeSettings", () => {
  test("percentages, prices, seats and days out of range", () => {
    const bad: AiProgrammeSettings = {
      ...G,
      prices: [
        { currencyCode: "USD", iapPriceMinor: -1, licensePriceMinor: 0, parentPriceMinor: 0 },
      ],
      minSeats: 0,
      maxShareBps: 10_001,
      measurementOffsetDays: 366,
      nonpaymentGraceDays: 0,
      monthToMonthShareBps: 1.5,
    };
    expect(codes(validateAiProgrammeSettings(bad))).toEqual([
      "prices:out_of_range",
      "minSeats:out_of_range",
      "maxShareBps:out_of_range",
      "measurementOffsetDays:out_of_range",
      "nonpaymentGraceDays:out_of_range",
      "monthToMonthShareBps:out_of_range",
    ]);
  });

  test("tiers start at 0%, rise strictly, never lower a share, and fit under the maximum", () => {
    const check = (tiers: { fromBps: number; shareBps: number }[]) =>
      codes(validateAiProgrammeSettings({ ...G, conversionTiers: tiers }));
    expect(check([{ fromBps: 100, shareBps: 0 }])).toEqual(["conversionTiers:tiers_invalid"]);
    expect(
      check([
        { fromBps: 0, shareBps: 0 },
        { fromBps: 0, shareBps: 100 },
      ]),
    ).toEqual(["conversionTiers:tiers_invalid"]);
    expect(
      check([
        { fromBps: 0, shareBps: 500 },
        { fromBps: 2000, shareBps: 400 },
      ]),
    ).toEqual(["conversionTiers:tiers_invalid"]);
    expect(
      check([
        { fromBps: 0, shareBps: 0 },
        { fromBps: 5000, shareBps: 1600 },
      ]),
    ).toEqual(["conversionTiers:share_above_max"]);
    expect(check([])).toEqual(["conversionTiers:tiers_invalid"]);
    expect(
      check(Array.from({ length: 21 }, (_, i) => ({ fromBps: i * 100, shareBps: 0 }))),
    ).toEqual(["conversionTiers:tiers_invalid"]);
  });

  test("the floor and the bonus fit under the maximum", () => {
    expect(
      codes(
        validateAiProgrammeSettings({
          ...G,
          largeSchoolShareBps: 1600,
          contentBonusTiers: [
            { fromBps: 0, shareBps: 0 },
            { fromBps: 5000, shareBps: 1501 },
          ],
        }),
      ),
    ).toEqual(["contentBonusTiers:share_above_max", "largeSchoolShareBps:share_above_max"]);
  });

  test("prices: at least one currency, each once", () => {
    expect(codes(validateAiProgrammeSettings({ ...G, prices: [] }))).toEqual([
      "prices:currency_invalid",
    ]);
    expect(
      codes(validateAiProgrammeSettings({ ...G, prices: [G.prices[0]!, G.prices[0]!] })),
    ).toEqual(["prices:currency_invalid"]);
  });

  test("parents may pay the licence price or less: no validation, only a margin to warn about", () => {
    const equal = {
      ...G,
      prices: [{ ...G.prices[0]!, licensePriceMinor: 400, parentPriceMinor: 400 }],
    };
    const below = {
      ...G,
      prices: [{ ...G.prices[0]!, licensePriceMinor: 400, parentPriceMinor: 0 }],
    };
    expect(validateAiProgrammeSettings(equal)).toEqual([]);
    expect(validateAiProgrammeSettings(below)).toEqual([]);
    const above = {
      ...G,
      prices: [{ ...G.prices[0]!, licensePriceMinor: 400, parentPriceMinor: 600 }],
    };
    expect(schoolMarginOf(resolveAiProgramme(above, null, "USD"))).toBe("positive");
    // The defaults: parents $4 = the licence $4, so the school keeps no margin.
    expect(schoolMarginOf(resolveAiProgramme(G, null, "USD"))).toBe("none");
    expect(schoolMarginOf(resolveAiProgramme(equal, null, "USD"))).toBe("none");
    expect(schoolMarginOf(resolveAiProgramme(below, null, "USD"))).toBe("below_cost");
    expect(schoolMarginOf(resolveAiProgramme(G, null, "EUR"))).toBeNull();
  });
});

describe("validateAiProgrammeOverride", () => {
  test("an empty override, or one in range, is valid", () => {
    expect(validateAiProgrammeOverride(EMPTY_AI_PROGRAMME_OVERRIDE, G)).toEqual([]);
    expect(
      validateAiProgrammeOverride(
        override({ priceCurrencyCode: "USD", licensePriceMinor: 400, parentPriceMinor: 400 }),
        G,
      ),
    ).toEqual([]);
  });

  test("prices need their currency, and a currency needs prices", () => {
    expect(codes(validateAiProgrammeOverride(override({ licensePriceMinor: 100 }), G))).toEqual([
      "priceCurrencyCode:currency_invalid",
    ]);
    expect(codes(validateAiProgrammeOverride(override({ priceCurrencyCode: "USD" }), G))).toEqual([
      "priceCurrencyCode:currency_invalid",
    ]);
  });

  test("a lower maximum must still hold the global tiers the school keeps", () => {
    expect(codes(validateAiProgrammeOverride(override({ maxShareBps: 1000 }), G))).toEqual([
      "conversionTiers:share_above_max",
    ]);
    // Lowering the tiers with it is fine.
    expect(
      validateAiProgrammeOverride(
        override({
          maxShareBps: 1000,
          conversionTiers: [
            { fromBps: 0, shareBps: 0 },
            { fromBps: 5000, shareBps: 700 },
          ],
          largeSchoolShareBps: 700,
        }),
        G,
      ),
    ).toEqual([]);
  });
});

describe("tiers and the share preview", () => {
  test("tierFor and nextTierFor", () => {
    expect(tierFor(G.conversionTiers, 3999)?.shareBps).toBe(400);
    expect(tierFor(G.conversionTiers, 4000)?.shareBps).toBe(600);
    expect(tierFor([{ fromBps: 100, shareBps: 1 }], 50)).toBeNull();
    expect(nextTierFor(G.conversionTiers, 7000)).toEqual({ fromBps: 8500, shareBps: 1200 });
    expect(nextTierFor(G.conversionTiers, 9000)).toBeNull();
  });

  test("the plan's worked example: 70% conversion, 85% uploads -> 10% + 3% = 13%", () => {
    const r = resolveAiProgramme(G, null, "USD");
    expect(
      previewRevenueShare(r, {
        conversionBps: 7000,
        uploadConsistencyBps: 8500,
        seats: 350,
        fullYear: true,
      }),
    ).toEqual({
      conversionShareBps: 1000,
      floorApplied: false,
      bonusBps: 300,
      totalBps: 1300,
      capped: false,
    });
  });

  test("the large-school floor, the bonus rule, the cap and month-to-month", () => {
    const r = resolveAiProgramme(G, null, "USD");
    // Under 25%: no share, so no bonus either.
    expect(
      previewRevenueShare(r, {
        conversionBps: 2000,
        uploadConsistencyBps: 9000,
        seats: 100,
        fullYear: true,
      }).totalBps,
    ).toBe(0);
    // 500+ seats: at least 8%, and then the bonus counts.
    const floored = previewRevenueShare(r, {
      conversionBps: 2000,
      uploadConsistencyBps: 9000,
      seats: 500,
      fullYear: true,
    });
    expect(floored).toMatchObject({ conversionShareBps: 800, floorApplied: true, totalBps: 1100 });
    // 85%+ and 80%+ uploads: 12% + 3% = 15%, exactly the cap.
    const top = previewRevenueShare(r, {
      conversionBps: 9000,
      uploadConsistencyBps: 9000,
      seats: 100,
      fullYear: true,
    });
    expect(top).toMatchObject({ totalBps: 1500, capped: false });
    const lowerCap = previewRevenueShare(
      { ...r, maxShareBps: 1400 },
      { conversionBps: 9000, uploadConsistencyBps: 9000, seats: 100, fullYear: true },
    );
    expect(lowerCap).toMatchObject({ totalBps: 1400, capped: true });
    // Month-to-month: 0% by default, half when set to 5000.
    const input = { conversionBps: 7000, uploadConsistencyBps: 8500, seats: 350, fullYear: false };
    expect(previewRevenueShare(r, input).totalBps).toBe(0);
    expect(previewRevenueShare({ ...r, monthToMonthShareBps: 5000 }, input).totalBps).toBe(650);
    // Bonus without a conversion share when the rule is off.
    expect(
      previewRevenueShare(
        { ...r, bonusRequiresConversionShare: false },
        { conversionBps: 0, uploadConsistencyBps: 9000, seats: 10, fullYear: true },
      ).totalBps,
    ).toBe(300);
  });
});
