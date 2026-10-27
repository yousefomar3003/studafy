// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { migratedCatalog } from "./__tests__/fakes";
import {
  resolveFeatureAccess,
  secondsUntilNextUsagePeriod,
  tierIncludes,
  usagePeriodStart,
} from "./resolve";

import type { FeatureCatalog, Tier } from "./catalog";
import type { FeatureGrant } from "./resolve";

function tier(code: string, overrides: Partial<Tier> = {}): Tier {
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

function catalogWith(...tiers: Tier[]): FeatureCatalog {
  const catalog = migratedCatalog();
  for (const t of tiers) catalog.tiers[t.code] = t;
  return catalog;
}

function grant(tierCode: string, overrides: Partial<FeatureGrant> = {}): FeatureGrant {
  return {
    source: "purchase",
    tierCode,
    live: true,
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd: "2026-08-31T00:00:00.000Z",
    ref: `test:${tierCode}`,
    ...overrides,
  };
}

describe("resolveFeatureAccess: the AI add-on tier", () => {
  test("a live add-on makes ai_tutor, study_tools and notebook active and unlimited", () => {
    const features = resolveFeatureAccess({
      catalog: migratedCatalog(),
      grants: [grant("ai_addon")],
      schoolActive: true,
    });

    for (const key of ["ai_tutor", "study_tools", "notebook"] as const) {
      expect(features[key]).toMatchObject({
        active: true,
        source: "purchase",
        limit: null,
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T00:00:00.000Z",
        reason: null,
      });
    }
    expect(features.auto_grading).toMatchObject({ active: false, reason: "not_included" });
    expect(features.family_plus).toMatchObject({ active: false, reason: "not_included" });
  });

  test("an inactive school turns everything off, whatever the grants", () => {
    const features = resolveFeatureAccess({
      catalog: migratedCatalog(),
      grants: [grant("ai_addon")],
      schoolActive: false,
    });

    expect(features.ai_tutor).toMatchObject({
      active: false,
      reason: "school_inactive",
      source: null,
    });
  });

  test("a lapsed add-on reads expired, with the window that ended", () => {
    const features = resolveFeatureAccess({
      catalog: migratedCatalog(),
      grants: [grant("ai_addon", { live: false })],
      schoolActive: true,
    });

    expect(features.study_tools).toMatchObject({
      active: false,
      reason: "expired",
      periodEnd: "2026-08-31T00:00:00.000Z",
    });
  });

  test("no grant at all reads not_included", () => {
    const features = resolveFeatureAccess({
      catalog: migratedCatalog(),
      grants: [],
      schoolActive: true,
    });

    expect(features.ai_tutor).toMatchObject({ active: false, reason: "not_included" });
  });

  test("a trial reports source trial", () => {
    const features = resolveFeatureAccess({
      catalog: migratedCatalog(),
      grants: [grant("ai_addon", { source: "trial" })],
      schoolActive: true,
    });

    expect(features.ai_tutor).toMatchObject({ active: true, source: "trial" });
  });

  test("a paused feature is refused even to a holder", () => {
    const catalog = migratedCatalog();
    catalog.settings.ai_tutor = { displayName: "AI tutor", status: "paused" };

    const features = resolveFeatureAccess({
      catalog,
      grants: [grant("ai_addon")],
      schoolActive: true,
    });

    expect(features.ai_tutor).toMatchObject({ active: false, reason: "paused" });
    expect(features.study_tools.active).toBe(true);
  });

  test("a hidden feature still works for its holders", () => {
    const catalog = migratedCatalog();
    catalog.settings.notebook = { displayName: "Notebook", status: "hidden" };

    const features = resolveFeatureAccess({
      catalog,
      grants: [grant("ai_addon")],
      schoolActive: true,
    });

    expect(features.notebook.active).toBe(true);
  });

  test("a grant naming an unknown tier covers nothing", () => {
    const features = resolveFeatureAccess({
      catalog: migratedCatalog(),
      grants: [grant("no_such_tier")],
      schoolActive: true,
    });

    expect(features.ai_tutor).toMatchObject({ active: false, reason: "not_included" });
  });
});

describe("resolveFeatureAccess: several grants, best of each feature", () => {
  const basic = tier("student_basic", { limits: { ai_tutor: 100, study_tools: 20 } });
  const plus = tier("student_plus", {
    rank: 2,
    limits: { ai_tutor: 300, notebook: 10 },
  });

  test("active if any grant includes it, the highest limit, the latest end, every source", () => {
    const features = resolveFeatureAccess({
      catalog: catalogWith(basic, plus),
      grants: [
        grant("student_basic", { periodEnd: "2026-09-30T00:00:00.000Z" }),
        grant("student_plus", {
          source: "school_license",
          periodStart: "2026-01-01T00:00:00.000Z",
          periodEnd: "2026-12-31T00:00:00.000Z",
        }),
      ],
      schoolActive: true,
      usage: { ai_tutor: 150 },
    });

    expect(features.ai_tutor).toMatchObject({
      active: true,
      limit: 300,
      used: 150,
      source: "school_license",
      periodStart: "2026-01-01T00:00:00.000Z",
      periodEnd: "2026-12-31T00:00:00.000Z",
      reason: null,
    });
    expect(features.ai_tutor.sources).toEqual([
      {
        source: "school_license",
        tierCode: "student_plus",
        limit: 300,
        periodEnd: "2026-12-31T00:00:00.000Z",
      },
      {
        source: "purchase",
        tierCode: "student_basic",
        limit: 100,
        periodEnd: "2026-09-30T00:00:00.000Z",
      },
    ]);
    // Only basic includes study_tools; only plus includes notebook.
    expect(features.study_tools).toMatchObject({ active: true, limit: 20, source: "purchase" });
    expect(features.notebook).toMatchObject({ active: true, limit: 10, source: "school_license" });
  });

  test("unlimited beats any number", () => {
    const features = resolveFeatureAccess({
      catalog: catalogWith(basic),
      grants: [grant("student_basic"), grant("ai_addon")],
      schoolActive: true,
    });

    expect(features.ai_tutor.limit).toBeNull();
    expect(features.ai_tutor.sources).toHaveLength(2);
  });

  test("an ended grant does not contribute while a live one covers the feature", () => {
    const features = resolveFeatureAccess({
      catalog: catalogWith(plus),
      grants: [
        grant("student_plus", { live: false, periodEnd: "2027-01-01T00:00:00.000Z" }),
        grant("ai_addon"),
      ],
      schoolActive: true,
    });

    expect(features.ai_tutor).toMatchObject({ active: true, source: "purchase", limit: null });
    expect(features.ai_tutor.sources.map((s) => s.tierCode)).toEqual(["ai_addon"]);
  });

  test("usage at the limit stays active and reports limit_reached", () => {
    const features = resolveFeatureAccess({
      catalog: catalogWith(basic),
      grants: [grant("student_basic")],
      schoolActive: true,
      usage: { study_tools: 20 },
    });

    expect(features.study_tools).toMatchObject({ active: true, used: 20, reason: "limit_reached" });
  });
});

describe("tierIncludes", () => {
  test("an explicit row wins, including an explicit unlimited", () => {
    expect(tierIncludes(tier("t", { limits: { ai_tutor: 5 } }), "ai_tutor")).toEqual({
      included: true,
      limit: 5,
    });
    expect(tierIncludes(tier("t", { limits: { ai_tutor: null } }), "ai_tutor")).toEqual({
      included: true,
      limit: null,
    });
  });

  test("includes_all_features picks up its audience's features at the code default", () => {
    const pro = tier("student_pro", { includesAllFeatures: true, limits: { ai_tutor: 1000 } });

    expect(tierIncludes(pro, "ai_tutor")).toEqual({ included: true, limit: 1000 });
    expect(tierIncludes(pro, "study_tools")).toEqual({ included: true, limit: 100 });
    expect(tierIncludes(pro, "notebook")).toEqual({ included: true, limit: 50 });
    // Another audience's feature is not picked up.
    expect(tierIncludes(pro, "auto_grading")).toEqual({ included: false });
    expect(tierIncludes(pro, "family_plus")).toEqual({ included: false });
  });

  test("an unmetered feature has no limit whatever the tier row says", () => {
    const parent = tier("family", { audience: "parent", limits: { family_plus: 7 } });
    const features = resolveFeatureAccess({
      catalog: catalogWith(parent),
      grants: [grant("family")],
      schoolActive: true,
    });

    expect(features.family_plus).toMatchObject({ active: true, limit: null, reason: null });
  });
});

describe("usage periods", () => {
  test("the period is the calendar month in UTC", () => {
    expect(usagePeriodStart(new Date("2026-08-31T23:59:59.000Z"))).toBe("2026-08-01");
    expect(usagePeriodStart(new Date("2026-12-01T00:00:00.000Z"))).toBe("2026-12-01");
  });

  test("Retry-After runs to the next 1st, UTC", () => {
    expect(secondsUntilNextUsagePeriod(new Date("2026-08-31T23:59:00.000Z"))).toBe(60);
    expect(secondsUntilNextUsagePeriod(new Date("2026-12-31T23:59:59.000Z"))).toBe(1);
  });
});
