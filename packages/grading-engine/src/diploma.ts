import { roundTo } from "./rounding";

import type { RoundingRule, ValidationIssue } from "./types";

/**
 * IB Diploma total (points out of 45): the `points_total` result format.
 *
 * A diploma candidate's total is the points (1-7) of their best counted subjects (six DP subjects)
 * plus core points from the Theory of Knowledge (TOK) and Extended Essay (EE) grades, read from a
 * bonus matrix (TOK grade x EE grade, A-E). CAS (creativity, activity, service) carries no points;
 * it is complete or not. The diploma is awarded when no award condition fails.
 *
 * Everything that is the awarding body's rule is data the school edits: how many subjects count, the
 * matrix and the conditions. {@link DEFAULT_DIPLOMA_CONFIG} is the published IB matrix and the main
 * failing conditions as an editable default; a school must check it against the current IB rules.
 *
 * The rules, in one place:
 *
 *  - Subject points: the subject's grade-band points (`gpaPoints`) for every subject counted in the
 *    average (not exempt, not descriptive). The best `countedSubjects` count; fewer than that is the
 *    `TOO_FEW_SUBJECTS` failing condition. An incomplete counted subject, or one whose band has no
 *    points, leaves the subject points (and the total) unknown: the result is `pending`.
 *  - Core points: the matrix cell for the TOK and EE grades. Either grade missing leaves them (and
 *    the total) unknown: `pending`.
 *  - Total: subject points + core points, when both are known.
 *  - Conditions are checked on what is known. A condition that cannot be checked yet (the minimum
 *    total without a total, CAS not recorded) does not fail; it keeps the result pending.
 *  - Status: `not_awarded` when any condition fails (even while something else is pending: a grade
 *    E in TOK cannot be undone by the missing EE grade), otherwise `pending` while anything is
 *    missing, otherwise `awarded`.
 *  - A level condition (at least 12 points at HL) applies only when some counted subject has that
 *    course level: a school that never sets HL/SL is not failed on it.
 */

/** TOK and Extended Essay grades, best first. */
export const CORE_GRADES = ["A", "B", "C", "D", "E"] as const;
export type CoreGrade = (typeof CORE_GRADES)[number];

/** The core component a failing condition is about. */
export type CoreComponent = "tok" | "ee";

export interface DiplomaMatrixCell {
  tok: CoreGrade;
  ee: CoreGrade;
  points: number;
}

export type DiplomaConditionType =
  /** The total must reach `value`. */
  | "min_total"
  /** CAS must be complete. */
  | "cas_complete"
  /** Neither TOK nor EE may be graded `grade`. */
  | "core_grade_not"
  /** At most `value` counted subjects may have `points` or fewer. */
  | "max_subjects_at_or_below"
  /** The counted subjects at course level `level` (the best `bestOf`, when set) reach `value`. */
  | "min_level_points";

export const DIPLOMA_CONDITION_TYPES: readonly DiplomaConditionType[] = [
  "min_total",
  "cas_complete",
  "core_grade_not",
  "max_subjects_at_or_below",
  "min_level_points",
];

/**
 * One award condition. Flat (every field present, unused ones null) so the API and the generated
 * clients carry it as one plain object.
 */
export interface DiplomaCondition {
  type: DiplomaConditionType;
  /** min_total: the minimum total. max_subjects_at_or_below: the most subjects allowed. min_level_points: the minimum points. */
  value: number | null;
  /** max_subjects_at_or_below: the subject points at or below which a subject is counted. */
  points: number | null;
  /** core_grade_not: the grade TOK and EE may not have. */
  grade: CoreGrade | null;
  /** min_level_points: the course level ("HL", "SL"), compared without case. */
  level: string | null;
  /** min_level_points: only the best N subjects at the level count; null for all of them. */
  bestOf: number | null;
}

export interface DiplomaConfig {
  /** How many subjects' points count (six DP subjects): the best ones. */
  countedSubjects: number;
  /** Core points per TOK x EE grade: all 25 cells. */
  coreMatrix: readonly DiplomaMatrixCell[];
  conditions: readonly DiplomaCondition[];
}

/** One subject as the diploma total reads it. */
export interface DiplomaSubjectInput {
  subjectId: string;
  /** The subject's points (its grade band's points); null when incomplete or the band has none. */
  points: number | null;
  /** Course level label (HL, SL); null when the subject has none. */
  level: string | null;
}

/** A student's core grades; null for what is not recorded yet. */
export interface DiplomaCoreInput {
  tok: CoreGrade | null;
  ee: CoreGrade | null;
  casComplete: boolean | null;
}

export type DiplomaStatus = "awarded" | "not_awarded" | "pending";

export type DiplomaFailingCode =
  | "TOO_FEW_SUBJECTS"
  | "MIN_TOTAL"
  | "CAS_INCOMPLETE"
  | "CORE_GRADE"
  | "SUBJECTS_AT_OR_BELOW"
  | "LEVEL_POINTS";

/** A failing condition, flat like {@link DiplomaCondition}: fields that do not apply are null. */
export interface DiplomaFailingCondition {
  code: DiplomaFailingCode;
  /** What the rule asks for: the minimum total or points, the most subjects, the subjects needed. */
  required: number | null;
  /** What the student has. */
  actual: number | null;
  /** CORE_GRADE: which component. */
  component: CoreComponent | null;
  /** CORE_GRADE: the grade that fails. */
  grade: CoreGrade | null;
  /** LEVEL_POINTS: the course level. */
  level: string | null;
  /** SUBJECTS_AT_OR_BELOW: the subject points counted. */
  points: number | null;
}

export type DiplomaPendingReason =
  "subjects_incomplete" | "core_grades_missing" | "cas_not_recorded";

export interface DiplomaResult {
  status: DiplomaStatus;
  /** Subject points + core points; null while either is unknown. */
  total: number | null;
  /** The total's maximum (45). */
  max: number;
  /** Points of the counted subjects; null while a counted subject has none. */
  subjectPoints: number | null;
  /** Core points from the matrix; null while TOK or EE is not graded. */
  corePoints: number | null;
  /** The subjects whose points count, best first. */
  countedSubjectIds: string[];
  tok: CoreGrade | null;
  ee: CoreGrade | null;
  casComplete: boolean | null;
  failingConditions: DiplomaFailingCondition[];
  /** Why the status is pending (also listed beside a not_awarded status, for completeness). */
  pendingReasons: DiplomaPendingReason[];
}

const condition = (fields: Partial<DiplomaCondition> & { type: DiplomaConditionType }) =>
  ({
    value: null,
    points: null,
    grade: null,
    level: null,
    bestOf: null,
    ...fields,
  }) satisfies DiplomaCondition;

/**
 * The IB bonus matrix (TOK x EE) as published for diplomas from 2015: rows are the TOK grade,
 * columns the EE grade, A to E. An E in either earns no points and is a failing condition.
 */
const IB_MATRIX: readonly (readonly number[])[] = [
  //   A  B  C  D  E   (Extended Essay)
  [3, 3, 2, 2, 0], // TOK A
  [3, 2, 2, 1, 0], // TOK B
  [2, 2, 1, 0, 0], // TOK C
  [2, 1, 0, 0, 0], // TOK D
  [0, 0, 0, 0, 0], // TOK E
];

export const DEFAULT_DIPLOMA_CORE_MATRIX: readonly DiplomaMatrixCell[] = CORE_GRADES.flatMap(
  (tok, row) =>
    CORE_GRADES.map((ee, column) => ({ tok, ee, points: IB_MATRIX.at(row)!.at(column)! })),
);

/**
 * Editable defaults: the published IB matrix and the main IB failing conditions. Schools must check
 * them against the IB rules in force for their exam session.
 */
export const DEFAULT_DIPLOMA_CONFIG: DiplomaConfig = {
  countedSubjects: 6,
  coreMatrix: DEFAULT_DIPLOMA_CORE_MATRIX,
  conditions: [
    condition({ type: "min_total", value: 24 }),
    condition({ type: "cas_complete" }),
    condition({ type: "core_grade_not", grade: "E" }),
    // No grade 1 in any subject.
    condition({ type: "max_subjects_at_or_below", points: 1, value: 0 }),
    // Grade 2 awarded three or more times fails.
    condition({ type: "max_subjects_at_or_below", points: 2, value: 2 }),
    // Grade 3 or below awarded four or more times fails.
    condition({ type: "max_subjects_at_or_below", points: 3, value: 3 }),
    // At least 12 points at HL (the best three HL subjects when four are taken).
    condition({ type: "min_level_points", level: "HL", value: 12, bestOf: 3 }),
    // At least 9 points at SL.
    condition({ type: "min_level_points", level: "SL", value: 9 }),
  ],
};

/** The default maximum: six subjects at 7 plus three core points. */
export const DEFAULT_DIPLOMA_MAX = 45;

/** Limits the API and the settings form share. */
export const DIPLOMA_LIMITS = {
  maxCountedSubjects: 12,
  maxCorePoints: 10,
  maxConditions: 20,
  maxConditionValue: 1000,
  maxLevelLength: 40,
} as const;

/** Totals keep three decimals (numeric(9,3)); points are usually whole numbers anyway. */
const POINTS_ROUNDING: RoundingRule = { decimals: 3, mode: "half_up" };

/** Core points for a TOK and EE grade; null while either is missing (or the matrix lacks the cell). */
export function corePoints(
  matrix: readonly DiplomaMatrixCell[],
  tok: CoreGrade | null,
  ee: CoreGrade | null,
): number | null {
  if (tok === null || ee === null) return null;
  return matrix.find((cell) => cell.tok === tok && cell.ee === ee)?.points ?? null;
}

const sameLevel = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.trim().toLowerCase() === b.trim().toLowerCase();

const failing = (
  fields: Partial<DiplomaFailingCondition> & { code: DiplomaFailingCode },
): DiplomaFailingCondition => ({
  required: null,
  actual: null,
  component: null,
  grade: null,
  level: null,
  points: null,
  ...fields,
});

/** Work out a diploma result. Pure: see the module comment for the rules. */
export function calculateDiplomaResult(
  subjects: readonly DiplomaSubjectInput[],
  core: DiplomaCoreInput,
  config: DiplomaConfig,
  max: number,
): DiplomaResult {
  const pendingReasons: DiplomaPendingReason[] = [];
  const failingConditions: DiplomaFailingCondition[] = [];

  const subjectsKnown = subjects.every((subject) => subject.points !== null);
  if (!subjectsKnown) pendingReasons.push("subjects_incomplete");
  const counted = subjectsKnown
    ? [...subjects]
        .map((subject, order) => ({ ...subject, points: subject.points!, order }))
        .sort((a, b) => b.points - a.points || a.order - b.order)
        .slice(0, config.countedSubjects)
    : [];
  const subjectPoints = subjectsKnown
    ? roundTo(
        counted.reduce((total, subject) => total + subject.points, 0),
        POINTS_ROUNDING,
      )
    : null;
  if (subjectsKnown && counted.length < config.countedSubjects) {
    failingConditions.push(
      failing({
        code: "TOO_FEW_SUBJECTS",
        required: config.countedSubjects,
        actual: counted.length,
      }),
    );
  }

  const coreTotal = corePoints(config.coreMatrix, core.tok, core.ee);
  if (core.tok === null || core.ee === null) pendingReasons.push("core_grades_missing");
  const total =
    subjectPoints === null || coreTotal === null
      ? null
      : roundTo(subjectPoints + coreTotal, POINTS_ROUNDING);

  for (const rule of config.conditions) {
    switch (rule.type) {
      case "min_total": {
        const required = rule.value ?? 0;
        if (total !== null && total < required) {
          failingConditions.push(failing({ code: "MIN_TOTAL", required, actual: total }));
        }
        break;
      }
      case "cas_complete":
        if (core.casComplete === false) failingConditions.push(failing({ code: "CAS_INCOMPLETE" }));
        else if (core.casComplete === null && !pendingReasons.includes("cas_not_recorded")) {
          pendingReasons.push("cas_not_recorded");
        }
        break;
      case "core_grade_not":
        for (const [component, grade] of [
          ["tok", core.tok],
          ["ee", core.ee],
        ] as const) {
          if (grade !== null && grade === rule.grade) {
            failingConditions.push(failing({ code: "CORE_GRADE", component, grade }));
          }
        }
        break;
      case "max_subjects_at_or_below": {
        if (!subjectsKnown || rule.points === null) break;
        const allowed = rule.value ?? 0;
        const count = counted.filter((subject) => subject.points <= rule.points!).length;
        if (count > allowed) {
          failingConditions.push(
            failing({
              code: "SUBJECTS_AT_OR_BELOW",
              points: rule.points,
              required: allowed,
              actual: count,
            }),
          );
        }
        break;
      }
      case "min_level_points": {
        if (!subjectsKnown) break;
        const atLevel = counted.filter((subject) => sameLevel(subject.level, rule.level));
        if (atLevel.length === 0) break;
        const best = rule.bestOf === null ? atLevel : atLevel.slice(0, rule.bestOf);
        const actual = roundTo(
          best.reduce((sum, subject) => sum + subject.points, 0),
          POINTS_ROUNDING,
        );
        const required = rule.value ?? 0;
        if (actual < required) {
          failingConditions.push(
            failing({ code: "LEVEL_POINTS", level: rule.level, required, actual }),
          );
        }
        break;
      }
    }
  }

  return {
    status:
      failingConditions.length > 0
        ? "not_awarded"
        : pendingReasons.length > 0
          ? "pending"
          : "awarded",
    total,
    max,
    subjectPoints,
    corePoints: coreTotal,
    countedSubjectIds: counted.map((subject) => subject.subjectId),
    tok: core.tok,
    ee: core.ee,
    casComplete: core.casComplete,
    failingConditions,
    pendingReasons,
  };
}

export function isCoreGrade(value: unknown): value is CoreGrade {
  return typeof value === "string" && (CORE_GRADES as readonly string[]).includes(value);
}

/**
 * A diploma configuration's problems: every matrix cell exactly once with whole points 0-10, a
 * sensible number of counted subjects, and each condition carrying the fields its type needs.
 */
export function validateDiplomaConfig(config: DiplomaConfig, max: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (code: string, message: string) =>
    issues.push({ code, severity: "error", message });

  if (
    !Number.isInteger(config.countedSubjects) ||
    config.countedSubjects < 1 ||
    config.countedSubjects > DIPLOMA_LIMITS.maxCountedSubjects
  ) {
    error(
      "DIPLOMA_COUNTED_SUBJECTS",
      `Count between 1 and ${DIPLOMA_LIMITS.maxCountedSubjects} subjects.`,
    );
  }

  const seen = new Set<string>();
  for (const cell of config.coreMatrix) {
    const key = `${cell.tok}|${cell.ee}`;
    if (!isCoreGrade(cell.tok) || !isCoreGrade(cell.ee) || seen.has(key)) {
      error("DIPLOMA_MATRIX_CELLS", "The core matrix needs each TOK and EE grade pair once.");
      break;
    }
    seen.add(key);
    if (
      !Number.isInteger(cell.points) ||
      cell.points < 0 ||
      cell.points > DIPLOMA_LIMITS.maxCorePoints
    ) {
      error(
        "DIPLOMA_MATRIX_POINTS",
        `Core points are whole numbers from 0 to ${DIPLOMA_LIMITS.maxCorePoints}.`,
      );
      break;
    }
  }
  if (
    seen.size !== CORE_GRADES.length ** 2 &&
    !issues.some((i) => i.code.startsWith("DIPLOMA_MATRIX"))
  ) {
    error("DIPLOMA_MATRIX_CELLS", "The core matrix needs all 25 TOK and EE grade pairs.");
  }

  if (config.conditions.length > DIPLOMA_LIMITS.maxConditions) {
    error("DIPLOMA_CONDITIONS", `At most ${DIPLOMA_LIMITS.maxConditions} award conditions.`);
  }
  const numberOk = (value: number | null) =>
    value !== null && value >= 0 && value <= DIPLOMA_LIMITS.maxConditionValue;
  for (const rule of config.conditions) {
    const ok = (() => {
      switch (rule.type) {
        case "min_total":
          return numberOk(rule.value);
        case "cas_complete":
          return true;
        case "core_grade_not":
          return isCoreGrade(rule.grade);
        case "max_subjects_at_or_below":
          return numberOk(rule.points) && numberOk(rule.value) && Number.isInteger(rule.value);
        case "min_level_points":
          return (
            numberOk(rule.value) &&
            rule.level !== null &&
            rule.level.trim() !== "" &&
            rule.level.length <= DIPLOMA_LIMITS.maxLevelLength &&
            (rule.bestOf === null ||
              (Number.isInteger(rule.bestOf) &&
                rule.bestOf >= 1 &&
                rule.bestOf <= DIPLOMA_LIMITS.maxCountedSubjects))
          );
        default:
          return false;
      }
    })();
    if (!ok) {
      error(
        "DIPLOMA_CONDITION_INVALID",
        `The "${String(rule.type)}" award condition is missing a value or has one out of range.`,
      );
    }
    if (rule.type === "min_total" && rule.value !== null && rule.value > max) {
      issues.push({
        code: "DIPLOMA_MIN_TOTAL_ABOVE_MAX",
        severity: "warning",
        message: `The minimum total (${rule.value}) is above the maximum (${max}).`,
      });
    }
  }
  return issues;
}
