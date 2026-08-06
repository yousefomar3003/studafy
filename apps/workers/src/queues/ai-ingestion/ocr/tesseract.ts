import { createWorker } from "tesseract.js";

import { pickBestLanguage, type LanguagePass } from "./language";
import { recordLanguageRerun, recordOcrError, recordRecognizedPage } from "./metrics";

import type { OcrEngine, OcrPageResult } from "./types";
import type { Worker as TesseractWorker } from "tesseract.js";

/**
 * Tesseract, wrapped as an {@link OcrEngine}.
 *
 * One shared worker is created lazily on first recognize and reused across pages, because spawning
 * a worker (a `worker_threads` process plus a WASM core) is the expensive part of tesseract.js;
 * recognizing the next page reuses everything except the per-call work.
 *
 * Language switching is done with `worker.reinitialize`, not `worker.recognize(image, { lang })`:
 * in tesseract.js v7 the worker-script's `recognize` handler only reads tessjs options
 * (`rectangle`, `pdfTitle`, ...) and silently ignores a per-call `lang`, so the only reliable way
 * to change languages is to re-initialize the shared worker. `reinitialize` loads traineddata for
 * a language once, then cheaply re-runs `TessBaseAPI.Init` on later switches, so a shared worker
 * accumulates every language it has seen and switching stays fast after the first page.
 */
export interface TesseractOcrEngineOptions {
  /**
   * Languages of the primary recognition pass, e.g. `["eng"]`. Every page is first recognized in
   * these. Defaults to `["eng"]`.
   */
  languages?: string[];
  /**
   * Languages tried when the primary pass falls below {@link lowConfidenceThreshold}, one
   * re-initialized pass each. The most confident pass wins the page. Defaults to `["spa", "ara"]`
   * — the two non-English languages the product's schools actually OCR. Each candidate's
   * `<code>.traineddata` must be shipped alongside the primary languages' (a missing file fails
   * the page loudly, which is the honest outcome for a deployment bug).
   */
  languageCandidates?: string[];
  /**
   * Mean per-word confidence (0-100) below which a page is (a) re-run across the candidate
   * languages and (b) flagged on the report as needing a teacher's eyes. Defaults to 60.
   */
  lowConfidenceThreshold?: number;
  /**
   * Directory holding `<language>.traineddata` files, as a filesystem path or a `file://` URL.
   * Defaults to `./traineddata/` next to this module, which resolves to the checked-in traineddata
   * directory in development and to the copied directory next to the bundle in the image.
   */
  langPath?: string;
  /**
   * Path to a bundled tesseract worker-script (the file spawned as the worker thread). Defaults to
   * tesseract.js's own, which exists whenever `node_modules` is present; the image has no
   * `node_modules`, so it passes the bundled copy shipped into the dist directory.
   */
  workerPath?: string;
}

/**
 * Tesseract engine state. `lowConfidenceThreshold` is surfaced as a readonly property so report
 * builders can describe a report without knowing the engine's configuration twice.
 */
export class TesseractOcrEngine implements OcrEngine {
  readonly name = "tesseract";

  readonly lowConfidenceThreshold: number;

  private readonly languages: string[];

  private readonly languageCandidates: string[];

  private readonly langPath: string;

  private readonly workerPath?: string;

  private worker: TesseractWorker | null = null;

  /** The language(s) the shared worker is currently initialized to, e.g. `"eng"` or `"spa"`. */
  private currentLanguage: string | null = null;

  constructor(options: TesseractOcrEngineOptions = {}) {
    this.languages = options.languages ?? ["eng"];
    this.languageCandidates = options.languageCandidates ?? ["spa", "ara"];
    this.lowConfidenceThreshold = options.lowConfidenceThreshold ?? 60;
    this.langPath = options.langPath ?? new URL("./traineddata/", import.meta.url).href;
    this.workerPath = options.workerPath;
  }

  async recognize(imageBytes: Uint8Array, page: number): Promise<OcrPageResult> {
    const started = performance.now();
    try {
      const worker = await this.workerInstance();
      await this.reinitializeTo(worker, this.languages);

      const primary = await this.recognizeNow(worker, imageBytes);
      const passes = [primary];

      if (primary.confidence < this.lowConfidenceThreshold && this.languageCandidates.length > 0) {
        recordLanguageRerun();
        for (const candidate of this.languageCandidates) {
          await this.reinitializeTo(worker, [candidate]);
          passes.push(await this.recognizeNow(worker, imageBytes));
        }
        // The next page's primary pass must run in the configured languages, not the last candidate's.
        await this.reinitializeTo(worker, this.languages);
      }

      const winner = pickBestLanguage(passes)!;
      const latencyMs = performance.now() - started;
      recordRecognizedPage({
        latencyMs,
        confidence: winner.confidence,
        threshold: this.lowConfidenceThreshold,
      });

      return {
        page,
        text: winner.text,
        confidence: winner.confidence,
        language: winner.language,
        latencyMs: Math.round(latencyMs),
        wordCount: winner.text.length === 0 ? 0 : winner.text.split(/\s+/).filter(Boolean).length,
      };
    } catch (error) {
      recordOcrError();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.worker !== null) {
      await this.worker.terminate();
      this.worker = null;
      this.currentLanguage = null;
    }
  }

  private async workerInstance(): Promise<TesseractWorker> {
    if (this.worker === null) {
      // `workerPath: undefined` must not be passed: tesseract.js merges options with a spread, so
      // an explicit undefined would clobber its defaulted workerPath and spawn a worker with none.
      // A copy, not `this.languages` itself: tesseract.js keeps a reference to the array and
      // pushes every language it later loads into it (`reinitialize` accumulates into the same
      // array), which would grow our configured languages past what we intend.
      const worker = await createWorker([...this.languages], undefined, {
        langPath: this.langPath,
        cacheMethod: "none",
        gzip: false,
        ...(this.workerPath !== undefined ? { workerPath: this.workerPath } : {}),
      });
      this.worker = worker;
      // createWorker initializes with `this.languages`; record it so the first recognize() skips a
      // redundant reinitialize.
      this.currentLanguage = this.languages.join("+");
    }
    return this.worker;
  }

  private async reinitializeTo(worker: TesseractWorker, languages: string[]): Promise<void> {
    const key = languages.join("+");
    if (this.currentLanguage !== key) {
      await worker.reinitialize(key);
      this.currentLanguage = key;
    }
  }

  private async recognizeNow(
    worker: TesseractWorker,
    imageBytes: Uint8Array,
  ): Promise<LanguagePass & { text: string }> {
    // The d.ts `ImageLike` omits `Uint8Array` (it lists `Buffer`, a subclass); tesseract's
    // `loadImage` accepts it. Cast per the repo's library-type-gap convention (see parsers/pdf.ts).
    const { data } = await worker.recognize(imageBytes as never);
    return {
      language: this.currentLanguage ?? "",
      confidence: data.confidence,
      text: data.text.trim(),
    };
  }
}
