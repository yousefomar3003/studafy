import { TesseractOcrEngine as BaseTesseractOcrEngine } from "@studafy/ocr";

import { recordLanguageRerun, recordOcrError, recordRecognizedPage } from "./metrics";

import type { TesseractOcrEngineOptions } from "@studafy/ocr";

/** The shared engine (packages/ocr), reporting into this worker's OCR metrics. */
export class TesseractOcrEngine extends BaseTesseractOcrEngine {
  constructor(options: Omit<TesseractOcrEngineOptions, "hooks"> = {}) {
    super({
      ...options,
      hooks: {
        onRecognized: recordRecognizedPage,
        onLanguageRerun: recordLanguageRerun,
        onError: recordOcrError,
      },
    });
  }
}
