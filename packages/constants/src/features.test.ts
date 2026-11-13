// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  FEATURE_AUDIENCES,
  FEATURE_KEY_PATTERN,
  FEATURE_KEYS,
  FEATURE_USAGE_UNITS,
  FEATURES,
  isFeatureKey,
} from "./features";

describe("FEATURES", () => {
  test("every key is one the database's ck_features_key accepts", () => {
    for (const key of FEATURE_KEYS) {
      expect(key).toMatch(FEATURE_KEY_PATTERN);
    }
  });

  test("every definition is well-formed", () => {
    for (const [key, feature] of Object.entries(FEATURES)) {
      expect(FEATURE_AUDIENCES).toContain(feature.audience);
      if (feature.unit !== null) expect(FEATURE_USAGE_UNITS).toContain(feature.unit);
      // A feature with nothing to count cannot carry a limit on it.
      if (feature.unit === null) expect(feature.defaultMonthlyLimit).toBeNull();
      if (feature.defaultMonthlyLimit !== null) {
        expect(Number.isInteger(feature.defaultMonthlyLimit)).toBe(true);
        expect(feature.defaultMonthlyLimit).toBeGreaterThan(0);
      }
      expect(feature.nameKey as string).toBe(`features.${key}.name`);
    }
  });

  test("the launch features are registered with their audiences and units", () => {
    expect(FEATURES.ai_tutor).toMatchObject({ audience: "student", unit: "messages" });
    expect(FEATURES.study_tools).toMatchObject({ audience: "student", unit: "generations" });
    expect(FEATURES.notebook).toMatchObject({ audience: "student", unit: "pages" });
    expect(FEATURES.auto_grading).toMatchObject({ audience: "teacher", unit: "submissions" });
    expect(FEATURES.family_plus).toMatchObject({ audience: "parent", unit: null });
  });

  test("isFeatureKey accepts registered keys only", () => {
    expect(isFeatureKey("ai_tutor")).toBe(true);
    expect(isFeatureKey("toString")).toBe(false);
    expect(isFeatureKey("unknown_feature")).toBe(false);
  });
});
