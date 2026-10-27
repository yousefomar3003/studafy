import { ApiError } from "@studafy/api-client";
import { ERROR_CODES } from "@studafy/constants";

import type { TFunction } from "i18next";

/** Problem codes the academic setup screens explain in their own words. */
const EXPLAINED_CODES: readonly string[] = [
  ERROR_CODES.ACADEMIC_CONFIG_INVALID,
  ERROR_CODES.ACADEMIC_CONFIG_LOCKED,
  ERROR_CODES.ACADEMIC_CONFIG_IMPACT_UNCONFIRMED,
  ERROR_CODES.ACADEMIC_YEAR_NOT_ACTIVE,
  ERROR_CODES.GRADE_PROGRAM_NOT_FOUND,
  ERROR_CODES.SUBJECT_CONFIG_NOT_FOUND,
  ERROR_CODES.SUBJECT_CONFIG_DUPLICATE,
  ERROR_CODES.SUBJECT_CONFIG_IN_USE,
  ERROR_CODES.SECTION_OVERRIDE_HAS_MARKS,
  ERROR_CODES.TEACHER_ASSIGNMENT_DUPLICATE,
  ERROR_CODES.MARKS_LOCKED,
  ERROR_CODES.MARK_SCORE_OUT_OF_RANGE,
  ERROR_CODES.RESULTS_INCOMPLETE,
  ERROR_CODES.RESULTS_ALREADY_FINALIZED,
  ERROR_CODES.RESULT_FINALIZATION_NOT_FOUND,
  ERROR_CODES.CERTIFICATE_BLOCKED,
  ERROR_CODES.CERTIFICATE_NOT_FOUND,
  ERROR_CODES.CONFLICT_STATE_MISMATCH,
  ERROR_CODES.GRADE_CONCURRENT_EDIT,
  ERROR_CODES.VALIDATION_FAILED,
  ERROR_CODES.AUTHZ_FORBIDDEN,
];

/**
 * Codes whose server `detail` names the specifics (which students are incomplete, which weights
 * are off, which assessment already has marks) — the explanation alone would leave the admin
 * guessing, so the detail is shown after it.
 */
const DETAIL_CODES: readonly string[] = [
  ERROR_CODES.ACADEMIC_CONFIG_INVALID,
  ERROR_CODES.ACADEMIC_CONFIG_IMPACT_UNCONFIRMED,
  ERROR_CODES.SUBJECT_CONFIG_IN_USE,
  ERROR_CODES.MARK_SCORE_OUT_OF_RANGE,
  ERROR_CODES.RESULTS_INCOMPLETE,
  ERROR_CODES.CONFLICT_STATE_MISMATCH,
  ERROR_CODES.VALIDATION_FAILED,
];

export function isProblem(error: unknown, code: string): boolean {
  return error instanceof ApiError && error.code === code;
}

/**
 * A readable sentence for a failed request. The API answers with RFC 9457 problem+json carrying a
 * stable `code`; known codes are explained in the active language, anything else falls back to the
 * server's own `detail` (or a generic "try again").
 */
export function problemMessage(error: unknown, t: TFunction): string {
  if (!(error instanceof ApiError)) return t("academicGrading.errors.generic");
  const code = error.code;
  if (code && EXPLAINED_CODES.includes(code)) {
    const explanation = t(`academicGrading.errors.codes.${code}`);
    return DETAIL_CODES.includes(code) && error.detail
      ? t("academicGrading.errors.withDetail", { explanation, detail: error.detail })
      : explanation;
  }
  return error.detail ?? error.title ?? t("academicGrading.errors.generic");
}
