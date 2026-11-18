import { DocumentTooLargeError } from "../errors";

/** Ingestion limits (QA-043). */
export const INGESTION_LIMITS = {
  maxPdfPages: 500,
  maxOcrPages: 50,
  /** Rendered pixels per page (width x height at the OCR render scale), and per image. */
  maxPixels: 25_000_000,
  maxZipUncompressedBytes: 200 * 1024 * 1024,
  maxZipEntries: 2_000,
  /** Wall-clock budget for parsing one document. */
  parseTimeoutMs: 10 * 60 * 1000,
} as const;

/** Megabytes, for reasons a person reads. */
const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * Check a zip (DOCX, PPTX) from its central directory, without decompressing anything: the entry
 * count and the sum of the declared uncompressed sizes. A zip bomb declares its real inflated size
 * there (ZIP readers rely on it), and an archive that lies is refused by JSZip when the inflated
 * stream overruns the declared size. Unreadable directories are left to the parser, which reports
 * them as corrupt.
 */
export function assertZipWithinLimits(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: 22 bytes, at most 64 KiB of comment after it.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return;
  const entries = view.getUint16(eocd + 10, true);
  if (entries > INGESTION_LIMITS.maxZipEntries) {
    throw new DocumentTooLargeError(
      `file has ${entries} parts; the limit is ${INGESTION_LIMITS.maxZipEntries}`,
    );
  }
  let offset = view.getUint32(eocd + 16, true);
  let total = 0;
  for (let n = 0; n < entries && offset + 46 <= bytes.length; n += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    total += view.getUint32(offset + 24, true);
    if (total > INGESTION_LIMITS.maxZipUncompressedBytes) {
      throw new DocumentTooLargeError(
        `file expands to more than ${mb(INGESTION_LIMITS.maxZipUncompressedBytes)}`,
      );
    }
    offset +=
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
}

export function assertPixelsWithinLimit(width: number, height: number, what: string): void {
  if (!(width > 0 && height > 0) || width * height > INGESTION_LIMITS.maxPixels) {
    throw new DocumentTooLargeError(
      `${what} is too large to read (${Math.round(width)} x ${Math.round(height)} pixels)`,
    );
  }
}

/**
 * Width and height from an image header (PNG, JPEG, GIF, BMP, TIFF), or null when the header is not
 * one of those. Read before anything decodes the pixels.
 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = (i: number) => (i < bytes.length ? bytes[i]! : -1);
  // PNG: signature, then IHDR width/height (big-endian).
  if (bytes.length >= 24 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // GIF: logical screen size (little-endian).
  if (bytes.length >= 10 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  // BMP: BITMAPINFOHEADER width/height (height may be negative: top-down).
  if (bytes.length >= 26 && at(0) === 0x42 && at(1) === 0x4d) {
    return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
  }
  // JPEG: walk the markers to the first SOFn.
  if (bytes.length >= 4 && at(0) === 0xff && at(1) === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (at(i) !== 0xff) return null;
      const marker = at(i + 1);
      const length = view.getUint16(i + 2);
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
      i += 2 + length;
    }
    return null;
  }
  // TIFF: first IFD, tags 256 (width) and 257 (height).
  const little = at(0) === 0x49 && at(1) === 0x49;
  const big = at(0) === 0x4d && at(1) === 0x4d;
  if ((little || big) && bytes.length >= 8) {
    const le = little;
    const ifd = view.getUint32(4, le);
    if (ifd + 2 > bytes.length) return null;
    const count = view.getUint16(ifd, le);
    let width = 0;
    let height = 0;
    for (let n = 0; n < count && ifd + 2 + n * 12 + 12 <= bytes.length; n += 1) {
      const entry = ifd + 2 + n * 12;
      const tag = view.getUint16(entry, le);
      const type = view.getUint16(entry + 2, le);
      const value = type === 3 ? view.getUint16(entry + 8, le) : view.getUint32(entry + 8, le);
      if (tag === 256) width = value;
      if (tag === 257) height = value;
    }
    return width && height ? { width, height } : null;
  }
  return null;
}

/** Reject after `ms`; the parse it races is abandoned, and its material fails with the reason. */
export function withParseTimeout<T>(
  work: Promise<T>,
  ms = INGESTION_LIMITS.parseTimeoutMs,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new DocumentTooLargeError(
            `file took longer than ${Math.round(ms / 60000)} minutes to read`,
          ),
        ),
      ms,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
