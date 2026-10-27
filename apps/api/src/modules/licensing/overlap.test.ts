// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { computeOverlapCredit, renewalActionFor } from "./overlap";

const at = (iso: string) => new Date(iso);

describe("computeOverlapCredit", () => {
  // A 10.000 JOD seat (3 decimals: 10000 minor) a month is 10000 x 12 / 365 = 328.767123 a day.
  const monthly = 10_000;

  test("credits the days the personal period and the seat both cover, at the daily seat price", () => {
    const credit = computeOverlapCredit({
      now: at("2026-11-01T00:00:00Z"),
      licenseStartsAt: at("2026-09-01T00:00:00Z"),
      licenseEndsAt: at("2027-08-31T00:00:00Z"),
      personalPeriodEnd: at("2026-11-21T00:00:00Z"),
      monthlySeatPriceMinor: monthly,
      paid: true,
    });

    expect(credit).toEqual({
      overlapStartsAt: at("2026-11-01T00:00:00Z"),
      overlapEndsAt: at("2026-11-21T00:00:00Z"),
      overlapDays: 20,
      monthlySeatPriceMinor: 10_000,
      dailySeatPriceMinor: 328.767123,
      // 20 x 328.767123... = 6575.34 -> 6575
      creditMinor: 6575,
    });
  });

  test("a partial day counts as a whole day", () => {
    const credit = computeOverlapCredit({
      now: at("2026-11-01T12:00:00Z"),
      licenseStartsAt: at("2026-09-01T00:00:00Z"),
      licenseEndsAt: at("2027-08-31T00:00:00Z"),
      personalPeriodEnd: at("2026-11-03T13:00:00Z"),
      monthlySeatPriceMinor: monthly,
      paid: true,
    });

    expect(credit.overlapDays).toBe(3);
    expect(credit.creditMinor).toBe(Math.round(3 * ((monthly * 12) / 365)));
  });

  test("starts at the license start when the seat is assigned before it", () => {
    const credit = computeOverlapCredit({
      now: at("2026-08-20T00:00:00Z"),
      licenseStartsAt: at("2026-09-01T00:00:00Z"),
      licenseEndsAt: at("2027-08-31T00:00:00Z"),
      personalPeriodEnd: at("2026-09-11T00:00:00Z"),
      monthlySeatPriceMinor: monthly,
      paid: true,
    });

    expect(credit.overlapStartsAt).toEqual(at("2026-09-01T00:00:00Z"));
    expect(credit.overlapDays).toBe(10);
  });

  test("is capped at the license end", () => {
    const credit = computeOverlapCredit({
      now: at("2027-08-01T00:00:00Z"),
      licenseStartsAt: at("2026-09-01T00:00:00Z"),
      licenseEndsAt: at("2027-08-11T00:00:00Z"),
      personalPeriodEnd: at("2027-09-01T00:00:00Z"),
      monthlySeatPriceMinor: monthly,
      paid: true,
    });

    expect(credit.overlapEndsAt).toEqual(at("2027-08-11T00:00:00Z"));
    expect(credit.overlapDays).toBe(10);
  });

  test("no overlap when the personal period ends before the license starts", () => {
    const credit = computeOverlapCredit({
      now: at("2026-08-01T00:00:00Z"),
      licenseStartsAt: at("2026-09-01T00:00:00Z"),
      licenseEndsAt: at("2027-08-31T00:00:00Z"),
      personalPeriodEnd: at("2026-08-15T00:00:00Z"),
      monthlySeatPriceMinor: monthly,
      paid: true,
    });

    expect(credit.overlapDays).toBe(0);
    expect(credit.creditMinor).toBe(0);
  });

  test("a trial earns no credit, but the price is still recorded", () => {
    const credit = computeOverlapCredit({
      now: at("2026-11-01T00:00:00Z"),
      licenseStartsAt: at("2026-09-01T00:00:00Z"),
      licenseEndsAt: at("2027-08-31T00:00:00Z"),
      personalPeriodEnd: at("2026-11-08T00:00:00Z"),
      monthlySeatPriceMinor: monthly,
      paid: false,
    });

    expect(credit).toMatchObject({ overlapDays: 7, monthlySeatPriceMinor: 10_000, creditMinor: 0 });
  });

  test("a tier with no price in the license currency records the days but no amount", () => {
    const credit = computeOverlapCredit({
      now: at("2026-11-01T00:00:00Z"),
      licenseStartsAt: at("2026-09-01T00:00:00Z"),
      licenseEndsAt: at("2027-08-31T00:00:00Z"),
      personalPeriodEnd: at("2026-11-08T00:00:00Z"),
      monthlySeatPriceMinor: null,
      paid: true,
    });

    expect(credit).toMatchObject({
      overlapDays: 7,
      monthlySeatPriceMinor: null,
      dailySeatPriceMinor: null,
      creditMinor: null,
    });
  });
});

describe("renewalActionFor", () => {
  test("Stripe, Tap and Google Play are cancelled at period end; the App Store is notified", () => {
    expect(renewalActionFor("stripe", true)).toBe("cancel_at_period_end");
    expect(renewalActionFor("tap", true)).toBe("cancel_at_period_end");
    expect(renewalActionFor("google_play", true)).toBe("cancel_at_period_end");
    expect(renewalActionFor("app_store", true)).toBe("notify_user");
  });

  test("nothing to do when renewal is already off or the provider is unknown", () => {
    expect(renewalActionFor("stripe", false)).toBe("none");
    expect(renewalActionFor("app_store", false)).toBe("none");
    expect(renewalActionFor(null, true)).toBe("none");
  });
});
