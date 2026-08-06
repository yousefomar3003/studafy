# AI-ingestion parser support matrix

What the `ai-ingestion` queue (`apps/workers/src/queues/ai-ingestion`) can and cannot ingest, and
what happens when a document does not fit. The fixture corpus in
`apps/workers/src/queues/ai-ingestion/__fixtures__/` exercises every row of this matrix end-to-end.

## Format dispatch

The format is chosen by the material's **MIME type** as stored on `app.materials.mime_type`, never
by file extension or magic bytes — the extension is untrusted. Parsing is pure in-process library
work (no shell-outs), so a hostile file can neither spawn processes nor reach the filesystem.

| MIME type(s)                                                              | Parser             | Behaviour                                                                                          |
| ------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------- |
| `application/pdf`, `application/x-pdf`, `text/pdf`                        | `parsers/pdf.ts`   | Extracts text with page anchors and heading detection; textless (scanned) pages are OCR'd (below). |
| `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `parsers/docx.ts`  | Extracts text with real heading styles (below).                                                    |
| `image/png`, `image/jpeg`, `image/bmp`, `image/tiff`                      | `parsers/image.ts` | OCR's the raster; a raster is a single page of body text (below).                                  |
| anything else                                                             | —                  | `UnsupportedFormatError`, reason `unsupported mime type: <type>`.                                  |

## Supported formats

### PDF (`unpdf`, i.e. PDF.js)

- Text is extracted per page with a `pageNumber` on every block.
- **Headings** come from the document outline (bookmarks) when present — that is the author's
  explicit structure. When a PDF has no outline, headings are inferred with a font-size heuristic:
  a line is a heading if its size is ≥ 1.4× the median line size and it is ≤ 120 characters. The
  median (not the max) is the body baseline, so a page rendered slightly larger still compares
  against the document as a whole. Heuristic by construction: a text-only PDF has no style
  semantics.
- Lines are grouped by vertical position (tolerance ±2 units), ordered top-to-bottom, left-to-right.
- **Scanned pages**: a page with no extractable text is rendered to a raster at scale 2
  (`renderPageAsImage`) and OCR'd; its recognized text becomes one body block at the page's own
  position, so mixed text/scanned documents keep reading order. The OCR report (engine, flagging
  threshold, per-page confidence/latency) rides on `ParsedDocument.ocrReport` — `null` when no page
  was OCR'd.
- **Not supported**: password-protected PDFs (`EncryptedDocumentError`, reason
  `file is password-protected`), truncated or otherwise malformed files (`CorruptDocumentError`,
  reason `file is not a valid PDF`), and a PDF whose pages yield no text at all — after the OCR
  fallback — (`EmptyDocumentError`, reason `no extractable text`).

### Images (`parsers/image.ts`, tesseract.js 7)

- A raster is a single "page" of body text: recognized once and emitted as one body block (the
  chunker owns splitting long text). No heading detection — a raster has no styles to detect.
- The engine recognizes clean printed text at **≥ 95 mean per-word confidence** (fixture-verified).
  When a page's confidence falls below the flagging threshold (default 60), it is re-run across the
  candidate languages (`spa`, `ara`) and the most confident pass wins — this is how non-Latin
  materials are detected. Every OCR'd page carries its confidence, language, word count, and
  latency on the report; low-confidence pages are flagged to the uploader via a
  `MATERIAL_OCR_LOW_CONFIDENCE` notification.
- **Not supported**: WebP/GIF rasters (formats leptonica is not verified against) are
  `unsupported mime type`. A raster with an empty OCR result produces no blocks (and no chunk), and
  a raster supplied without an OCR engine is rejected as loudly as an unsupported format.
- OCR internals and deployment (no `node_modules` in the image) are recorded in
  `docs/adr/0007-ocr-engine.md`.

### DOCX (`mammoth`)

- Paragraphs are collected in document order via `mammoth.convertToHtml`'s `transformDocument`
  hook. `styleId`/`styleName` are the reliable signal: a paragraph whose resolved style is
  `Heading1`–`Heading9` or `Title` becomes a heading block; everything else is body text.
- Runs within a paragraph (text, tabs, line breaks) are reassembled in order.
- DOCX carries no page information, so `pageNumber` is `null` for DOCX blocks.
- **Not supported**: non-zip or structurally invalid files (`CorruptDocumentError`, reason
  `file is not a valid DOCX`), documents with no extractable text (`EmptyDocumentError`), encrypted
  DOCX files (surface as `CorruptDocumentError` — `EncryptedDocumentError` is currently reserved for
  PDFs). Legacy binary `.doc` files are **not** parsed — they are `application/msword`, which hits
  the unsupported-MIME path before any bytes are read.

## Chunking

`chunker.ts` folds blocks into retrieval chunks that target ~800 tokens (`CHUNK_TOKENS`) each. The
repository has no tokenizer — embeddings are mock — so tokens use the standard approximation of four
characters per token (`CHARS_PER_TOKEN`), which makes the enforced budget `DEFAULT_MAX_CHUNK_CHARS`
(3 200) characters. The chunker stays a pure character machine: deterministic for identical input,
with no dependency.

- Heading blocks never produce content. They flush the current chunk — so no chunk straddles a
  section boundary — and become the `section_title` of everything that follows.
- A chunk records the **page of its first contributing block**, so a chunk spanning a page break is
  cited from where its content begins.
- Adjacent chunks share up to `DEFAULT_OVERLAP_CHARS` (15% of the budget) so a retrieval boundary
  never drops a sentence. Overlap carries only across size-induced flushes — it never crosses a
  section heading, a slide, or a page — so every chunk's text stays citable to the page and section
  it is anchored on.
- A single block longer than the budget is split near sentence boundaries (`. ` / `.\n`), falling
  back to a line break, the last space, then a hard cut.

## Embeddings

`embedding.ts` stores a deterministic, content-derived 1536-dimension vector under
`EMBEDDING_MODEL = "mock-embedding-3-small"` (the seed corpus' model). This is a placeholder: the
repository declares no embedding client, and `app.material_chunks.embedding` is `vector(1536) NOT
NULL`, so a row cannot exist without a vector. This module is the single swap point for a real
provider; content is retained verbatim on each chunk so embeddings can be regenerated in place.

## Error taxonomy → `app.materials.ingest_error`

Every parse failure writes a short, stable reason (the `reason` of a `MaterialParseError`):

| Error class               | `ingest_error`                         |
| ------------------------- | -------------------------------------- |
| `UnsupportedFormatError`  | `unsupported mime type: <type>`        |
| `CorruptDocumentError`    | `file is not a valid PDF` / `... DOCX` |
| `EncryptedDocumentError`  | `file is password-protected`           |
| `EmptyDocumentError`      | `no extractable text`                  |
| anything else (S3, DB, …) | `ingestion failed`                     |

## Test coverage

`worker.test.ts` runs the 30-file corpus: anchors and headings survive extraction, PDF page numbers
match the source documents, corrupt/unsupported files reject with the exact reason above, plus
chunker boundary and embedding-determinism unit tests. `ocr/tesseract.test.ts` asserts the OCR
accuracy bar against the real engine: clean print at ≥ 95 confidence, non-Latin detection via the
candidate-language re-runs, and low-confidence flagging on report and metrics. Regenerate fixtures
deterministically with `bun run generate:fixtures`.
