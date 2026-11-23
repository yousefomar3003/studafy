/**
 * @studafy/grading-engine — the one place Studafy turns marks into grades.
 *
 * The admin dashboard, the teacher mark sheet preview, result finalization, report cards and
 * certificates all call these functions; none of them computes a percentage on its own. The
 * package is pure (no database, no clock) so the web app can run the same validation the API
 * enforces, and a finalized result can be recomputed from its stored configuration snapshot.
 */

export * from "./types";
export {
  EPSILON,
  WEIGHT_TOLERANCE,
  atLeast,
  matchBand,
  roundTo,
  validateGradeScale,
} from "./rounding";
export { hasErrors, summarizeWeights, validateSubjectConfig } from "./validation";
export type { SubjectWeighting } from "./validation";
export {
  calculateCategory,
  calculateOverallResult,
  calculateSubjectResult,
  resolveAssessment,
  resultDisplay,
} from "./calculate";
export { GPA_ROUNDING, calculateCumulativeResult } from "./cumulative";
export type {
  CumulativeGpaUnavailableReason,
  CumulativeResult,
  CumulativeSubjectInput,
  CumulativeYearInput,
} from "./cumulative";
export { calculateRanks, rankValue, topRanked, validateRankSettings } from "./rank";
export type { RankBasis, RankCandidate, RankOutcome, RankScope, RankedStudent } from "./rank";
export {
  calculateDescriptiveResult,
  descriptorsWithPoints,
  nearestDescriptor,
  validateDescriptiveConfig,
} from "./descriptive";
export {
  EXTERNAL_EXAM_LIMITS,
  EXTERNAL_EXAM_PRESETS,
  EXTERNAL_EXAM_PRESET_KEYS,
  computeExternalExamTotal,
  externalExamPreset,
  isOnStep,
  roundToStep,
  validateExternalExamDefinition,
  validateExternalExamScore,
} from "./external-exams";
export type {
  ExternalExamComponentDefinition,
  ExternalExamDefinition,
  ExternalExamPreset,
  ExternalExamPresetKey,
  ExternalExamScoreType,
  ExternalExamScoreValue,
  ExternalExamTotalMode,
} from "./external-exams";
export {
  CURRICULUM_TEMPLATE_IDS,
  CURRICULUM_TEMPLATES,
  MYP_TOTAL_BOUNDARIES,
  buildTemplateTermStructure,
  equalTermWeights,
  getCurriculumTemplate,
  localize,
  templateScaleBands,
} from "./templates";
export type {
  CurriculumFamily,
  CurriculumTemplate,
  CurriculumTemplateId,
  LocalizedText,
  TemplateBand,
  TemplateCategory,
  TemplateCourseLevel,
  TemplateDescriptor,
  TemplateLocale,
  TemplateStructure,
  TemplateSubjectDefaults,
  TemplateTermStructure,
} from "./templates";
