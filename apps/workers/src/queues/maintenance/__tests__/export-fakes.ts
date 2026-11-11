/**
 * Test doubles for the DSR export: an in-memory object store with the export's storage port, and a
 * reader for the ZIP archive the export writes into it.
 */
import JSZip from "jszip";

import type { MaintenanceS3Client } from "../export-storage";

export interface FakeExportStorage extends MaintenanceS3Client {
  objects: Map<string, Uint8Array>;
  /** Keys `open` was called with, in order. */
  opened: string[];
  /** Content-Disposition of each stored stream, by key. */
  dispositions: Map<string, string>;
}

/** `open` yields each object in two chunks, so the export cannot rely on one-chunk bodies. */
export function createFakeExportStorage(): FakeExportStorage {
  const objects = new Map<string, Uint8Array>();
  const opened: string[] = [];
  const dispositions = new Map<string, string>();
  return {
    objects,
    opened,
    dispositions,
    async open(key) {
      opened.push(key);
      const body = objects.get(key);
      if (!body) return null;
      return (async function* () {
        const half = Math.floor(body.byteLength / 2);
        yield body.subarray(0, half);
        yield body.subarray(half);
      })();
    },
    async putStream(key, body, { contentDisposition }) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(new Uint8Array(chunk));
      const joined = Buffer.concat(chunks);
      objects.set(key, new Uint8Array(joined));
      dispositions.set(key, contentDisposition);
      return joined.byteLength;
    },
  };
}

export interface ExportArchive {
  names: string[];
  text(path: string): Promise<string>;
  bytes(path: string): Promise<Uint8Array>;
  /** A data file's rows (`data/<table>.json`). */
  rows<T = Record<string, unknown>>(table: string): Promise<T[]>;
}

export async function readExportArchive(body: Uint8Array | undefined): Promise<ExportArchive> {
  if (!body) throw new Error("no archive was stored");
  const zip = await JSZip.loadAsync(body);
  const entry = (path: string) => {
    const file = zip.file(path);
    if (!file) throw new Error(`no ${path} in the archive`);
    return file;
  };
  return {
    names: Object.keys(zip.files).filter((name) => !zip.files[name]!.dir),
    text: (path) => entry(path).async("string"),
    bytes: (path) => entry(path).async("uint8array"),
    rows: async <T>(table: string) =>
      JSON.parse(await entry(`data/${table}.json`).async("string")) as T[],
  };
}
