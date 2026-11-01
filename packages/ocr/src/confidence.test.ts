// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { isLowConfidence, lowConfidencePages, pickBestLanguage } from "./index";

describe("pickBestLanguage", () => {
  test("picks the most confident pass", () => {
    const passes = [
      { language: "eng", confidence: 41 },
      { language: "ara", confidence: 88 },
      { language: "spa", confidence: 52 },
    ];
    expect(pickBestLanguage(passes)?.language).toBe("ara");
  });

  test("keeps the first pass on a tie and returns null for none", () => {
    expect(
      pickBestLanguage([
        { language: "eng", confidence: 70 },
        { language: "ara", confidence: 70 },
      ])?.language,
    ).toBe("eng");
    expect(pickBestLanguage([])).toBeNull();
  });
});

describe("confidence flags", () => {
  test("a page under the threshold is low confidence, one at it is not", () => {
    expect(isLowConfidence(59, 60)).toBe(true);
    expect(isLowConfidence(60, 60)).toBe(false);
  });

  test("lists the pages under the report's threshold", () => {
    const page = (n: number, confidence: number) => ({
      page: n,
      text: "",
      confidence,
      language: "eng",
      latencyMs: 0,
      wordCount: 0,
    });
    expect(
      lowConfidencePages({
        engine: "tesseract",
        lowConfidenceThreshold: 60,
        pages: [page(1, 95), page(2, 31), page(3, 60), page(4, 12)],
      }),
    ).toEqual([2, 4]);
  });
});
