import type { OcrReport } from "./types";

/**
 * A page's OCR is "low confidence" when its mean per-word confidence falls below the engine's
 * flagging threshold. Deliberately a strict `<`: a page exactly at the threshold is judged
 * acceptable, the same way a threshold is meant to read in a configuration.
 */
export function isLowConfidence(confidence: number, threshold: number): boolean {
  return confidence < threshold;
}

/**
 * The 1-based pages of a report whose confidence is below its engine's flagging threshold — the
 * list a teacher is told to review. Kept as a pure function of the report so the worker can flag
 * and a test can assert on the same helper.
 */
export function lowConfidencePages(report: OcrReport): number[] {
  return report.pages
    .filter((page) => page.confidence < report.lowConfidenceThreshold)
    .map((page) => page.page);
}
