/**
 * Tawjihi equivalency: an ESTIMATE of the Jordanian General Secondary (Tawjihi) percentage a
 * student's foreign qualification may be converted to -- IGCSE / A Level grades, the IB Diploma
 * total, or an American GPA and SAT score.
 *
 * The Ministry of Education sets the real conversion and changes it, so nothing here is an official
 * formula. A school keeps its own rules (db/migrations/000267, `equivalency_rule_sets`), starting
 * from the clearly labelled {@link EQUIVALENCY_EXAMPLES} if it wants, and the result is always an
 * estimate the school confirms.
 *
 * A rule set is a list of weighted PARTS. Each part turns one kind of evidence into a percentage:
 *
 *  - `exam_subjects`: per-subject external exam results (IGCSE, A Level, IB DP subject finals...).
 *    Each result's grade label ("A*", "7") maps to a percentage through `gradePercentages`; the
 *    best result per subject is kept; the required subjects always count, then the best of the rest
 *    up to `bestCount`; fewer than `minCount` counted is missing data. The part's percentage is the
 *    plain mean of the counted subjects.
 *  - `diploma_total`: the IB Diploma total (out of 45) of the student's latest finalized annual
 *    result, through `conversion`. With `requireAwarded`, a diploma not awarded gives no estimate.
 *  - `gpa`: the cumulative GPA of every finalized year (the transcript's), or the weighted GPA,
 *    through `conversion`.
 *  - `exam_total`: the best total of one external exam (SAT, ACT...), through `conversion`.
 *
 * A conversion is a `table` (the highest band whose minimum the value reaches gives its
 * percentage; below every band there is no estimate) or `linear` (intercept + slope x value,
 * clamped to 0-100).
 *
 * The estimate is the weighted mean of the parts' percentages (weights are relative: 70 and 30, or
 * 7 and 3, are the same), rounded to two decimals, half up. A part that cannot be worked out is
 * missing data and leaves the estimate `incomplete` -- unless the part is optional, when it is left
 * out and the other parts' weights share its place. A rule that rules the student out (a diploma not
 * awarded, a value below the conversion table) makes it `not_eligible`. Every step is returned, so
 * the school and the family see exactly how the figure was reached.
 */

import { EPSILON, roundTo } from "./rounding";

import type { ValidationIssue } from "./types";

export const EQUIVALENCY_SOURCE_SYSTEMS = ["igcse_a_level", "ib", "american", "other"] as const;
export type EquivalencySourceSystem = (typeof EQUIVALENCY_SOURCE_SYSTEMS)[number];

export const EQUIVALENCY_PART_TYPES = [
  "exam_subjects",
  "diploma_total",
  "gpa",
  "exam_total",
] as const;
export type EquivalencyPartType = (typeof EQUIVALENCY_PART_TYPES)[number];

export const EQUIVALENCY_CONVERSION_MODES = ["table", "linear"] as const;
export type EquivalencyConversionMode = (typeof EQUIVALENCY_CONVERSION_MODES)[number];

export const EQUIVALENCY_GPA_BASES = ["gpa", "weighted_gpa"] as const;
export type EquivalencyGpaBasis = (typeof EQUIVALENCY_GPA_BASES)[number];

export type EquivalencyStatus = "estimated" | "incomplete" | "not_eligible";
export type EquivalencyPartStatus = "counted" | "missing" | "skipped" | "not_eligible";

/** Limits shared by the API's request validation and the web form. */
export const EQUIVALENCY_LIMITS = {
  setNameMaxLength: 120,
  partLabelMaxLength: 80,
  maxParts: 6,
  maxExamsPerPart: 10,
  maxSubjectsCounted: 20,
  maxGrades: 60,
  gradeMaxLength: 20,
  maxBands: 60,
  maxWeight: 100,
  maxSourceValue: 100000,
} as const;

/** The two decimals an estimate (and every part) is shown with. */
const ESTIMATE_ROUNDING = { decimals: 2, mode: "half_up" } as const;

export interface EquivalencyGradePercentage {
  /** A grade label exactly as recorded ("A*", "B", "7"); matched without case or spaces. */
  grade: string;
  percentage: number;
}

export interface EquivalencyBand {
  /** The lowest source value (total, GPA, score) the band covers. */
  min: number;
  percentage: number;
}

export interface EquivalencyConversion {
  mode: EquivalencyConversionMode;
  /** `table`: the bands, any order. Empty for `linear`. */
  bands: EquivalencyBand[];
  /** `linear`: percentage = intercept + slope x value. Null for `table`. */
  slope: number | null;
  intercept: number | null;
}

/**
 * One part of a rule set. Flat on purpose (one shape for every type; fields a type does not use are
 * empty or null), so it stores as one JSON array and travels through the generated clients.
 */
export interface EquivalencyPartDefinition {
  type: EquivalencyPartType;
  /** Shown in the breakdown: "IGCSE subjects", "SAT". */
  label: string;
  /** Relative weight in the estimate (above 0, at most 100). */
  weight: number;
  /** Missing data in a required part leaves the estimate incomplete; an optional part is skipped. */
  required: boolean;
  /** `exam_subjects`: the catalogue exams counted (1-10). `exam_total`: exactly one. */
  examIds: string[];
  /** `exam_subjects`: how many subjects count, the best first; null: every subject. */
  bestCount: number | null;
  /** `exam_subjects`: the fewest counted subjects for an estimate; null: `bestCount` (or 1). */
  minCount: number | null;
  /** `exam_subjects`: subjects that always count (Arabic, English, Mathematics...). */
  requiredSubjectIds: string[];
  /** `exam_subjects`: the percentage each grade label converts to. */
  gradePercentages: EquivalencyGradePercentage[];
  /** `diploma_total`, `gpa`, `exam_total`: how the value becomes a percentage. */
  conversion: EquivalencyConversion | null;
  /** `diploma_total`: no estimate unless the diploma was awarded. */
  requireAwarded: boolean;
  /** `gpa`: the plain cumulative GPA, or the weighted one (Honors/AP/HL boosts). */
  gpaBasis: EquivalencyGpaBasis | null;
}

// ---------------------------------------------------------------------------------------------
// What a student brings
// ---------------------------------------------------------------------------------------------

export interface EquivalencyExamResultInput {
  examId: string;
  /** Null for an exam taken as a whole (SAT). */
  subjectId: string | null;
  /** The grade label the result shows (its first scored component); null when not scored. */
  grade: string | null;
  /** The computed total; null when the exam has none or a component was not scored. */
  total: number | null;
}

export interface EquivalencyDiplomaInput {
  status: "awarded" | "not_awarded" | "pending";
  total: number | null;
  max: number;
}

export interface EquivalencyStudentInput {
  examResults: readonly EquivalencyExamResultInput[];
  /** The IB Diploma outcome of the latest finalized annual result that has one. */
  diploma: EquivalencyDiplomaInput | null;
  /** The transcript's cumulative GPA (null when it cannot be worked out). */
  gpa: number | null;
  /** The cumulative weighted GPA; null when nothing is boosted (the plain GPA is used then). */
  weightedGpa: number | null;
  /** The GPA's maximum (4, 5); shown beside it. */
  gpaScaleMax: number | null;
  /** The student's current year has no finalized annual result yet (a GPA can still change). */
  currentYearPending: boolean;
}

// ---------------------------------------------------------------------------------------------
// The breakdown
// ---------------------------------------------------------------------------------------------

export type EquivalencyIssueCode =
  | "NO_EXAM_RESULTS"
  | "TOO_FEW_SUBJECTS"
  | "REQUIRED_SUBJECT_MISSING"
  | "UNMAPPED_GRADE"
  | "NO_DIPLOMA_RESULT"
  | "DIPLOMA_PENDING"
  | "DIPLOMA_NOT_AWARDED"
  | "NO_GPA"
  | "NO_EXAM_TOTAL"
  | "BELOW_CONVERSION_TABLE"
  | "CURRENT_YEAR_PENDING"
  | "OPTIONAL_PART_SKIPPED"
  | "NO_PARTS";

/**
 * Why a figure is missing or not final. `missing`: data still to come (results, a diploma, a GPA);
 * `not_eligible`: a rule gives no estimate; `note`: worth knowing, does not block the estimate.
 * Flat: fields that do not apply are null.
 */
export interface EquivalencyIssue {
  code: EquivalencyIssueCode;
  kind: "missing" | "not_eligible" | "note";
  /** The part (0-based), or null for the whole set. */
  partIndex: number | null;
  subjectId: string | null;
  examId: string | null;
  grade: string | null;
  /** What the rule asks for (subjects needed, the table's lowest band). */
  required: number | null;
  /** What the student has. */
  actual: number | null;
}

export interface EquivalencySubjectStep {
  subjectId: string;
  examId: string;
  grade: string;
  /** Null when the grade has no percentage in the part's table. */
  percentage: number | null;
  /** Whether it counts towards the part (best N, or a required subject). */
  counted: boolean;
  /** It counts because the part requires the subject. */
  requiredSubject: boolean;
}

export interface EquivalencyPartResult {
  index: number;
  type: EquivalencyPartType;
  label: string;
  weight: number;
  required: boolean;
  status: EquivalencyPartStatus;
  /** The part's percentage (two decimals); null unless counted. */
  percentage: number | null;
  /** The part's share of the estimate in percent once skipped parts are left out; null if not counted. */
  share: number | null;
  /** The value converted: the diploma total, the GPA or the exam total. Null for exam_subjects. */
  sourceValue: number | null;
  /** The value's maximum when known (45, the GPA scale). */
  sourceMax: number | null;
  /** exam_subjects: every result considered, best first. */
  subjects: EquivalencySubjectStep[];
}

export interface EquivalencyEstimate {
  status: EquivalencyStatus;
  /** The estimated Tawjihi-equivalent percentage; null unless `estimated`. */
  percentage: number | null;
  parts: EquivalencyPartResult[];
  issues: EquivalencyIssue[];
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

const normalizeGrade = (grade: string) => grade.replace(/\s+/g, "").toLowerCase();

const round2 = (value: number) => roundTo(value, ESTIMATE_ROUNDING);

const issue = (
  code: EquivalencyIssueCode,
  kind: EquivalencyIssue["kind"],
  fields: Partial<Omit<EquivalencyIssue, "code" | "kind">> = {},
): EquivalencyIssue => ({
  code,
  kind,
  partIndex: null,
  subjectId: null,
  examId: null,
  grade: null,
  required: null,
  actual: null,
  ...fields,
});

type Converted = { percentage: number } | { below: number };

/** A value through a conversion: a percentage, or the table's lowest minimum when it is below it. */
export function convertEquivalencyValue(
  value: number,
  conversion: EquivalencyConversion,
): Converted {
  if (conversion.mode === "linear") {
    const raw = (conversion.intercept ?? 0) + (conversion.slope ?? 0) * value;
    return { percentage: round2(Math.min(100, Math.max(0, raw))) };
  }
  const bands = [...conversion.bands].sort((a, b) => b.min - a.min);
  const band = bands.find((candidate) => value >= candidate.min - EPSILON);
  if (!band) return { below: bands.at(-1)?.min ?? 0 };
  return { percentage: band.percentage };
}

interface PartOutcome {
  status: EquivalencyPartStatus;
  percentage: number | null;
  sourceValue: number | null;
  sourceMax: number | null;
  subjects: EquivalencySubjectStep[];
  issues: EquivalencyIssue[];
}

function examSubjectsPart(
  part: EquivalencyPartDefinition,
  index: number,
  student: EquivalencyStudentInput,
): PartOutcome {
  const at = { partIndex: index };
  const issues: EquivalencyIssue[] = [];
  const table = new Map(
    part.gradePercentages.map((entry) => [normalizeGrade(entry.grade), entry.percentage]),
  );
  const exams = new Set(part.examIds);
  const results = student.examResults.filter(
    (result) =>
      exams.has(result.examId) && result.subjectId !== null && (result.grade ?? "") !== "",
  );
  const missing = (outcome: Partial<PartOutcome> = {}): PartOutcome => ({
    status: "missing",
    percentage: null,
    sourceValue: null,
    sourceMax: null,
    subjects: [],
    issues,
    ...outcome,
  });
  if (results.length === 0) {
    issues.push(issue("NO_EXAM_RESULTS", "missing", at));
    return missing();
  }

  // Every result with its percentage; the best per subject is the one that may count.
  const steps: EquivalencySubjectStep[] = results.map((result) => {
    const percentage = table.get(normalizeGrade(result.grade!)) ?? null;
    if (percentage === null) {
      issues.push(
        issue("UNMAPPED_GRADE", "note", {
          ...at,
          subjectId: result.subjectId,
          examId: result.examId,
          grade: result.grade,
        }),
      );
    }
    return {
      subjectId: result.subjectId!,
      examId: result.examId,
      grade: result.grade!,
      percentage,
      counted: false,
      requiredSubject: false,
    };
  });
  steps.sort(
    (a, b) =>
      (b.percentage ?? -1) - (a.percentage ?? -1) ||
      a.subjectId.localeCompare(b.subjectId) ||
      a.examId.localeCompare(b.examId),
  );
  const bestPerSubject = new Map<string, EquivalencySubjectStep>();
  for (const step of steps) {
    if (step.percentage !== null && !bestPerSubject.has(step.subjectId)) {
      bestPerSubject.set(step.subjectId, step);
    }
  }

  const requiredIds = [...new Set(part.requiredSubjectIds)];
  for (const subjectId of requiredIds) {
    const step = bestPerSubject.get(subjectId);
    if (step) {
      step.counted = true;
      step.requiredSubject = true;
    } else {
      issues.push(issue("REQUIRED_SUBJECT_MISSING", "missing", { ...at, subjectId }));
    }
  }
  const limit = part.bestCount ?? Number.POSITIVE_INFINITY;
  let counted = [...bestPerSubject.values()].filter((step) => step.counted).length;
  for (const step of bestPerSubject.values()) {
    if (counted >= limit) break;
    if (step.counted) continue;
    step.counted = true;
    counted += 1;
  }
  const countedSteps = steps.filter((step) => step.counted);
  const needed = part.minCount ?? part.bestCount ?? 1;
  if (countedSteps.length < needed) {
    issues.push(
      issue("TOO_FEW_SUBJECTS", "missing", {
        ...at,
        required: needed,
        actual: countedSteps.length,
      }),
    );
  }
  if (issues.some((found) => found.kind === "missing")) return missing({ subjects: steps });
  const mean =
    countedSteps.reduce((total, step) => total + step.percentage!, 0) / countedSteps.length;
  return {
    status: "counted",
    percentage: round2(mean),
    sourceValue: null,
    sourceMax: null,
    subjects: steps,
    issues,
  };
}

function convertedPart(
  index: number,
  value: number,
  max: number | null,
  conversion: EquivalencyConversion,
  issues: EquivalencyIssue[],
): PartOutcome {
  const converted = convertEquivalencyValue(value, conversion);
  if ("below" in converted) {
    issues.push(
      issue("BELOW_CONVERSION_TABLE", "not_eligible", {
        partIndex: index,
        required: converted.below,
        actual: value,
      }),
    );
    return {
      status: "not_eligible",
      percentage: null,
      sourceValue: value,
      sourceMax: max,
      subjects: [],
      issues,
    };
  }
  return {
    status: "counted",
    percentage: converted.percentage,
    sourceValue: value,
    sourceMax: max,
    subjects: [],
    issues,
  };
}

function evaluatePart(
  part: EquivalencyPartDefinition,
  index: number,
  student: EquivalencyStudentInput,
): PartOutcome {
  const at = { partIndex: index };
  const missing = (code: EquivalencyIssueCode, fields = {}): PartOutcome => ({
    status: "missing",
    percentage: null,
    sourceValue: null,
    sourceMax: null,
    subjects: [],
    issues: [issue(code, "missing", { ...at, ...fields })],
  });
  const conversion = part.conversion ?? { mode: "table", bands: [], slope: null, intercept: null };
  switch (part.type) {
    case "exam_subjects":
      return examSubjectsPart(part, index, student);
    case "diploma_total": {
      const diploma = student.diploma;
      if (!diploma) return missing("NO_DIPLOMA_RESULT");
      if (part.requireAwarded && diploma.status === "not_awarded") {
        return {
          status: "not_eligible",
          percentage: null,
          sourceValue: diploma.total,
          sourceMax: diploma.max,
          subjects: [],
          issues: [issue("DIPLOMA_NOT_AWARDED", "not_eligible", at)],
        };
      }
      if (diploma.total === null || (part.requireAwarded && diploma.status === "pending")) {
        return missing("DIPLOMA_PENDING");
      }
      return convertedPart(index, diploma.total, diploma.max, conversion, []);
    }
    case "gpa": {
      const gpa =
        part.gpaBasis === "weighted_gpa" ? (student.weightedGpa ?? student.gpa) : student.gpa;
      if (gpa === null) return missing("NO_GPA");
      const notes = student.currentYearPending ? [issue("CURRENT_YEAR_PENDING", "note", at)] : [];
      return convertedPart(index, gpa, student.gpaScaleMax, conversion, notes);
    }
    case "exam_total": {
      const examId = part.examIds[0] ?? null;
      const totals = student.examResults
        .filter((result) => result.examId === examId && result.total !== null)
        .map((result) => result.total!);
      if (totals.length === 0) return missing("NO_EXAM_TOTAL", { examId });
      return convertedPart(index, Math.max(...totals), null, conversion, []);
    }
  }
}

/** Estimate a student's Tawjihi-equivalent percentage under a rule set (see the module comment). */
export function estimateTawjihiEquivalency(
  parts: readonly EquivalencyPartDefinition[],
  student: EquivalencyStudentInput,
): EquivalencyEstimate {
  const issues: EquivalencyIssue[] = [];
  const results: EquivalencyPartResult[] = parts.map((part, index) => {
    const outcome = evaluatePart(part, index, student);
    let status = outcome.status;
    if ((status === "missing" || status === "not_eligible") && !part.required) {
      status = "skipped";
      // An optional part that cannot count is only a note: the estimate goes on without it.
      issues.push(
        ...outcome.issues.map((found) => ({ ...found, kind: "note" as const })),
        issue("OPTIONAL_PART_SKIPPED", "note", { partIndex: index }),
      );
    } else {
      issues.push(...outcome.issues);
    }
    return {
      index,
      type: part.type,
      label: part.label,
      weight: part.weight,
      required: part.required,
      status,
      percentage: status === "counted" ? outcome.percentage : null,
      share: null,
      sourceValue: outcome.sourceValue,
      sourceMax: outcome.sourceMax,
      subjects: outcome.subjects,
    };
  });

  const counted = results.filter((part) => part.status === "counted");
  const totalWeight = counted.reduce((total, part) => total + part.weight, 0);
  for (const part of counted) part.share = round2((part.weight / totalWeight) * 100);

  let status: EquivalencyStatus;
  if (results.some((part) => part.status === "not_eligible")) status = "not_eligible";
  else if (results.some((part) => part.status === "missing")) status = "incomplete";
  else if (counted.length === 0 || totalWeight <= 0) {
    status = "incomplete";
    issues.push(issue("NO_PARTS", "missing"));
  } else status = "estimated";

  const percentage =
    status === "estimated"
      ? round2(
          counted.reduce((total, part) => total + part.weight * part.percentage!, 0) / totalWeight,
        )
      : null;
  if (status !== "estimated") for (const part of results) part.share = null;
  return { status, percentage, parts: results, issues };
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

const twoDecimals = (value: number) => Math.abs(Math.round(value * 100) - value * 100) < 1e-6;

/**
 * Check a rule set's parts. Errors name what is wrong (prefixed "Part n:"); the API refuses a set
 * with any, and the web form shows the same messages as the user types.
 */
export function validateEquivalencyParts(
  parts: readonly EquivalencyPartDefinition[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (code: string, message: string, ref?: string) =>
    issues.push({ code, severity: "error", message, ...(ref ? { ref } : {}) });
  if (parts.length === 0) error("EQUIVALENCY_NO_PARTS", "Add at least one part.");
  if (parts.length > EQUIVALENCY_LIMITS.maxParts) {
    error(
      "EQUIVALENCY_TOO_MANY_PARTS",
      `A rule set has at most ${EQUIVALENCY_LIMITS.maxParts} parts.`,
    );
  }

  parts.forEach((part, index) => {
    const ref = String(index);
    const fail = (code: string, message: string) =>
      error(code, `Part ${index + 1}: ${message}`, ref);
    const label = part.label.trim();
    if (label === "") fail("EQUIVALENCY_LABEL_REQUIRED", "Name the part.");
    if (label.length > EQUIVALENCY_LIMITS.partLabelMaxLength) {
      fail(
        "EQUIVALENCY_LABEL_TOO_LONG",
        `A name is at most ${EQUIVALENCY_LIMITS.partLabelMaxLength} characters.`,
      );
    }
    if (
      !Number.isFinite(part.weight) ||
      part.weight <= 0 ||
      part.weight > EQUIVALENCY_LIMITS.maxWeight ||
      !twoDecimals(part.weight)
    ) {
      fail("EQUIVALENCY_WEIGHT", "The weight is above 0 and at most 100, with up to two decimals.");
    }
    if (new Set(part.examIds).size !== part.examIds.length) {
      fail("EQUIVALENCY_DUPLICATE_EXAM", "An exam is listed twice.");
    }

    const usesConversion = part.type !== "exam_subjects";
    if (part.type === "exam_subjects") {
      if (part.examIds.length === 0 || part.examIds.length > EQUIVALENCY_LIMITS.maxExamsPerPart) {
        fail("EQUIVALENCY_EXAMS", `Choose 1 to ${EQUIVALENCY_LIMITS.maxExamsPerPart} exams.`);
      }
      const max = EQUIVALENCY_LIMITS.maxSubjectsCounted;
      const best = part.bestCount;
      if (best !== null && (!Number.isInteger(best) || best < 1 || best > max)) {
        fail("EQUIVALENCY_BEST_COUNT", `The subjects counted are 1 to ${max}.`);
      }
      const min = part.minCount;
      if (min !== null && (!Number.isInteger(min) || min < 1 || min > (best ?? max))) {
        fail(
          "EQUIVALENCY_MIN_COUNT",
          "The fewest subjects is at least 1 and at most the subjects counted.",
        );
      }
      if (new Set(part.requiredSubjectIds).size !== part.requiredSubjectIds.length) {
        fail("EQUIVALENCY_DUPLICATE_SUBJECT", "A required subject is listed twice.");
      }
      if (best !== null && part.requiredSubjectIds.length > best) {
        fail("EQUIVALENCY_TOO_MANY_REQUIRED", "More required subjects than subjects counted.");
      }
      const grades = part.gradePercentages;
      if (grades.length === 0 || grades.length > EQUIVALENCY_LIMITS.maxGrades) {
        fail(
          "EQUIVALENCY_GRADES",
          `Give 1 to ${EQUIVALENCY_LIMITS.maxGrades} grades a percentage.`,
        );
      }
      const seen = new Set<string>();
      for (const entry of grades) {
        const key = normalizeGrade(entry.grade);
        if (key === "" || entry.grade.trim().length > EQUIVALENCY_LIMITS.gradeMaxLength) {
          fail(
            "EQUIVALENCY_GRADE_LABEL",
            `A grade is 1 to ${EQUIVALENCY_LIMITS.gradeMaxLength} characters.`,
          );
        } else if (seen.has(key)) {
          fail("EQUIVALENCY_DUPLICATE_GRADE", `The grade "${entry.grade.trim()}" is listed twice.`);
        }
        seen.add(key);
        if (!isPercentage(entry.percentage)) {
          fail("EQUIVALENCY_PERCENTAGE", "A percentage is 0 to 100, with up to two decimals.");
        }
      }
      if (part.conversion !== null) {
        fail(
          "EQUIVALENCY_CONVERSION_NOT_ALLOWED",
          "Subject grades use the grade table, not a conversion.",
        );
      }
    } else {
      if (part.type === "exam_total" && part.examIds.length !== 1) {
        fail("EQUIVALENCY_EXAM_REQUIRED", "Choose the exam.");
      }
      if (part.type !== "exam_total" && part.examIds.length > 0) {
        fail("EQUIVALENCY_EXAMS_NOT_ALLOWED", "Only exam parts name exams.");
      }
      if (part.bestCount !== null || part.minCount !== null || part.requiredSubjectIds.length > 0) {
        fail("EQUIVALENCY_SUBJECTS_NOT_ALLOWED", "Only subject grade parts count subjects.");
      }
      if (part.gradePercentages.length > 0) {
        fail("EQUIVALENCY_GRADES_NOT_ALLOWED", "Only subject grade parts have a grade table.");
      }
    }
    if (part.type === "gpa" && part.gpaBasis === null) {
      fail("EQUIVALENCY_GPA_BASIS", "Choose the GPA or the weighted GPA.");
    }
    if (part.type !== "gpa" && part.gpaBasis !== null) {
      fail("EQUIVALENCY_GPA_BASIS_NOT_ALLOWED", "Only GPA parts choose a GPA.");
    }
    if (part.type !== "diploma_total" && part.requireAwarded) {
      fail("EQUIVALENCY_AWARDED_NOT_ALLOWED", "Only IB Diploma parts can require the diploma.");
    }

    if (usesConversion) {
      const conversion = part.conversion;
      if (conversion === null) {
        fail("EQUIVALENCY_CONVERSION_REQUIRED", "Set how the value converts to a percentage.");
      } else if (conversion.mode === "table") {
        const bands = conversion.bands;
        if (bands.length === 0 || bands.length > EQUIVALENCY_LIMITS.maxBands) {
          fail("EQUIVALENCY_BANDS", `Give the table 1 to ${EQUIVALENCY_LIMITS.maxBands} rows.`);
        }
        if (new Set(bands.map((band) => band.min)).size !== bands.length) {
          fail("EQUIVALENCY_DUPLICATE_BAND", "Two rows of the table start at the same value.");
        }
        for (const band of bands) {
          if (
            !Number.isFinite(band.min) ||
            band.min < 0 ||
            band.min > EQUIVALENCY_LIMITS.maxSourceValue ||
            !twoDecimals(band.min)
          ) {
            fail("EQUIVALENCY_BAND_MIN", "A row starts at 0 or more, with up to two decimals.");
          }
          if (!isPercentage(band.percentage)) {
            fail("EQUIVALENCY_PERCENTAGE", "A percentage is 0 to 100, with up to two decimals.");
          }
        }
        if (conversion.slope !== null || conversion.intercept !== null) {
          fail("EQUIVALENCY_LINEAR_NOT_ALLOWED", "A table has no slope or intercept.");
        }
      } else {
        const { slope, intercept } = conversion;
        if (
          slope === null ||
          intercept === null ||
          !Number.isFinite(slope) ||
          !Number.isFinite(intercept) ||
          Math.abs(slope) > 1000 ||
          Math.abs(intercept) > 1000
        ) {
          fail(
            "EQUIVALENCY_LINEAR",
            "A formula needs a slope and an intercept between -1000 and 1000.",
          );
        }
        if (conversion.bands.length > 0) {
          fail("EQUIVALENCY_BANDS_NOT_ALLOWED", "A formula has no table rows.");
        }
      }
    }
  });
  return issues;
}

function isPercentage(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100 && twoDecimals(value);
}

// ---------------------------------------------------------------------------------------------
// Example rule sets
// ---------------------------------------------------------------------------------------------

/** An example part: `examPresetKeys` name the catalogue presets the web fills `examIds` from. */
export interface EquivalencyExamplePart extends EquivalencyPartDefinition {
  examPresetKeys: string[];
}

export interface EquivalencyExample {
  sourceSystem: EquivalencySourceSystem;
  parts: EquivalencyExamplePart[];
}

const examplePart = (
  fields: Partial<EquivalencyExamplePart> & Pick<EquivalencyExamplePart, "type" | "label">,
): EquivalencyExamplePart => ({
  weight: 100,
  required: true,
  examIds: [],
  bestCount: null,
  minCount: null,
  requiredSubjectIds: [],
  gradePercentages: [],
  conversion: null,
  requireAwarded: false,
  gpaBasis: null,
  examPresetKeys: [],
  ...fields,
});

const table = (rows: readonly (readonly [number, number])[]): EquivalencyConversion => ({
  mode: "table",
  bands: rows.map(([min, percentage]) => ({ min, percentage })),
  slope: null,
  intercept: null,
});

const grades = (rows: readonly (readonly [string, number])[]): EquivalencyGradePercentage[] =>
  rows.map(([grade, percentage]) => ({ grade, percentage }));

/**
 * EXAMPLE starting points, one per source system. They are NOT the Ministry of Education's
 * conversion rules (which differ by year and change): every number is an editable placeholder the
 * school replaces with the rules it has been given. The web labels them as examples.
 */
export const EQUIVALENCY_EXAMPLES: readonly EquivalencyExample[] = [
  {
    sourceSystem: "igcse_a_level",
    parts: [
      examplePart({
        type: "exam_subjects",
        label: "IGCSE / O Level subjects",
        weight: 70,
        bestCount: 8,
        minCount: 8,
        examPresetKeys: ["igcse_letter", "igcse_numeric"],
        gradePercentages: grades([
          ["A*", 98],
          ["A", 93],
          ["B", 85],
          ["C", 75],
          ["D", 65],
          ["E", 55],
          ["9", 98],
          ["8", 95],
          ["7", 90],
          ["6", 85],
          ["5", 80],
          ["4", 75],
          ["3", 65],
          ["2", 55],
        ]),
      }),
      examplePart({
        type: "exam_subjects",
        label: "A Level subjects",
        weight: 30,
        required: false,
        bestCount: 2,
        minCount: 2,
        examPresetKeys: ["a_level"],
        gradePercentages: grades([
          ["A*", 98],
          ["A", 93],
          ["B", 85],
          ["C", 75],
          ["D", 65],
          ["E", 55],
        ]),
      }),
    ],
  },
  {
    sourceSystem: "ib",
    parts: [
      examplePart({
        type: "diploma_total",
        label: "IB Diploma total",
        requireAwarded: true,
        conversion: table([
          [42, 99],
          [38, 95],
          [35, 90],
          [32, 85],
          [29, 80],
          [26, 75],
          [24, 70],
        ]),
      }),
    ],
  },
  {
    sourceSystem: "american",
    parts: [
      examplePart({
        type: "gpa",
        label: "Cumulative GPA",
        weight: 70,
        gpaBasis: "gpa",
        conversion: table([
          [3.9, 98],
          [3.7, 95],
          [3.5, 92],
          [3.3, 88],
          [3, 85],
          [2.7, 80],
          [2.3, 75],
          [2, 70],
          [1, 60],
        ]),
      }),
      examplePart({
        type: "exam_total",
        label: "SAT",
        weight: 30,
        required: false,
        examPresetKeys: ["sat"],
        conversion: table([
          [1500, 99],
          [1400, 95],
          [1300, 90],
          [1200, 85],
          [1100, 80],
          [1000, 75],
          [900, 70],
          [400, 60],
        ]),
      }),
    ],
  },
];
