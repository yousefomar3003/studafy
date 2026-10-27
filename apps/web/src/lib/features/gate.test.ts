// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { feature, features, grant } from "../test/feature-fixtures";

import { featureErrorMessageKey, featureGateState, usageResetsOn } from "./gate";

import type { MyFeature } from "./gate";

/**
 * The web gate decides the same states as the mobile one, from the same `GET /api/me/features`
 * verdict: covered (personal / school / both, with the renewal stop and App Store steps), limit
 * reached, ask the school (never a purchase for a seat holder), purchasable, school inactive,
 * paused -- and the friendly messages for refusal codes.
 */

const NOW = new Date("2026-10-27T09:00:00.000Z");

const gate = (f: MyFeature) => featureGateState(features([f]), "ai_tutor", NOW);

describe("featureGateState", () => {
  test("covered by a seat: provided by the school, with usage", () => {
    expect(
      gate(
        feature({
          active: true,
          reason: null,
          sources: [grant("school_license", undefined, 300)],
          limit: 300,
          used: 40,
          schoolSeat: true,
        }),
      ),
    ).toEqual({
      kind: "covered",
      coverage: "school",
      schoolName: "Alpha Academy",
      used: 40,
      limit: 300,
      limitReached: false,
      resetsOn: "2026-11-01",
      personalEndsAt: null,
      mustTurnOffAppStoreRenewal: false,
    });
  });

  test("covered personally", () => {
    expect(
      gate(feature({ active: true, reason: null, sources: [grant("purchase")] })),
    ).toMatchObject({ kind: "covered", coverage: "personal" });
  });

  test("covered by both: the personal end date; App Store renewal is theirs to stop", () => {
    const tap = gate(
      feature({
        active: true,
        reason: null,
        sources: [grant("school_license"), grant("purchase", "2026-11-20T00:00:00.000Z")],
        schoolSeat: true,
        renewalStop: { provider: "tap", action: "cancel_at_period_end", status: "done" },
      }),
    );
    expect(tap).toMatchObject({
      kind: "covered",
      coverage: "both",
      personalEndsAt: "2026-11-20T00:00:00.000Z",
      mustTurnOffAppStoreRenewal: false,
    });
    const apple = gate(
      feature({
        active: true,
        reason: null,
        sources: [grant("school_license"), grant("purchase")],
        schoolSeat: true,
        renewalStop: { provider: "app_store", action: "notify_user", status: "notified" },
      }),
    );
    expect(apple).toMatchObject({ mustTurnOffAppStoreRenewal: true });
  });

  test("limit reached: still covered, resets on the 1st", () => {
    expect(
      gate(
        feature({
          active: true,
          reason: "limit_reached",
          sources: [grant("school_license")],
          limit: 300,
          used: 300,
        }),
      ),
    ).toMatchObject({ kind: "covered", limitReached: true, resetsOn: "2026-11-01" });
  });

  test("the school sells a seat with it: ask the school", () => {
    expect(gate(feature({ schoolOffers: true }))).toEqual({
      kind: "askSchool",
      schoolName: "Alpha Academy",
      hasSeat: false,
    });
  });

  test("a seat holder whose tier lacks it is never purchasable", () => {
    expect(gate(feature({ schoolSeat: true }))).toMatchObject({ kind: "askSchool", hasSeat: true });
  });

  test("nothing from the school: purchasable, with when access ended", () => {
    expect(gate(feature())).toEqual({ kind: "purchasable", expiredOn: null });
    expect(gate(feature({ reason: "expired", periodEnd: "2026-10-01T00:00:00.000Z" }))).toEqual({
      kind: "purchasable",
      expiredOn: "2026-10-01T00:00:00.000Z",
    });
  });

  test("school inactive, paused, and not listed", () => {
    expect(gate(feature({ reason: "school_inactive", schoolOffers: true }))).toEqual({
      kind: "schoolInactive",
    });
    expect(gate(feature({ reason: "paused" }))).toEqual({ kind: "unavailable" });
    expect(featureGateState(features([]), "notebook", NOW)).toEqual({ kind: "unavailable" });
  });
});

test("usage resets on the 1st of next month, across a year end", () => {
  expect(usageResetsOn(new Date("2026-12-31T23:00:00.000Z"))).toBe("2027-01-01");
});

test("refusal codes map to friendly messages", () => {
  expect(featureErrorMessageKey("FEATURE_NOT_INCLUDED")).toBe("site.features.errors.notIncluded");
  expect(featureErrorMessageKey("FEATURE_EXPIRED")).toBe("site.features.errors.expired");
  expect(featureErrorMessageKey("FEATURE_LIMIT_REACHED")).toBe("site.features.errors.limitReached");
  expect(featureErrorMessageKey("AI_SCHOOL_INACTIVE")).toBe("site.features.errors.schoolInactive");
  expect(featureErrorMessageKey("AI_SUBSCRIPTION_COVERED_BY_SCHOOL")).toBe(
    "site.features.errors.coveredBySchool",
  );
  expect(featureErrorMessageKey("SOMETHING_ELSE")).toBeNull();
});
