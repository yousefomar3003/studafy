export { isLowConfidence, lowConfidencePages, pickBestLanguage } from "@studafy/ocr";
export type { LanguagePass, OcrEngine, OcrPageResult, OcrReport } from "@studafy/ocr";
export {
  recordLanguageRerun,
  recordOcrError,
  recordRecognizedPage,
  resetMetrics,
  snapshot,
} from "./metrics";
export type { OcrMetrics } from "./metrics";
export { TesseractOcrEngine } from "./tesseract";
export type { TesseractOcrEngineOptions } from "@studafy/ocr";
