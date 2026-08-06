# ADR-007: OCR for the AI-ingestion pipeline

## Status

Accepted

## Context

The `ai-ingestion` queue (`apps/workers/src/queues/ai-ingestion`) extracts text from materials and
chunks it for retrieval. It handled PDF, DOCX, and PPTX — all text-layer formats. Two material
classes were unserved:

- **Raster uploads** (PNG/JPEG/BMP/TIFF) — never parseable, `unsupported mime type`.
- **Scanned PDFs** — a valid PDF whose pages carry images, not text; `extractTextItems` returns
  nothing and the parser fails with `no extractable text`.

This ADR records the OCR decisions: which engine, how languages are detected, how confidence and
cost are treated, and how the OCR path is deployed (no `node_modules` in the production image).

## Decision

### tesseract.js v7, in-process, one shared worker

- **Engine: tesseract.js 7.0.0** (Tesseract 5 + Leptonica compiled to WASM), with traineddata for
  `eng`, `spa`, and `ara` committed in
  `apps/workers/src/queues/ai-ingestion/ocr/traineddata/`. A WASM engine is chosen over a cloud OCR
  API (Textract/OCR.space) because it is free per page, runs inside the existing worker process, and
  keeps the pipeline's "no external services beyond S3/Redis/Postgres" posture — and because the
  accuracy we need (clean printed text) is where local tesseract is strong.
- **One shared worker per job.** Spawning a worker is the expensive part (a worker thread plus a
  WASM core); the engine creates it lazily on first recognize, reuses it across pages, and the job
  closes it in a `finally`. See `ocr/tesseract.ts`.

### Language detection is recognition-based, not OSD

- Every page is recognized in the primary languages (`["eng"]`). If the primary pass' mean
  per-word confidence falls below the flagging threshold, the page is re-run once per candidate
  language (`["spa", "ara"]`) and the most confident pass wins. This is deliberately **not** the
  OSD orientation/language detector: probing showed OSD's orientation output unreliable for our
  fixtures, and its language list would be a new source of support burden. Recognition-based
  detection is exactly as expensive for the flagged minority and needs no new dependency.
- **`worker.reinitialize`, not `worker.recognize(image, { lang })`.** In tesseract.js v7 the
  worker-script's recognize handler silently ignores a per-call `lang` (verified by probe). Language
  switching must re-initialize the shared worker (`reinitialize`), which loads a language's
  traineddata once and cheaply re-runs `TessBaseAPI.Init` on later switches.

### Confidence and cost

- **Mean per-word confidence** is the page score, and the **flagging threshold defaults to 60**:
  a page below it is both re-run across candidate languages and reported to the teacher. The
  threshold is configurable per deployment via `OCR_LOW_CONFIDENCE_THRESHOLD`.
- **Cost is metered as compute time.** OCR's cost is CPU/WASM time, so the engine records
  wall-clock latency per page (`latencyMs`) plus page/flag/rerun/error counters in a process-local
  snapshot (`ocr/metrics.ts`) served with the other worker metrics. Currency cost is deliberately
  not invented — it is a derivation of the same latency figures in this ADR.
- **Low-confidence pages flag a notification.** When an OCR'd material has flagged pages, the
  worker inserts a `MATERIAL_OCR_LOW_CONFIDENCE` notification (migration 000090) inside the same
  transaction that flips the material `ready`, telling the uploader which pages to review.

### PDF fallback is per-page, not all-or-nothing

`parsers/pdf.ts` keeps its text extraction; a page whose text layer is empty is rendered to a raster
(`renderPageAsImage` at scale 2) and OCR'd, and its text becomes a body block at the page's own
position. Mixed documents (text pages + scanned pages) therefore keep reading order, and text
PDFs pay no OCR cost at all.

### Deployment: bundle-only, no node_modules

The production image ships only `apps/workers/dist`. `bun run build:ocr` therefore bundles
tesseract's worker-script (`dist/ocr/index.js`, `--target bun`), copies the WASM cores next to it
(`dist/ocr/tesseract-core-*.wasm` — the worker-script resolves cores relative to its own
`__dirname`), and copies the traineddata to `dist/traineddata/` (the engine's default `langPath`
resolves there from the bundled main module). The image sets `OCR_WORKER_PATH=/app/dist/ocr/index.js`
and leaves the traineddata default alone. Verified end-to-end: the bundle + cores + traineddata
recognize clean print at confidence 95 with no node_modules present.

### Fixture-verified accuracy

The committed fixtures anchor the acceptance criteria: the clean printed-page raster must OCR at
**≥ 95 mean per-word confidence** with the printed lines verbatim, the rotated low-confidence page
must be flagged, and the Arabic page must be detected via the candidate-language re-runs. These run
as unit tests against the real engine in `ocr/tesseract.test.ts`.

## Consequences

- Rasters (PNG/JPEG/BMP/TIFF) and scanned PDFs now flow through parse → chunk → embed like any text
  document, and a scanned page's OCR report rides along so low-confidence pages can be flagged.
- OCR adds latency proportional to the number of pages that need it (probe: ~80–300 ms per page
  warm, plus a ~1 s worker spawn). Text PDFs, DOCX, and PPTX pay nothing.
- tesseract accuracy is bounded: rotated, handwritten, or very low-resolution pages will flag at low
  confidence rather than silently produce garbage. A page whose OCR text is empty still fails the
  document (`no extractable text`) when nothing else yields blocks.
- The traineddata, WASM cores, and bundled worker are committed or produced by a build step; a
  missing file fails the page loudly rather than falling back to a wrong language.
