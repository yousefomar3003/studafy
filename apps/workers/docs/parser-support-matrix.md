# AI-ingestion parser support matrix

What the `ai-ingestion` queue (`apps/workers/src/queues/ai-ingestion`) can and cannot ingest, and
what happens when a document does not fit. The fixture corpus in
`apps/workers/src/queues/ai-ingestion/__fixtures__/` exercises every row of this matrix end-to-end.

## Format dispatch

The format is chosen by the material's **MIME type** as stored on `app.materials.mime_type`, never
by file extension or magic bytes — the extension is untrusted. Parsing is pure in-process library
work (no shell-outs), so a hostile file can neither spawn processes nor reach the filesystem.

| MIME type(s)                                                              | Parser            | Behaviour                                                         |
| ------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------- |
| `application/pdf`, `application/x-pdf`, `text/pdf`                        | `parsers/pdf.ts`  | Extracts text with page anchors and heading detection (below).    |
| `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `parsers/docx.ts` | Extracts text with real heading styles (below).                   |
| anything else                                                             | —                 | `UnsupportedFormatError`, reason `unsupported mime type: <type>`. |

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
- **Not supported**: scanned/image-only PDFs (no extractable text → `EmptyDocumentError`,
  reason `no extractable text`), password-protected PDFs (`EncryptedDocumentError`, reason
  `file is password-protected`), truncated or otherwise malformed files (`CorruptDocumentError`,
  reason `file is not a valid PDF`).

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

`chunker.ts` folds blocks into retrieval chunks of at most `DEFAULT_MAX_CHUNK_CHARS` (1 000)
characters:

- Heading blocks never produce content. They flush the current chunk — so no chunk straddles a
  section boundary — and become the `section_title` of everything that follows.
- A chunk records the **page of its first contributing block**, so a chunk spanning a page break is
  cited from where its content begins.
- A single block longer than the budget is split on sentence boundaries (`. ` / `.\n`), falling back
  to the last space, then a hard cut.

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

`worker.test.ts` runs the full 20-file corpus: anchors and headings survive extraction, PDF page
numbers match the source documents, corrupt/unsupported files reject with the exact reason above,
plus chunker boundary and embedding-determinism unit tests. Regenerate fixtures deterministically
with `bun run generate:fixtures`.
