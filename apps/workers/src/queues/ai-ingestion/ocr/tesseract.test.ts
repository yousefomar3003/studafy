import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { lowConfidencePages, resetMetrics, snapshot, TesseractOcrEngine } from "./index";

const readFixture = (file: string): Promise<Uint8Array> =>
  Bun.file(join(import.meta.dir, "..", "__fixtures__", "files", file)).bytes();

/**
 * The engine tests exercise the real tesseract worker against the committed fixtures, which is the
 * point: these asserts ARE the accuracy acceptance criteria (clean print >= 95 mean per-word
 * confidence, low-confidence pages flagged, non-Latin detected via the candidate-language re-runs).
 * Each engine holds one worker thread; the fixtures are the smallest set that exercises every pass.
 * Real tesseract runs routinely take seconds per page, and the low-confidence path re-runs each
 * candidate language, so these stay far above bun's 5s default timeout to stay CI-stable.
 */
const OCR_TEST_TIMEOUT = 30_000;

describe("TesseractOcrEngine", () => {
  const engine = new TesseractOcrEngine();

  beforeAll(() => {
    // The metrics are process-global counters; this file must see only its own recognizes.
    resetMetrics();
  });

  afterAll(async () => {
    await engine.close();
  });

  test(
    "recognizes a clean printed page at >= 95 confidence with verbatim text",
    async () => {
      const page = await engine.recognize(await readFixture("photosynthesis-notes.png"), 1);

      expect(page.confidence).toBeGreaterThanOrEqual(95);
      expect(page.language).toBe("eng");
      expect(page.text).toContain("Plants use photosynthesis to make food");
      expect(page.text).toContain("Chlorophyll gives leaves their green color");
    },
    OCR_TEST_TIMEOUT,
  );

  test(
    "re-runs candidate languages and detects non-Latin script",
    async () => {
      const page = await engine.recognize(await readFixture("arabic-photosynthesis-notes.png"), 2);

      // The eng pass scores low on Arabic, so the engine must re-run spa and ara and let the ara
      // pass win — this is the language-detection path, not the primary pass.
      expect(page.language).toBe("ara");
      expect(page.confidence).toBeGreaterThanOrEqual(engine.lowConfidenceThreshold);
      expect(page.text).toContain("التمثيل الضوئي يحول الضوء إلى طاقة");
    },
    OCR_TEST_TIMEOUT,
  );

  test(
    "flags a low-confidence page on the report and in the metrics",
    async () => {
      const page = await engine.recognize(await readFixture("scanned-rotated-notes.png"), 3);

      expect(page.confidence).toBeLessThan(engine.lowConfidenceThreshold);
      const report = {
        engine: engine.name,
        lowConfidenceThreshold: engine.lowConfidenceThreshold,
        pages: [page],
      };
      expect(lowConfidencePages(report)).toEqual([3]);

      const metrics = snapshot();
      expect(metrics.recognizedPages).toBe(3);
      expect(metrics.flaggedPages).toBeGreaterThanOrEqual(1);
      expect(metrics.languageReruns).toBeGreaterThanOrEqual(1);
      expect(metrics.errors).toBe(0);
      expect(metrics.latencyMsTotal).toBeGreaterThan(0);
      expect(metrics.avgLatencyMs).toBeGreaterThan(0);
    },
    OCR_TEST_TIMEOUT,
  );

  test(
    "close() is idempotent and a closed engine can still recognize",
    async () => {
      await engine.close();
      await engine.close();

      const page = await engine.recognize(await readFixture("photosynthesis-notes.png"), 4);
      expect(page.text).toContain("Plants use photosynthesis to make food");
    },
    OCR_TEST_TIMEOUT,
  );
});
