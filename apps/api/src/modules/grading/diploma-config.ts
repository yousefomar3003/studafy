import { DEFAULT_DIPLOMA_CONFIG } from "@studafy/grading-engine";

import type { ProgramRow } from "./engine-config";
import type { CoreGrade, DiplomaConditionType, DiplomaConfig } from "@studafy/grading-engine";

/**
 * A points_total grade's IB Diploma rules (000263) in the API's snake_case shape, as stored in
 * app.grade_programs.diploma_config, and their engine form. No other grading module is imported
 * here, so engine-config can use it without an import cycle.
 */

// ---------------------------------------------------------------------------
// Settings: the API shape of the engine's DiplomaConfig
// ---------------------------------------------------------------------------

export interface DiplomaConditionJson {
  type: DiplomaConditionType;
  value: number | null;
  points: number | null;
  grade: CoreGrade | null;
  level: string | null;
  best_of: number | null;
}

export interface DiplomaConfigJson {
  counted_subjects: number;
  core_matrix: { tok: CoreGrade; ee: CoreGrade; points: number }[];
  conditions: DiplomaConditionJson[];
}

export function toEngineDiplomaConfig(json: DiplomaConfigJson): DiplomaConfig {
  return {
    countedSubjects: json.counted_subjects,
    coreMatrix: json.core_matrix.map(({ tok, ee, points }) => ({ tok, ee, points })),
    conditions: json.conditions.map((condition) => ({
      type: condition.type,
      value: condition.value ?? null,
      points: condition.points ?? null,
      grade: condition.grade ?? null,
      level: condition.level?.trim() || null,
      bestOf: condition.best_of ?? null,
    })),
  };
}

export function fromEngineDiplomaConfig(config: DiplomaConfig): DiplomaConfigJson {
  return {
    counted_subjects: config.countedSubjects,
    core_matrix: config.coreMatrix.map(({ tok, ee, points }) => ({ tok, ee, points })),
    conditions: config.conditions.map((condition) => ({
      type: condition.type,
      value: condition.value,
      points: condition.points,
      grade: condition.grade,
      level: condition.level,
      best_of: condition.bestOf,
    })),
  };
}

/** The published IB matrix and conditions, as a new points_total grade starts with them. */
export function defaultDiplomaConfigJson(): DiplomaConfigJson {
  return fromEngineDiplomaConfig(DEFAULT_DIPLOMA_CONFIG);
}

/** A program's diploma rules for the engine; undefined unless its result is the points total. */
export function programDiplomaConfig(
  program: Pick<ProgramRow, "result_format" | "diploma_config">,
): DiplomaConfig | undefined {
  if (program.result_format !== "points_total") return undefined;
  return program.diploma_config
    ? toEngineDiplomaConfig(program.diploma_config)
    : DEFAULT_DIPLOMA_CONFIG;
}
