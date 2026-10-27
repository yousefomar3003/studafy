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
export {
  calculateCategory,
  calculateOverallResult,
  calculateSubjectResult,
  resolveAssessment,
} from "./calculate";
