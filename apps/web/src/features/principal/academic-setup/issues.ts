import { displayTotal } from "./config-form";

import type { TFunction } from "i18next";

/**
 * Validation codes (from `@studafy/grading-engine`, the same on the server and in live checks) that
 * read the same whatever the subject, so they are explained in the active language. Codes whose
 * message names a category or assessment keep the engine's own message, which carries that name.
 */
const TRANSLATED_CODES = new Set([
  "MAX_MARKS_INVALID",
  "PASS_PERCENTAGE_INVALID",
  "FINAL_EXAM_PASS_PERCENTAGE_INVALID",
  "ROUNDING_DECIMALS_INVALID",
  "RETAKE_CAP_REQUIRED",
  "NO_CATEGORIES",
  "TERM_WEIGHT_MISSING",
  "TERM_WEIGHT_WITHOUT_TERM_CATEGORIES",
  "WEIGHT_IGNORED_FOR_TOTAL_POINTS",
  "FINAL_EXAM_RULE_WITHOUT_FINAL",
]);

export interface WeightTotals {
  termCategoryTotal: number;
  annualTotal: number;
}

export function issueText(
  issue: { code: string; message: string },
  t: TFunction,
  totals?: WeightTotals,
): string {
  if (issue.code === "TERM_CATEGORY_WEIGHT_TOTAL" && totals) {
    return t("academicGrading.issues.TERM_CATEGORY_WEIGHT_TOTAL", {
      total: displayTotal(totals.termCategoryTotal),
    });
  }
  if (issue.code === "ANNUAL_WEIGHT_TOTAL" && totals) {
    return t("academicGrading.issues.ANNUAL_WEIGHT_TOTAL", {
      total: displayTotal(totals.annualTotal),
    });
  }
  if (TRANSLATED_CODES.has(issue.code)) return t(`academicGrading.issues.${issue.code}`);
  return issue.message;
}
