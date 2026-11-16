/**
 * QA-043: hostile documents are refused by size before they can exhaust a worker.
 *
 * The parsers had no page, pixel, decompression or entry limits: a small PDF with one enormous
 * page rendered to a multi-gigabyte canvas, a zip bomb inside a PPTX or DOCX inflated without bound,
 * a 5,000-page scan tied up OCR for hours, and an image was decoded at whatever size its header
 * claimed. Each cap now fails the material with a clear reason (DocumentTooLargeError, a
 * MaterialParseError the worker records as `ingest_error`), before the expensive work starts.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";

import { DocumentTooLargeError } from "../errors";

import { INGESTION_LIMITS } from "./limits";

import { parseDocument } from "./index";

import type { OcrEngine } from "../ocr";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** An OCR engine that records whether anything reached it. */
function spyOcr() {
  let calls = 0;
  const engine: OcrEngine = {
    name: "spy",
    lowConfidenceThreshold: 60,
    async recognize(_bytes: Uint8Array, page: number) {
      calls += 1;
      return { page, text: "", confidence: 0 };
    },
    close: () => Promise.resolve(),
  } as unknown as OcrEngine;
  return { engine, calls: () => calls };
}

async function blankPdf(pages: number, size: [number, number] = [612, 792]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) pdf.addPage(size);
  return pdf.save();
}

/** Patch every central-directory "uncompressed size" field of a zip (signature 0x02014b50). */
function claimUncompressedSize(zip: Uint8Array, bytes: number): Uint8Array {
  const copy = new Uint8Array(zip);
  const view = new DataView(copy.buffer);
  for (let i = 0; i + 46 <= copy.length; i += 1) {
    if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, bytes, true);
  }
  return copy;
}

/** A PNG signature and IHDR claiming `width` x `height`; nothing decodable after it. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 2, 0, 0, 0], 24);
  return bytes;
}

describe("ingestion limits (QA-043)", () => {
  test("a PDF with more pages than the cap is refused", async () => {
    const bytes = await blankPdf(INGESTION_LIMITS.maxPdfPages + 1);
    await expect(parseDocument(bytes, "application/pdf")).rejects.toBeInstanceOf(
      DocumentTooLargeError,
    );
  }, 60_000);

  test("a scanned PDF needing more OCR pages than the cap is refused before OCR runs", async () => {
    const ocr = spyOcr();
    const bytes = await blankPdf(INGESTION_LIMITS.maxOcrPages + 1);
    await expect(
      parseDocument(bytes, "application/pdf", { ocr: ocr.engine }),
    ).rejects.toBeInstanceOf(DocumentTooLargeError);
    expect(ocr.calls()).toBe(0);
  }, 60_000);

  test("a page whose render would exceed the pixel cap is refused before rendering", async () => {
    const ocr = spyOcr();
    // 14,400 pt square at scale 2: ~829 megapixels.
    const bytes = await blankPdf(1, [14_400, 14_400]);
    await expect(
      parseDocument(bytes, "application/pdf", { ocr: ocr.engine }),
    ).rejects.toBeInstanceOf(DocumentTooLargeError);
    expect(ocr.calls()).toBe(0);
  });

  test("a zip claiming more uncompressed bytes than the cap is refused (DOCX and PPTX)", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", "<w:document/>");
    const small = await zip.generateAsync({ type: "uint8array" });
    const bomb = claimUncompressedSize(small, INGESTION_LIMITS.maxZipUncompressedBytes + 1);
    for (const mime of [DOCX, PPTX]) {
      await expect(parseDocument(bomb, mime)).rejects.toBeInstanceOf(DocumentTooLargeError);
    }
  });

  test("a zip with more entries than the cap is refused", async () => {
    const zip = new JSZip();
    for (let i = 0; i <= INGESTION_LIMITS.maxZipEntries; i += 1) zip.file(`f/${i}.xml`, "");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(parseDocument(bytes, PPTX)).rejects.toBeInstanceOf(DocumentTooLargeError);
  });

  test("an image whose header claims more pixels than the cap is refused before decoding", async () => {
    const ocr = spyOcr();
    await expect(
      parseDocument(pngHeader(20_000, 20_000), "image/png", { ocr: ocr.engine }),
    ).rejects.toBeInstanceOf(DocumentTooLargeError);
    expect(ocr.calls()).toBe(0);
  });

  test("an ordinary small image still reaches OCR", async () => {
    const ocr = spyOcr();
    await parseDocument(pngHeader(800, 600), "image/png", { ocr: ocr.engine });
    expect(ocr.calls()).toBe(1);
  });
});
