// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  aiEntitlement,
  fakeEntitlements,
  fakeFeatureService,
  migratedCatalog,
  SCHOOL_ID,
  schoolEntitlement,
  USER_ID,
  userEntitlement,
} from "./__tests__/fakes";

import type { FeatureCatalog, Tier } from "./catalog";
import type {
  LicenseSeatGrant,
  UserSubscriptionGrant,
} from "../subscriptions/entitlements/resolve";

/**
 * The resolver matrix for school-license seats (session 2 of docs/billing/feature-licensing.md),
 * through the real feature service: a seat covers its holder with the license's tier for their
 * audience, while the license is active and inside its period, and combines with personal
 * subscriptions feature by feature.
 */

const NOW = new Date("2026-11-15T12:00:00Z");
const LICENSE_START = "2026-09-01T00:00:00.000Z";
const LICENSE_END = "2027-08-31T00:00:00.000Z";

function tier(code: string, overrides: Partial<Tier>): Tier {
  return {
    id: `plan-${code}`,
    code,
    audience: "student",
    rank: 1,
    includesAllFeatures: false,
    isActive: true,
    limits: {},
    ...overrides,
  };
}

function catalog(): FeatureCatalog {
  const c = migratedCatalog();
  c.tiers.student_basic = tier("student_basic", { limits: { ai_tutor: 100, study_tools: 20 } });
  c.tiers.student_plus = tier("student_plus", { rank: 2, limits: { ai_tutor: 300, notebook: 30 } });
  // A top teacher tier with no feature rows at all: it includes every teacher feature by default.
  c.tiers.teacher_pro = tier("teacher_pro", { audience: "teacher", includesAllFeatures: true });
  c.tiers.family = tier("family", { audience: "parent", limits: { family_plus: null } });
  return c;
}

function seat(overrides: Partial<LicenseSeatGrant> = {}): LicenseSeatGrant {
  return {
    seatId: "seat-1",
    licenseId: "license-1",
    audience: "student",
    planCode: "student_plus",
    licenseStatus: "active",
    startsAt: LICENSE_START,
    endsAt: LICENSE_END,
    ...overrides,
  };
}

function personal(overrides: Partial<UserSubscriptionGrant> = {}): UserSubscriptionGrant {
  return {
    id: "us-1",
    planCode: "student_basic",
    provider: "app_store",
    status: "active",
    live: true,
    autoRenew: true,
    currentPeriodStart: "2026-11-01T00:00:00.000Z",
    currentPeriodEnd: "2026-12-01T00:00:00.000Z",
    ...overrides,
  };
}

async function resolve(input: {
  seats?: LicenseSeatGrant[];
  subscriptions?: UserSubscriptionGrant[];
  schoolActive?: boolean;
  studentId?: string | null;
  now?: Date;
}) {
  const service = fakeFeatureService({
    catalog: catalog(),
    entitlements: fakeEntitlements({
      school: schoolEntitlement(input.schoolActive ?? true),
      ai: aiEntitlement(null),
      user: userEntitlement({
        studentId: input.studentId === undefined ? "student-1" : input.studentId,
        seats: input.seats ?? [],
        subscriptions: input.subscriptions ?? [],
      }),
    }),
  });
  return (await service.resolve(SCHOOL_ID, { userId: USER_ID }, { now: input.now ?? NOW }))
    .features;
}

describe("school-license seats in the resolver", () => {
  test("a seat on an active license covers its holder with the tier for their audience", async () => {
    const features = await resolve({ seats: [seat()] });

    expect(features.ai_tutor).toMatchObject({
      active: true,
      source: "school_license",
      limit: 300,
      periodStart: LICENSE_START,
      periodEnd: LICENSE_END,
    });
    expect(features.notebook).toMatchObject({ active: true, limit: 30 });
    // student_plus does not include study_tools.
    expect(features.study_tools).toMatchObject({ active: false, reason: "not_included" });
  });

  test("no seat, no coverage", async () => {
    const features = await resolve({});

    expect(features.ai_tutor).toMatchObject({ active: false, reason: "not_included" });
  });

  for (const status of ["expired", "cancelled", "suspended"] as const) {
    test(`a seat on a ${status} license covers nothing and reads expired`, async () => {
      const features = await resolve({ seats: [seat({ licenseStatus: status })] });

      expect(features.ai_tutor).toMatchObject({
        active: false,
        reason: "expired",
        periodEnd: LICENSE_END,
      });
    });
  }

  test("an active license stops covering at its end date, before any expiry job runs", async () => {
    const features = await resolve({
      seats: [seat()],
      now: new Date("2027-08-31T00:00:01Z"),
    });

    expect(features.ai_tutor).toMatchObject({ active: false, reason: "expired" });
  });

  test("an active license that has not started yet covers nobody", async () => {
    const features = await resolve({
      seats: [seat({ startsAt: "2026-12-01T00:00:00.000Z" })],
    });

    expect(features.ai_tutor).toMatchObject({ active: false, reason: "not_included" });
  });

  test("a personal subscription alone covers as a purchase", async () => {
    const features = await resolve({ subscriptions: [personal()] });

    expect(features.ai_tutor).toMatchObject({ active: true, source: "purchase", limit: 100 });
    expect(features.study_tools).toMatchObject({ active: true, source: "purchase", limit: 20 });
  });

  test("a personal subscription and a seat: the best of both, feature by feature", async () => {
    const features = await resolve({ seats: [seat()], subscriptions: [personal()] });

    // Both include ai_tutor: the higher limit (300 from the seat), the later end (the license).
    expect(features.ai_tutor).toMatchObject({
      active: true,
      limit: 300,
      source: "school_license",
      periodEnd: LICENSE_END,
    });
    expect(features.ai_tutor.sources.map((s) => [s.source, s.tierCode, s.limit])).toEqual([
      ["school_license", "student_plus", 300],
      ["purchase", "student_basic", 100],
    ]);
    // Only the personal tier includes study_tools; only the seat's includes notebook.
    expect(features.study_tools).toMatchObject({ active: true, source: "purchase", limit: 20 });
    expect(features.notebook).toMatchObject({ active: true, source: "school_license", limit: 30 });
  });

  test("when the personal subscription has ended, the seat carries on with no gap", async () => {
    const features = await resolve({
      seats: [seat()],
      subscriptions: [personal({ status: "canceled", live: false })],
    });

    expect(features.ai_tutor).toMatchObject({ active: true, source: "school_license", limit: 300 });
    expect(features.ai_tutor.sources).toHaveLength(1);
  });

  test("a Family+ parent seat gives the parent Family+", async () => {
    const features = await resolve({
      studentId: null,
      seats: [seat({ audience: "parent", planCode: "family" })],
    });

    expect(features.family_plus).toMatchObject({
      active: true,
      source: "school_license",
      limit: null,
    });
    expect(features.ai_tutor.active).toBe(false);
  });

  test("an inactive school covers nobody, seat or not", async () => {
    const features = await resolve({ seats: [seat()], schoolActive: false });

    expect(features.ai_tutor).toMatchObject({ active: false, reason: "school_inactive" });
  });

  test("a tier with includes_all_features picks up a feature it has no row for", async () => {
    const features = await resolve({
      studentId: null,
      seats: [seat({ audience: "teacher", planCode: "teacher_pro" })],
    });

    // auto_grading was never added to teacher_pro: it comes with the tier at the code default.
    expect(features.auto_grading).toMatchObject({
      active: true,
      source: "school_license",
      limit: 500,
    });
    // Only the tier's own audience.
    expect(features.ai_tutor.active).toBe(false);
  });

  test("a seat whose audience has no tier on the license covers nothing", async () => {
    const features = await resolve({ seats: [seat({ planCode: null })] });

    expect(features.ai_tutor).toMatchObject({ active: false, reason: "not_included" });
  });
});
