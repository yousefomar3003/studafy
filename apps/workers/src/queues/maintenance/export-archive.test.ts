import { createHash } from "node:crypto";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { ArchivePaths, ExportArchiveWriter, safeFileName } from "./export-archive";

function collectingSink() {
  const chunks: Uint8Array[] = [];
  let failed: unknown = null;
  const sink = async (body: AsyncIterable<Uint8Array>) => {
    try {
      for await (const chunk of body) chunks.push(new Uint8Array(chunk));
    } catch (error) {
      failed = error;
      throw error;
    }
    return chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  };
  return { sink, archive: () => Buffer.concat(chunks), failed: () => failed };
}

describe("safeFileName", () => {
  test("removes path separators and characters file systems reject", () => {
    expect(safeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(safeFileName('a\\b:c*d?"e<f>g|h')).toBe("a_b_c_d__e_f_g_h");
    expect(safeFileName("tab\there\u0000")).toBe("tab_here_");
  });

  test("trims dots and spaces, and never returns an empty or reserved name", () => {
    expect(safeFileName("  .hidden. ")).toBe("hidden");
    expect(safeFileName("...")).toBe("file");
    expect(safeFileName("CON.txt")).toBe("_CON.txt");
  });

  test("keeps Arabic names and shortens long ones without losing the extension", () => {
    expect(safeFileName("واجب البيت.pdf")).toBe("واجب البيت.pdf");
    const long = safeFileName(`${"ب".repeat(300)}.docx`);
    expect([...long]).toHaveLength(150);
    expect(long.endsWith(".docx")).toBe(true);
  });
});

describe("ArchivePaths", () => {
  test("numbers repeated names within a folder, case-insensitively", () => {
    const paths = new ArchivePaths();
    expect(paths.allocate("files/a", "notes.pdf")).toBe("files/a/notes.pdf");
    expect(paths.allocate("files/a", "Notes.PDF")).toBe("files/a/Notes (2).PDF");
    expect(paths.allocate("files/a", "notes.pdf")).toBe("files/a/notes (3).pdf");
    expect(paths.allocate("files/b", "notes.pdf")).toBe("files/b/notes.pdf");
    expect(paths.allocate("files/a", "README")).toBe("files/a/README");
    expect(paths.allocate("files/a", "readme")).toBe("files/a/readme (2)");
  });
});

describe("ExportArchiveWriter", () => {
  test("writes streamed entries into a valid ZIP, with each entry's size and SHA-256", async () => {
    const { sink, archive } = collectingSink();
    const writer = new ExportArchiveWriter(sink, new Date("2026-09-09T12:00:00Z"));
    const big = new Uint8Array(300_000).map((_, index) => index % 251);

    const data = await writer.add(
      "data/rows.json",
      (async function* () {
        yield "[\n";
        yield '{"id":1}';
        yield "\n]\n";
      })(),
      { compress: true },
    );
    const file = await writer.add(
      "files/x/big.bin",
      (async function* () {
        yield big.subarray(0, 100_000);
        yield big.subarray(100_000);
      })(),
      { compress: false },
    );
    const total = await writer.finish();

    expect(data).toEqual({
      bytes: 13,
      sha256: createHash("sha256").update('[\n{"id":1}\n]\n').digest("hex"),
    });
    expect(file.bytes).toBe(big.byteLength);
    expect(file.sha256).toBe(createHash("sha256").update(big).digest("hex"));

    const zip = await JSZip.loadAsync(archive());
    expect(total).toBe(archive().byteLength);
    expect(await zip.file("data/rows.json")!.async("string")).toBe('[\n{"id":1}\n]\n');
    expect(await zip.file("files/x/big.bin")!.async("uint8array")).toEqual(big);
  });

  test("a source that fails rejects the entry, and abort fails the upload", async () => {
    const { sink, failed } = collectingSink();
    const writer = new ExportArchiveWriter(sink, new Date());
    await writer.add("README.txt", "ok", { compress: true });

    const broken = writer.add(
      "files/x/broken.bin",
      (async function* () {
        yield new Uint8Array([1, 2, 3]);
        throw new Error("storage read failed");
      })(),
      { compress: false },
    );
    await expect(broken).rejects.toThrow("storage read failed");
    await writer.abort(new Error("storage read failed"));
    // The sink saw an error, not a finished archive: a truncated ZIP is never stored as complete.
    expect(failed()).not.toBeNull();
  });

  test("a failed upload fails the export instead of hanging", async () => {
    const writer = new ExportArchiveWriter(async (body) => {
      for await (const chunk of body) {
        void chunk;
        throw new Error("upload refused");
      }
      return 0;
    }, new Date());
    const big = new Uint8Array(2_000_000);
    const attempt = (async () => {
      await writer.add("files/x/big.bin", big, { compress: false });
      await writer.add("files/x/next.bin", big, { compress: false });
      return writer.finish();
    })();
    await expect(attempt).rejects.toThrow("upload refused");
    await writer.abort(new Error("upload refused"));
  });
});
