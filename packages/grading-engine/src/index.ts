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
export { GPA_ROUNDING, calculateCumulativeResult, creditTotals } from "./cumulative";
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
  EXAM_ENTRY_LIMITS,
  EXAM_ENTRY_STATUSES,
  canChangeExamEntryStatus,
  nextCandidateNumbers,
} from "./exam-entries";
export type { CandidateNumberPlan, ExamEntryStatus } from "./exam-entries";
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
export {
  GRADUATION_LIMITS,
  GRADUATION_RULE_TYPES,
  evaluateGraduationRequirements,
  validateGraduationRule,
} from "./graduation";
export type {
  GraduationEvaluation,
  GraduationEvaluationInput,
  GraduationExamResultInput,
  GraduationRuleDefinition,
  GraduationRuleEvaluation,
  GraduationRuleType,
  GraduationStatus,
  GraduationSubjectInput,
  GraduationYearInput,
} from "./graduation";
export {
  MINISTRY_EXPORT_ANNUAL_TERM,
  MINISTRY_EXPORT_ENCODINGS,
  MINISTRY_EXPORT_EXAMPLES,
  MINISTRY_EXPORT_EXAMPLE_KEYS,
  MINISTRY_EXPORT_FIELDS,
  MINISTRY_EXPORT_FILE_FORMATS,
  MINISTRY_EXPORT_LIMITS,
  MINISTRY_EXPORT_NUMERIC_FIELDS,
  MINISTRY_EXPORT_OVERALL_STATUSES,
  MINISTRY_EXPORT_ROW_KINDS,
  MINISTRY_EXPORT_SUBJECT_FIELDS,
  MINISTRY_EXPORT_SUBJECT_STATUSES,
  applyValueMap,
  buildMinistryExport,
  formatExportNumber,
  ministryExportExample,
  validateMinistryExportTemplate,
} from "./ministry-export";
export type {
  MinistryExportColumnDefinition,
  MinistryExportContext,
  MinistryExportEncoding,
  MinistryExportExample,
  MinistryExportExampleKey,
  MinistryExportField,
  MinistryExportFileFormat,
  MinistryExportIssue,
  MinistryExportIssueCode,
  MinistryExportOutput,
  MinistryExportRowKind,
  MinistryExportSourceRow,
  MinistryExportTemplateDefinition,
  MinistryExportValueMapEntry,
} from "./ministry-export";
