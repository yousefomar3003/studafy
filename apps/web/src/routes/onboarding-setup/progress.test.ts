// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";

import {
  clearProgress,
  defaultProgress,
  loadProgress,
  nextStepAfter,
  saveProgress,
  STEP_IDS,
} from "./progress";

afterEach(() => {
  window.localStorage.clear();
});

describe("defaultProgress", () => {
  test("starts on the first step with every step upcoming", () => {
    const progress = defaultProgress();

    expect(progress.currentStep).toBe(STEP_IDS[0]);
    for (const step of STEP_IDS) {
      // eslint-disable-next-line security/detect-object-injection -- `step` comes from iterating this module's own fixed `STEP_IDS` tuple, not user input
      expect(progress.stepState[step]).toBe("upcoming");
    }
  });
});

describe("nextStepAfter", () => {
  test("returns the following step for every step but the last", () => {
    for (let i = 0; i < STEP_IDS.length - 1; i += 1) {
      // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded loop counter, not user input
      expect(nextStepAfter(STEP_IDS[i])).toBe(STEP_IDS[i + 1]);
    }
  });

  test('returns "complete" after the last step', () => {
    expect(nextStepAfter(STEP_IDS[STEP_IDS.length - 1])).toBe("complete");
  });
});

describe("loadProgress / saveProgress", () => {
  test("round-trips a saved progress object", () => {
    const progress = defaultProgress();
    progress.currentStep = "academic-year";
    progress.stepState["school-profile"] = "completed";

    saveProgress(progress);

    expect(loadProgress()).toEqual(progress);
  });

  test("returns a fresh default when nothing is stored", () => {
    expect(loadProgress()).toEqual(defaultProgress());
  });

  test("discards a stored object from an incompatible version instead of throwing", () => {
    window.localStorage.setItem(
      "studafy.onboarding-setup.v1",
      JSON.stringify({ version: 2, currentStep: "students" }),
    );

    expect(loadProgress()).toEqual(defaultProgress());
  });

  test("discards unparsable stored data instead of throwing", () => {
    window.localStorage.setItem("studafy.onboarding-setup.v1", "{not json");

    expect(loadProgress()).toEqual(defaultProgress());
  });
});

describe("clearProgress", () => {
  test("removes any stored progress", () => {
    saveProgress(defaultProgress());
    clearProgress();

    expect(loadProgress()).toEqual(defaultProgress());
    expect(window.localStorage.getItem("studafy.onboarding-setup.v1")).toBeNull();
  });
});
