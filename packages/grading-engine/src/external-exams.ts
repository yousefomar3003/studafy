/**
 * External exams and test scores: SAT, ACT, AP, IELTS, TOEFL, Cambridge / IB final results, the
 * national exams of Jordan (Tawjihi) and Egypt (Thanaweya Amma) and US state assessments.
 *
 * A school keeps a catalogue of the external exams its students sit (db/migrations/000255). Each
 * exam is scored on one or more components, either as a number (a range and a step: IELTS bands
 * run 0..9 by 0.5) or as one label out of an ordered list (IGCSE A*..U), and may carry a total:
 * the sum of its components (SAT, TOEFL), their average (ACT composite, IELTS overall band,
 * rounded to a step), or none (AP, IGCSE: one grade per subject).
 *
 * The presets below are the built-in definitions a school copies into its catalogue and then edits.
 * Everything here is pure, so the API validates and totals scores with the same rules the web form
 * checks as the user types.
 */

import { EPSILON, roundTo } from "./rounding";

import type { ValidationIssue } from "./types";

export type ExternalExamTotalMode = "sum" | "average" | "none";
export type ExternalExamScoreType = "numeric" | "label";

export interface ExternalExamComponentDefinition {
  name: string;
  scoreType: ExternalExamScoreType;
  /** Numeric components only: the lowest and highest score and the step between scores. */
  minScore: number | null;
  maxScore: number | null;
  step: number | null;
  /** Label components only: the allowed labels, in display order (IGCSE lists the best first). */
  allowedLabels: string[] | null;
}

export interface ExternalExamDefinition {
  code: string;
  name: string;
  totalMode: ExternalExamTotalMode;
  /** An `average` total is rounded to the nearest multiple of this step (half up); else 2 decimals. */
  totalRoundingStep: number | null;
  /** The total's range, shown beside it (1450 / 1600). Null when the exam has no total. */
  totalMin: number | null;
  totalMax: number | null;
  /** One result per subject (IGCSE, A-Level, IB DP, AP). */
  perSubject: boolean;
  showOnTranscript: boolean;
  components: ExternalExamComponentDefinition[];
}

export const EXTERNAL_EXAM_PRESET_KEYS = [
  "sat",
  "psat",
  "act",
  "ap",
  "ielts",
  "toefl_ibt",
  "igcse_letter",
  "igcse_numeric",
  "a_level",
  "ib_dp",
  "tawjihi",
  "thanaweya_amma",
  "state_assessment",
] as const;

export type ExternalExamPresetKey = (typeof EXTERNAL_EXAM_PRESET_KEYS)[number];

export interface ExternalExamPreset extends ExternalExamDefinition {
  key: ExternalExamPresetKey;
  /** What to check after adding it: defaults that are the school's to set, not an official scale. */
  note: string | null;
}

/** Limits shared with the database CHECKs (000255). */
export const EXTERNAL_EXAM_LIMITS = {
  codeLength: 40,
  nameLength: 120,
  labelLength: 40,
  maxComponents: 20,
  maxLabels: 50,
  noteLength: 1000,
  /** numeric(8, 2): every score and total stays within ±999999.99. */
  maxAbsScore: 999_999.99,
} as const;

function numeric(name: string, minScore: number, maxScore: number, step: number) {
  return { name, scoreType: "numeric", minScore, maxScore, step, allowedLabels: null } as const;
}

function label(name: string, allowedLabels: string[]) {
  return {
    name,
    scoreType: "label",
    minScore: null,
    maxScore: null,
    step: null,
    allowedLabels,
  } as const;
}

const noTotal = {
  totalMode: "none",
  totalRoundingStep: null,
  totalMin: null,
  totalMax: null,
} as const;

/**
 * The built-in exams. Ranges follow each board's published scale; a school edits its copy when a
 * board changes one (TOEFL iBT, for example, is moving to a 1-6 band scale).
 */
export const EXTERNAL_EXAM_PRESETS: readonly ExternalExamPreset[] = [
  {
    key: "sat",
    code: "SAT",
    name: "SAT",
    totalMode: "sum",
    totalRoundingStep: null,
    totalMin: 400,
    totalMax: 1600,
    perSubject: false,
    showOnTranscript: true,
    note: null,
    components: [numeric("Reading and Writing", 200, 800, 10), numeric("Math", 200, 800, 10)],
  },
  {
    key: "psat",
    code: "PSAT",
    name: "PSAT/NMSQT",
    totalMode: "sum",
    totalRoundingStep: null,
    totalMin: 320,
    totalMax: 1520,
    perSubject: false,
    showOnTranscript: false,
    note: null,
    components: [numeric("Reading and Writing", 160, 760, 10), numeric("Math", 160, 760, 10)],
  },
  {
    key: "act",
    code: "ACT",
    name: "ACT",
    totalMode: "average",
    totalRoundingStep: 1,
    totalMin: 1,
    totalMax: 36,
    perSubject: false,
    showOnTranscript: true,
    note: null,
    components: [
      numeric("English", 1, 36, 1),
      numeric("Mathematics", 1, 36, 1),
      numeric("Reading", 1, 36, 1),
      numeric("Science", 1, 36, 1),
    ],
  },
  {
    key: "ap",
    code: "AP",
    name: "AP Exam",
    ...noTotal,
    perSubject: true,
    showOnTranscript: true,
    note: null,
    components: [numeric("Score", 1, 5, 1)],
  },
  {
    key: "ielts",
    code: "IELTS",
    name: "IELTS Academic",
    totalMode: "average",
    totalRoundingStep: 0.5,
    totalMin: 0,
    totalMax: 9,
    perSubject: false,
    showOnTranscript: true,
    note: null,
    components: [
      numeric("Listening", 0, 9, 0.5),
      numeric("Reading", 0, 9, 0.5),
      numeric("Writing", 0, 9, 0.5),
      numeric("Speaking", 0, 9, 0.5),
    ],
  },
  {
    key: "toefl_ibt",
    code: "TOEFL",
    name: "TOEFL iBT",
    totalMode: "sum",
    totalRoundingStep: null,
    totalMin: 0,
    totalMax: 120,
    perSubject: false,
    showOnTranscript: true,
    note: "TOEFL iBT is moving to a 1-6 band scale; edit the sections' ranges for new score reports.",
    components: [
      numeric("Reading", 0, 30, 1),
      numeric("Listening", 0, 30, 1),
      numeric("Speaking", 0, 30, 1),
      numeric("Writing", 0, 30, 1),
    ],
  },
  {
    key: "igcse_letter",
    code: "IGCSE",
    name: "IGCSE (A*-G)",
    ...noTotal,
    perSubject: true,
    showOnTranscript: true,
    note: null,
    components: [label("Grade", ["A*", "A", "B", "C", "D", "E", "F", "G", "U"])],
  },
  {
    key: "igcse_numeric",
    code: "IGCSE-9-1",
    name: "IGCSE (9-1)",
    ...noTotal,
    perSubject: true,
    showOnTranscript: true,
    note: null,
    components: [label("Grade", ["9", "8", "7", "6", "5", "4", "3", "2", "1", "U"])],
  },
  {
    key: "a_level",
    code: "A-LEVEL",
    name: "A Level",
    ...noTotal,
    perSubject: true,
    showOnTranscript: true,
    note: null,
    components: [label("Grade", ["A*", "A", "B", "C", "D", "E", "U"])],
  },
  {
    key: "ib_dp",
    code: "IB-DP",
    name: "IB Diploma subject",
    ...noTotal,
    perSubject: true,
    showOnTranscript: true,
    note: null,
    components: [numeric("Grade", 1, 7, 1)],
  },
  {
    // Jordan's General Secondary Education Certificate (التوجيهي): one result per student, a mark
    // per subject and the average of them as a percentage.
    key: "tawjihi",
    code: "TAWJIHI",
    name: "Tawjihi (General Secondary Education Certificate)",
    totalMode: "average",
    totalRoundingStep: null,
    totalMin: 0,
    totalMax: 100,
    perSubject: false,
    showOnTranscript: true,
    note:
      "Default subjects, each marked 0-100, averaged into a percentage. Edit the subjects and their " +
      "maximums to match the student's stream and the ministry's current rules; the ministry's " +
      "weighting of subjects is not applied.",
    components: [
      numeric("Arabic Language", 0, 100, 0.5),
      numeric("English Language", 0, 100, 0.5),
      numeric("Islamic Education", 0, 100, 0.5),
      numeric("History of Jordan", 0, 100, 0.5),
      numeric("Mathematics", 0, 100, 0.5),
      numeric("Stream subject", 0, 100, 0.5),
    ],
  },
  {
    // Egypt's General Secondary Certificate (الثانوية العامة): a mark per subject and their total;
    // the percentage is the total over the total's maximum.
    key: "thanaweya_amma",
    code: "THANAWEYA",
    name: "Thanaweya Amma (General Secondary Certificate)",
    totalMode: "sum",
    totalRoundingStep: null,
    totalMin: 0,
    totalMax: 600,
    perSubject: false,
    showOnTranscript: true,
    note:
      "Default subjects, each marked out of 100, totalled. The ministry changes subjects and " +
      "maximums: edit them, and the total's maximum, to match the student's track and year.",
    components: [
      numeric("Arabic Language", 0, 100, 0.5),
      numeric("First Foreign Language", 0, 100, 0.5),
      numeric("Second Foreign Language", 0, 100, 0.5),
      numeric("Track subject 1", 0, 100, 0.5),
      numeric("Track subject 2", 0, 100, 0.5),
      numeric("Track subject 3", 0, 100, 0.5),
    ],
  },
  {
    // A US state's annual assessment, per subject: a performance level and, when reported, a
    // scale score.
    key: "state_assessment",
    code: "STATE",
    name: "State assessment",
    totalMode: "none",
    totalRoundingStep: null,
    totalMin: null,
    totalMax: null,
    perSubject: true,
    showOnTranscript: false,
    note:
      "Rename it after your state's test. The levels and the scale score's range differ by state " +
      "and subject: edit them. The scale score is optional when recording a result.",
    components: [
      label("Performance level", ["Level 1", "Level 2", "Level 3", "Level 4"]),
      numeric("Scale score", 0, 1000, 1),
    ],
  },
];

export function externalExamPreset(key: string): ExternalExamPreset | null {
  return EXTERNAL_EXAM_PRESETS.find((preset) => preset.key === key) ?? null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function issue(code: string, message: string, ref?: string): ValidationIssue {
  return { code, severity: "error", message, ...(ref === undefined ? {} : { ref }) };
}

function trimmedText(value: string, max: number): boolean {
  return value === value.trim() && value !== "" && value.length <= max;
}

/** Whether `value` is `min` plus a whole number of `step`s (forgiving floating-point noise). */
export function isOnStep(value: number, min: number, step: number): boolean {
  const steps = (value - min) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
}

function inStoredRange(value: number): boolean {
  return Math.abs(value) <= EXTERNAL_EXAM_LIMITS.maxAbsScore;
}

/**
 * Every problem with an exam definition, one issue each; empty when it can be saved. `ref` is the
 * component's position (as a string) for a component's issue.
 */
export function validateExternalExamDefinition(
  definition: ExternalExamDefinition,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { codeLength, nameLength, labelLength, maxComponents, maxLabels } = EXTERNAL_EXAM_LIMITS;

  if (!trimmedText(definition.code, codeLength)) {
    issues.push(issue("EXAM_CODE_INVALID", `The exam code must be 1 to ${codeLength} characters.`));
  }
  if (!trimmedText(definition.name, nameLength)) {
    issues.push(issue("EXAM_NAME_INVALID", `The exam name must be 1 to ${nameLength} characters.`));
  }

  const components = definition.components;
  if (components.length === 0 || components.length > maxComponents) {
    issues.push(
      issue(
        "EXAM_COMPONENT_COUNT",
        `An exam needs between 1 and ${maxComponents} scored components.`,
      ),
    );
  }

  const seen = new Set<string>();
  components.forEach((component, index) => {
    const ref = String(index);
    const name = component.name;
    if (!trimmedText(name, nameLength)) {
      issues.push(
        issue(
          "COMPONENT_NAME_INVALID",
          `Component names must be 1 to ${nameLength} characters.`,
          ref,
        ),
      );
    } else if (seen.has(name.toLowerCase())) {
      issues.push(issue("COMPONENT_NAME_DUPLICATE", `"${name}" is used twice.`, ref));
    }
    seen.add(name.toLowerCase());

    if (component.scoreType === "numeric") {
      const { minScore, maxScore, step } = component;
      if (
        minScore === null ||
        maxScore === null ||
        step === null ||
        ![minScore, maxScore, step].every(Number.isFinite) ||
        !inStoredRange(minScore) ||
        !inStoredRange(maxScore)
      ) {
        issues.push(
          issue(
            "COMPONENT_RANGE_INVALID",
            `"${name}" needs a lowest score, a highest score and a step.`,
            ref,
          ),
        );
      } else if (minScore >= maxScore) {
        issues.push(
          issue(
            "COMPONENT_RANGE_INVALID",
            `"${name}": the lowest score must be below the highest.`,
            ref,
          ),
        );
      } else if (step <= 0 || step > maxScore - minScore + EPSILON) {
        issues.push(
          issue(
            "COMPONENT_STEP_INVALID",
            `"${name}": the step must be above 0 and fit the range.`,
            ref,
          ),
        );
      } else if (!isOnStep(maxScore, minScore, step)) {
        issues.push(
          issue(
            "COMPONENT_STEP_INVALID",
            `"${name}": the range ${minScore}-${maxScore} is not a whole number of ${step} steps.`,
            ref,
          ),
        );
      }
    } else {
      const labels = component.allowedLabels ?? [];
      if (labels.length === 0 || labels.length > maxLabels) {
        issues.push(
          issue(
            "COMPONENT_LABELS_INVALID",
            `"${name}" needs between 1 and ${maxLabels} grades.`,
            ref,
          ),
        );
      } else if (!labels.every((value) => trimmedText(value, labelLength))) {
        issues.push(
          issue(
            "COMPONENT_LABELS_INVALID",
            `"${name}": every grade must be 1 to ${labelLength} characters.`,
            ref,
          ),
        );
      } else if (new Set(labels).size !== labels.length) {
        issues.push(issue("COMPONENT_LABELS_INVALID", `"${name}" lists a grade twice.`, ref));
      }
    }
  });

  if (definition.totalMode === "none") {
    if (
      definition.totalRoundingStep !== null ||
      definition.totalMin !== null ||
      definition.totalMax !== null
    ) {
      issues.push(
        issue("TOTAL_INVALID", "An exam without a total has no total range or rounding."),
      );
    }
  } else {
    if (components.some((component) => component.scoreType !== "numeric")) {
      issues.push(
        issue(
          "TOTAL_NEEDS_NUMBERS",
          "A sum or an average needs every component to be scored as a number.",
        ),
      );
    }
    const { totalMin, totalMax, totalRoundingStep } = definition;
    if (
      (totalMin !== null && (!Number.isFinite(totalMin) || !inStoredRange(totalMin))) ||
      (totalMax !== null && (!Number.isFinite(totalMax) || !inStoredRange(totalMax))) ||
      (totalMin !== null && totalMax !== null && totalMin > totalMax)
    ) {
      issues.push(
        issue("TOTAL_INVALID", "The total's lowest value must not be above its highest."),
      );
    }
    if (totalRoundingStep !== null) {
      if (definition.totalMode !== "average") {
        issues.push(issue("TOTAL_INVALID", "Only an average total is rounded to a step."));
      } else if (!Number.isFinite(totalRoundingStep) || totalRoundingStep <= 0) {
        issues.push(issue("TOTAL_INVALID", "The rounding step must be above 0."));
      }
    }
  }
  return issues;
}

/** One component's score: a number for a numeric component, a label for a label component. */
export type ExternalExamScoreValue = number | string;

/** Why a score is not valid for its component, or null when it is. */
export function validateExternalExamScore(
  component: ExternalExamComponentDefinition,
  value: ExternalExamScoreValue,
): ValidationIssue | null {
  const name = component.name;
  if (component.scoreType === "numeric") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return issue("SCORE_NOT_A_NUMBER", `"${name}" is scored as a number.`);
    }
    const { minScore, maxScore, step } = component;
    if (minScore === null || maxScore === null || step === null) {
      return issue("COMPONENT_RANGE_INVALID", `"${name}" has no score range.`);
    }
    if (value < minScore - EPSILON || value > maxScore + EPSILON) {
      return issue("SCORE_OUT_OF_RANGE", `"${name}" must be between ${minScore} and ${maxScore}.`);
    }
    if (!isOnStep(value, minScore, step)) {
      return issue("SCORE_OFF_STEP", `"${name}" goes up in steps of ${step}.`);
    }
    return null;
  }
  if (typeof value !== "string") {
    return issue("SCORE_NOT_A_LABEL", `"${name}" is scored as a grade.`);
  }
  if (!(component.allowedLabels ?? []).includes(value)) {
    return issue(
      "SCORE_LABEL_UNKNOWN",
      `"${name}" must be one of ${(component.allowedLabels ?? []).join(", ")}.`,
    );
  }
  return null;
}

/** Round to the nearest multiple of `step`, halves up (IELTS: 6.25 -> 6.5, 6.75 -> 7). */
export function roundToStep(value: number, step: number): number {
  const multiples = Math.floor(Number((value / step).toPrecision(12)) + 0.5);
  const decimals = Math.min(6, (String(step).split(".")[1] ?? "").length);
  return Number((multiples * step).toFixed(decimals));
}

/**
 * The exam's total from its component scores, in component order (`null` for an unscored one).
 * Null when the exam has no total, or when any component has no numeric score: a total is never
 * worked out from part of an exam.
 */
export function computeExternalExamTotal(
  definition: Pick<ExternalExamDefinition, "totalMode" | "totalRoundingStep">,
  scores: readonly (ExternalExamScoreValue | null)[],
): number | null {
  if (definition.totalMode === "none" || scores.length === 0) return null;
  const numbers: number[] = [];
  for (const score of scores) {
    if (typeof score !== "number" || !Number.isFinite(score)) return null;
    numbers.push(score);
  }
  const sum = numbers.reduce((total, value) => total + value, 0);
  if (definition.totalMode === "sum") return roundTo(sum, { decimals: 2, mode: "half_up" });
  const average = sum / numbers.length;
  if (definition.totalRoundingStep !== null && definition.totalRoundingStep > 0) {
    return roundToStep(average, definition.totalRoundingStep);
  }
  return roundTo(average, { decimals: 2, mode: "half_up" });
}
