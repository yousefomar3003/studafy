/**
 * Writes a data subject request's export as one ZIP archive, streamed straight to storage.
 *
 * Entries are added one at a time and each is awaited before the next starts, so the worker holds
 * at most one entry's current chunk, the ZIP encoder's small buffers and one upload part, however
 * large the export. The archiver library writes ZIP64 records when the archive passes 4 GiB or
 * 65,535 entries, which a whole school's files can.
 *
 * Every entry's bytes are counted and hashed (SHA-256) as they pass, for the manifest. Stored files
 * are added uncompressed: most are PDFs, images and office documents that are compressed already,
 * so deflating them again would cost CPU and save next to nothing. The data files are deflated.
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import archiver from "archiver";

export interface ArchiveEntryResult {
  bytes: number;
  sha256: string;
}

export type ArchiveEntrySource = string | Uint8Array | AsyncIterable<Uint8Array | string>;

/** Longest entry file name, in characters, extension included. */
const MAX_FILE_NAME_LENGTH = 150;

/**
 * A file name safe to extract on Windows, macOS and Linux: no path separators or characters those
 * systems reject, no leading/trailing dots or spaces, not a reserved device name, and not too long.
 * Upload names are already free of slashes in most tables, but not every table checks, and an
 * archive is the last place a `../` should survive.
 */
export function safeFileName(raw: string, fallback = "file"): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  let name = raw.normalize("NFC").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_");
  name = name.replace(/^[\s.]+|[\s.]+$/g, "");
  if (name === "") name = fallback;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) name = `_${name}`;
  const chars = [...name];
  if (chars.length > MAX_FILE_NAME_LENGTH) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    const stem = [...name.slice(0, name.length - extension.length)];
    name = stem.slice(0, MAX_FILE_NAME_LENGTH - [...extension].length).join("") + extension;
  }
  return name;
}

/** Hands out unique entry paths within each folder: a second `notes.pdf` becomes `notes (2).pdf`.
 * Compared case-insensitively, as the person's file system may be. */
export class ArchivePaths {
  private readonly taken = new Set<string>();

  allocate(folder: string, rawName: string): string {
    const name = safeFileName(rawName);
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    for (let n = 1; ; n++) {
      const candidate = `${folder}/${n === 1 ? name : `${stem} (${n})${extension}`}`;
      const key = candidate.toLowerCase();
      if (!this.taken.has(key)) {
        this.taken.add(key);
        return candidate;
      }
    }
  }
}

async function* chunksOf(source: ArchiveEntrySource): AsyncGenerator<Uint8Array> {
  if (typeof source === "string") {
    yield Buffer.from(source, "utf8");
    return;
  }
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  for await (const chunk of source) {
    yield typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
  }
}

export class ExportArchiveWriter {
  private readonly archive: archiver.Archiver;
  private readonly upload: Promise<number>;
  /** Rejects when the upload fails, so an entry waiting on the archive does not wait forever. */
  private readonly uploadFailed: Promise<never>;
  private readonly date: Date;

  /**
   * @param sink consumes the archive's bytes (the storage upload); it starts at once and finishes
   *   when the archive does. Its result is returned by `finish`.
   */
  constructor(sink: (body: AsyncIterable<Uint8Array>) => Promise<number>, date: Date) {
    this.date = date;
    this.archive = archiver("zip", { zlib: { level: 6 } });
    // Errors reach the caller through `add` and the upload; without a listener one would crash
    // the process instead.
    this.archive.on("error", () => undefined);
    this.upload = sink(this.archive);
    this.uploadFailed = this.upload.then(() => new Promise<never>(() => undefined));
    // Observed through uploadFailed/finish; this keeps an early failure from being unhandled.
    this.uploadFailed.catch(() => undefined);
  }

  /** Adds one entry and waits until it is fully written. */
  async add(
    path: string,
    source: ArchiveEntrySource,
    options: { compress: boolean },
  ): Promise<ArchiveEntryResult> {
    const hash = createHash("sha256");
    let bytes = 0;
    async function* measured() {
      for await (const chunk of chunksOf(source)) {
        hash.update(chunk);
        bytes += chunk.byteLength;
        yield chunk;
      }
    }
    const stream = Readable.from(measured(), { objectMode: false });
    const written = new Promise<void>((resolve, reject) => {
      const onEntry = () => {
        cleanup();
        resolve();
      };
      const onError = (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const cleanup = () => {
        this.archive.off("entry", onEntry);
        this.archive.off("error", onError);
        stream.off("error", onError);
      };
      this.archive.on("entry", onEntry);
      this.archive.on("error", onError);
      // archiver does not reliably surface a source stream's error; listen to it directly.
      stream.on("error", onError);
    });
    this.archive.append(stream, { name: path, date: this.date, store: !options.compress });
    await Promise.race([written, this.uploadFailed]);
    return { bytes, sha256: hash.digest("hex") };
  }

  /** Writes the ZIP's central directory and waits for the upload to finish. Returns its size. */
  async finish(): Promise<number> {
    await Promise.race([this.archive.finalize(), this.uploadFailed]);
    return this.upload;
  }

  /** Stops the archive so the upload fails (never completing a truncated archive), and waits for
   * the upload to give up. */
  async abort(reason: unknown): Promise<void> {
    this.archive.destroy(reason instanceof Error ? reason : new Error(String(reason)));
    await this.upload.catch(() => undefined);
  }
}
