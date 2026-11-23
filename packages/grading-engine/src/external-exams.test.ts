// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  EXTERNAL_EXAM_PRESETS,
  EXTERNAL_EXAM_PRESET_KEYS,
  computeExternalExamTotal,
  externalExamPreset,
  isOnStep,
  roundToStep,
  validateExternalExamDefinition,
  validateExternalExamScore,
} from "./index";

import type { ExternalExamComponentDefinition, ExternalExamDefinition } from "./index";

const band: ExternalExamComponentDefinition = {
  name: "Listening",
  scoreType: "numeric",
  minScore: 0,
  maxScore: 9,
  step: 0.5,
  allowedLabels: null,
};

const grade: ExternalExamComponentDefinition = {
  name: "Grade",
  scoreType: "label",
  minScore: null,
  maxScore: null,
  step: null,
  allowedLabels: ["A*", "A", "B", "C"],
};

function exam(overrides: Partial<ExternalExamDefinition> = {}): ExternalExamDefinition {
  return {
    code: "MOCK",
    name: "Mock exam",
    totalMode: "sum",
    totalRoundingStep: null,
    totalMin: 0,
    totalMax: 18,
    perSubject: false,
    showOnTranscript: false,
    components: [band, { ...band, name: "Reading" }],
    ...overrides,
  };
}

const codes = (definition: ExternalExamDefinition) =>
  validateExternalExamDefinition(definition).map((issue) => issue.code);

describe("presets", () => {
  test("every preset key has exactly one valid definition with a unique code", () => {
    expect(EXTERNAL_EXAM_PRESETS.map((preset) => preset.key)).toEqual([
      ...EXTERNAL_EXAM_PRESET_KEYS,
    ]);
    for (const preset of EXTERNAL_EXAM_PRESETS) {
      expect({ key: preset.key, issues: validateExternalExamDefinition(preset) }).toEqual({
        key: preset.key,
        issues: [],
      });
    }
    const presetCodes = EXTERNAL_EXAM_PRESETS.map((preset) => preset.code.toLowerCase());
    expect(new Set(presetCodes).size).toBe(presetCodes.length);
  });

  test("SAT sums two 200-800 sections into 400-1600", () => {
    const sat = externalExamPreset("sat")!;
    expect(sat.components.map((c) => [c.name, c.minScore, c.maxScore, c.step])).toEqual([
      ["Reading and Writing", 200, 800, 10],
      ["Math", 200, 800, 10],
    ]);
    expect(computeExternalExamTotal(sat, [720, 760])).toBe(1480);
  });

  test("IELTS averages four bands and rounds the overall to the nearest half band", () => {
    const ielts = externalExamPreset("ielts")!;
    // 6.5 + 6.5 + 5 + 7 = 25 / 4 = 6.25 -> 6.5
    expect(computeExternalExamTotal(ielts, [6.5, 6.5, 5, 7])).toBe(6.5);
    // 6.5 + 6.5 + 6 + 7 = 26 / 4 = 6.5 -> 6.5
    expect(computeExternalExamTotal(ielts, [6.5, 6.5, 6, 7])).toBe(6.5);
    // 7 + 7 + 6.5 + 6.5... 27 / 4 = 6.75 -> 7
    expect(computeExternalExamTotal(ielts, [7, 7, 6.5, 6.5])).toBe(7);
    // 6 + 6 + 6 + 6.5 = 24.5 / 4 = 6.125 -> 6
    expect(computeExternalExamTotal(ielts, [6, 6, 6, 6.5])).toBe(6);
  });

  test("ACT composite is the four sections' average rounded to a whole number", () => {
    const act = externalExamPreset("act")!;
    // 30 + 31 + 29 + 28 = 118 / 4 = 29.5 -> 30
    expect(computeExternalExamTotal(act, [30, 31, 29, 28])).toBe(30);
    // 30 + 30 + 29 + 28 = 117 / 4 = 29.25 -> 29
    expect(computeExternalExamTotal(act, [30, 30, 29, 28])).toBe(29);
  });

  test("TOEFL iBT sums four 0-30 sections", () => {
    expect(computeExternalExamTotal(externalExamPreset("toefl_ibt")!, [28, 27, 24, 26])).toBe(105);
  });

  test("per-subject finals have no total and one grade per subject", () => {
    for (const key of ["ap", "igcse_letter", "igcse_numeric", "a_level", "ib_dp"]) {
      const preset = externalExamPreset(key)!;
      expect(preset.perSubject).toBe(true);
      expect(preset.totalMode).toBe("none");
      expect(preset.components).toHaveLength(1);
      expect(computeExternalExamTotal(preset, [5])).toBeNull();
    }
    expect(externalExamPreset("igcse_letter")!.components[0]!.allowedLabels).toEqual([
      "A*",
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "U",
    ]);
    expect(externalExamPreset("igcse_numeric")!.components[0]!.allowedLabels?.at(0)).toBe("9");
  });

  test("Tawjihi averages its subject marks into a percentage", () => {
    const tawjihi = externalExamPreset("tawjihi")!;
    expect(tawjihi.perSubject).toBe(false);
    expect(tawjihi.totalMax).toBe(100);
    // (95 + 88 + 90 + 85 + 92.5 + 80) / 6 = 530.5 / 6 = 88.4166... -> 88.42
    expect(computeExternalExamTotal(tawjihi, [95, 88, 90, 85, 92.5, 80])).toBe(88.42);
    expect(tawjihi.note).toContain("Edit the subjects");
  });

  test("Thanaweya Amma totals its subject marks", () => {
    const thanaweya = externalExamPreset("thanaweya_amma")!;
    expect(thanaweya.totalMode).toBe("sum");
    expect(thanaweya.totalMax).toBe(600);
    expect(computeExternalExamTotal(thanaweya, [78.5, 90, 85, 100, 99.5, 97])).toBe(550);
  });

  test("a state assessment is per subject: a performance level and an optional scale score", () => {
    const state = externalExamPreset("state_assessment")!;
    expect(state.perSubject).toBe(true);
    expect(state.totalMode).toBe("none");
    expect(state.components.map((c) => [c.name, c.scoreType])).toEqual([
      ["Performance level", "label"],
      ["Scale score", "numeric"],
    ]);
    expect(validateExternalExamScore(state.components[0]!, "Level 3")).toBeNull();
    expect(validateExternalExamScore(state.components[0]!, "Level 5")?.code).toBe(
      "SCORE_LABEL_UNKNOWN",
    );
  });

  test("only presets with editable official defaults carry a note", () => {
    expect(externalExamPreset("sat")!.note).toBeNull();
    expect(externalExamPreset("toefl_ibt")!.note).not.toBeNull();
  });

  test("an unknown preset key is null", () => {
    expect(externalExamPreset("gcse")).toBeNull();
  });
});

describe("validateExternalExamDefinition", () => {
  test("accepts a well-formed exam", () => {
    expect(codes(exam())).toEqual([]);
    expect(codes(exam({ totalMode: "none", totalMin: null, totalMax: null }))).toEqual([]);
    expect(
      codes(exam({ totalMode: "none", totalMin: null, totalMax: null, components: [grade] })),
    ).toEqual([]);
  });

  test("rejects untrimmed or empty code and name", () => {
    expect(codes(exam({ code: " SAT" }))).toEqual(["EXAM_CODE_INVALID"]);
    expect(codes(exam({ name: "" }))).toEqual(["EXAM_NAME_INVALID"]);
    expect(codes(exam({ code: "X".repeat(41) }))).toEqual(["EXAM_CODE_INVALID"]);
  });

  test("needs 1 to 20 components with distinct names", () => {
    expect(codes(exam({ components: [] }))).toEqual(["EXAM_COMPONENT_COUNT"]);
    expect(codes(exam({ components: [band, { ...band, name: "listening" }] }))).toEqual([
      "COMPONENT_NAME_DUPLICATE",
    ]);
  });

  test("checks a numeric component's range and step", () => {
    expect(codes(exam({ components: [{ ...band, minScore: 9, maxScore: 0 }] }))).toEqual([
      "COMPONENT_RANGE_INVALID",
    ]);
    expect(codes(exam({ components: [{ ...band, step: 0 }] }))).toEqual(["COMPONENT_STEP_INVALID"]);
    expect(codes(exam({ components: [{ ...band, step: 2 }] }))).toEqual(["COMPONENT_STEP_INVALID"]);
    expect(codes(exam({ components: [{ ...band, maxScore: null }] }))).toEqual([
      "COMPONENT_RANGE_INVALID",
    ]);
  });

  test("checks a label component's grades", () => {
    const none = { totalMode: "none", totalMin: null, totalMax: null } as const;
    expect(codes(exam({ ...none, components: [{ ...grade, allowedLabels: [] }] }))).toEqual([
      "COMPONENT_LABELS_INVALID",
    ]);
    expect(codes(exam({ ...none, components: [{ ...grade, allowedLabels: ["A", "A"] }] }))).toEqual(
      ["COMPONENT_LABELS_INVALID"],
    );
    expect(codes(exam({ ...none, components: [{ ...grade, allowedLabels: ["A "] }] }))).toEqual([
      "COMPONENT_LABELS_INVALID",
    ]);
  });

  test("a sum or an average needs numbers only, and only an average rounds to a step", () => {
    expect(codes(exam({ components: [band, grade] }))).toEqual(["TOTAL_NEEDS_NUMBERS"]);
    expect(codes(exam({ totalRoundingStep: 0.5 }))).toEqual(["TOTAL_INVALID"]);
    expect(codes(exam({ totalMode: "average", totalRoundingStep: 0 }))).toEqual(["TOTAL_INVALID"]);
    expect(codes(exam({ totalMin: 20, totalMax: 10 }))).toEqual(["TOTAL_INVALID"]);
    expect(codes(exam({ totalMode: "none" }))).toEqual(["TOTAL_INVALID"]);
  });
});

describe("validateExternalExamScore", () => {
  test("a numeric score must be in range and on a step", () => {
    expect(validateExternalExamScore(band, 6.5)).toBeNull();
    expect(validateExternalExamScore(band, 0)).toBeNull();
    expect(validateExternalExamScore(band, 9)).toBeNull();
    expect(validateExternalExamScore(band, 9.5)?.code).toBe("SCORE_OUT_OF_RANGE");
    expect(validateExternalExamScore(band, -0.5)?.code).toBe("SCORE_OUT_OF_RANGE");
    expect(validateExternalExamScore(band, 6.3)?.code).toBe("SCORE_OFF_STEP");
    expect(validateExternalExamScore(band, "6.5")?.code).toBe("SCORE_NOT_A_NUMBER");
    expect(validateExternalExamScore(band, Number.NaN)?.code).toBe("SCORE_NOT_A_NUMBER");
  });

  test("a label score must be one of the allowed grades, exactly", () => {
    expect(validateExternalExamScore(grade, "A*")).toBeNull();
    expect(validateExternalExamScore(grade, "a*")?.code).toBe("SCORE_LABEL_UNKNOWN");
    expect(validateExternalExamScore(grade, "E")?.code).toBe("SCORE_LABEL_UNKNOWN");
    expect(validateExternalExamScore(grade, 1)?.code).toBe("SCORE_NOT_A_LABEL");
  });

  test("SAT sections go up in tens", () => {
    const math = externalExamPreset("sat")!.components[1]!;
    expect(validateExternalExamScore(math, 650)).toBeNull();
    expect(validateExternalExamScore(math, 655)?.code).toBe("SCORE_OFF_STEP");
  });
});

describe("totals", () => {
  test("no total from part of an exam", () => {
    expect(
      computeExternalExamTotal({ totalMode: "sum", totalRoundingStep: null }, [700, null]),
    ).toBe(null);
    expect(computeExternalExamTotal({ totalMode: "sum", totalRoundingStep: null }, [])).toBeNull();
    expect(
      computeExternalExamTotal({ totalMode: "average", totalRoundingStep: null }, [1, "A"]),
    ).toBeNull();
  });

  test("an average without a step keeps two decimals", () => {
    expect(
      computeExternalExamTotal({ totalMode: "average", totalRoundingStep: null }, [1, 2, 2]),
    ).toBe(1.67);
  });

  test("roundToStep and isOnStep forgive floating-point noise", () => {
    expect(roundToStep(6.25, 0.5)).toBe(6.5);
    expect(roundToStep(6.2499, 0.5)).toBe(6);
    expect(roundToStep(0.30000000000000004, 0.1)).toBe(0.3);
    expect(isOnStep(0.3, 0, 0.1)).toBe(true);
    expect(isOnStep(0.35, 0, 0.1)).toBe(false);
  });
});
