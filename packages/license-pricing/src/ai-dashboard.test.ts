// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import {
  contentBonusAimBps,
  conversionStanding,
  optInsToReach,
  paidPartOf,
  studafyNetOf,
  studentAiMarginOf,
} from "./ai-dashboard";
import { DEFAULT_AI_PROGRAMME_SETTINGS, resolveAiProgramme } from "./ai-programme";
import { computeRevenueShare, ratioBps } from "./revenue-share";

const defaults = resolveAiProgramme(DEFAULT_AI_PROGRAMME_SETTINGS, null, "USD");

describe("optInsToReach", () => {
  test("the fewest opt-ins whose rounded-down ratio reaches the tier", () => {
    // 350 / 500 = 70% exactly: 0 more for 70%, 75 more for 85%.
    expect(optInsToReach(7000, 500, 350)).toBe(0);
    expect(optInsToReach(8500, 500, 350)).toBe(75);
    // 333 enrolled, 55%: 183.15 -> 184 (183/333 = 54.95%, rounded down stays below the tier).
    expect(optInsToReach(5500, 333, 100)).toBe(84);
    expect(ratioBps(183, 333)).toBeLessThan(5500);
    expect(ratioBps(184, 333)).toBeGreaterThanOrEqual(5500);
  });

  test("nobody enrolled, or a target above 100%: no number of opt-ins helps", () => {
    expect(optInsToReach(2500, 0, 0)).toBeNull();
    expect(optInsToReach(10_001, 10, 0)).toBeNull();
  });
});

describe("conversionStanding", () => {
  test("the spec's example: 70% earns 10%, 75 more opt-ins unlock 12%", () => {
    const standing = conversionStanding(defaults, { enrolled: 500, optedIn: 350, seats: 350 });
    expect(standing).toMatchObject({
      conversionBps: 7000,
      tier: { fromBps: 7000, shareBps: 1000 },
      shareBps: 1000,
      floorApplied: false,
      next: { fromBps: 8500, shareBps: 1200, optInsNeeded: 75 },
    });
    // 350 seats: the 500-seat floor (8%) pays less than 10%, so it is not offered.
    expect(standing.floor).toBeNull();
  });

  test("below the floor: the floor is offered with the seats it takes", () => {
    const standing = conversionStanding(defaults, { enrolled: 1000, optedIn: 300, seats: 300 });
    expect(standing.shareBps).toBe(400);
    expect(standing.next).toEqual({ fromBps: 4000, shareBps: 600, optInsNeeded: 100 });
    expect(standing.floor).toEqual({ minSeats: 500, shareBps: 800, seatsNeeded: 200 });
  });

  test("the floor raises the share and tiers it already beats are skipped", () => {
    const standing = conversionStanding(defaults, { enrolled: 2000, optedIn: 600, seats: 600 });
    // 30% earns 4%, the floor 8%: the next step up is 70% -> 10% (40% and 55% pay no more).
    expect(standing).toMatchObject({ conversionBps: 3000, shareBps: 800, floorApplied: true });
    expect(standing.next).toEqual({ fromBps: 7000, shareBps: 1000, optInsNeeded: 800 });
    expect(standing.floor).toBeNull();
  });

  test("at the top there is no next tier; nobody enrolled is 0%", () => {
    expect(conversionStanding(defaults, { enrolled: 100, optedIn: 90, seats: 90 }).next).toBeNull();
    const empty = conversionStanding(defaults, { enrolled: 0, optedIn: 0, seats: 30 });
    expect(empty).toMatchObject({ conversionBps: 0, shareBps: 0, next: null });
  });

  test("agrees with the engine's conversion share", () => {
    for (const [enrolled, optedIn, seats] of [
      [500, 350, 350],
      [1000, 300, 300],
      [2000, 600, 600],
      [333, 183, 183],
    ] as const) {
      const standing = conversionStanding(defaults, { enrolled, optedIn, seats });
      const engine = computeRevenueShare(defaults, {
        conversionBps: ratioBps(optedIn, enrolled),
        uploadConsistencyBps: 0,
        seats,
        commitment: "full_year",
        baseMinor: 0,
      });
      expect(standing.conversionBps).toBe(ratioBps(optedIn, enrolled));
      expect(standing.shareBps).toBe(engine.conversionShareBps);
      expect(standing.floorApplied).toBe(engine.floorApplied);
    }
  });
});

describe("contentBonusAimBps", () => {
  const tiers = defaults.contentBonusTiers;
  test("the next paying tier, or the top one once there", () => {
    expect(contentBonusAimBps(tiers, null)).toBe(6000);
    expect(contentBonusAimBps(tiers, 4000)).toBe(6000);
    expect(contentBonusAimBps(tiers, 6000)).toBe(8000);
    expect(contentBonusAimBps(tiers, 8500)).toBe(8000);
  });
  test("no paying tier: no target", () => {
    expect(contentBonusAimBps([{ fromBps: 0, shareBps: 0 }], 5000)).toBeNull();
  });
});

describe("money", () => {
  test("the worked example: margin $7,000, share $1,820, Studafy keeps $12,180 ($34.80 a seat)", () => {
    expect(studentAiMarginOf(600, 400, 10) * 350).toBe(700_000);
    const share = computeRevenueShare(defaults, {
      conversionBps: 7000,
      uploadConsistencyBps: 8500,
      seats: 350,
      commitment: "full_year",
      baseMinor: 1_400_000,
    });
    expect(share).toMatchObject({ totalBps: 1300, amountMinor: 182_000 });
    expect(studafyNetOf({ collectedMinor: 1_400_000, shareMinor: 182_000, seats: 350 })).toEqual({
      netMinor: 1_218_000,
      perSeatMinor: 3480,
    });
  });

  test("an 8-month year: margin $5,600, share $1,456, Studafy keeps $9,744 ($27.84 a seat)", () => {
    expect(studentAiMarginOf(600, 400, 8) * 350).toBe(560_000);
    const base = 400 * 8 * 350;
    const share = computeRevenueShare(defaults, {
      conversionBps: 7000,
      uploadConsistencyBps: 8500,
      seats: 350,
      commitment: "full_year",
      baseMinor: base,
    });
    expect(share.amountMinor).toBe(145_600);
    expect(studafyNetOf({ collectedMinor: base, shareMinor: 145_600, seats: 350 })).toEqual({
      netMinor: 974_400,
      perSeatMinor: 2784,
    });
  });

  test("a parent price below the licence price is a negative margin", () => {
    expect(studentAiMarginOf(300, 400, 10)).toBe(-1000);
  });

  test("paid part: pro rata half up, all once paid, none unpaid", () => {
    expect(paidPartOf(6000, 0, 10_000)).toBe(0);
    expect(paidPartOf(6000, 10_000, 10_000)).toBe(6000);
    expect(paidPartOf(6000, 5_000, 10_000)).toBe(3000);
    expect(paidPartOf(1, 1, 2)).toBe(1);
    expect(paidPartOf(-2000, 5_000, 10_000)).toBe(-1000);
    expect(paidPartOf(6000, 1, 0)).toBe(0);
  });

  test("no seats: no per-seat figure", () => {
    expect(studafyNetOf({ collectedMinor: 0, shareMinor: 0, seats: 0 })).toEqual({
      netMinor: 0,
      perSeatMinor: null,
    });
  });
});
