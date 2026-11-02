// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { EXPORT_MANIFEST_SCHEMA_VERSION, parseExportManifest } from "./export-manifest";

function validManifest() {
  return {
    schemaVersion: EXPORT_MANIFEST_SCHEMA_VERSION,
    requestId: "1e6b3b0a-2f6d-4d6e-9a3c-9d3a5a2b1c00",
    schoolId: "2e6b3b0a-2f6d-4d6e-9a3c-9d3a5a2b1c00",
    subjectScope: "tenant" as const,
    subjectUserId: null,
    generatedAt: "2026-09-09T00:00:00.000Z",
    tables: [{ table: "students", rowCount: 3, storageKey: "k1", sha256: "a".repeat(64) }],
    files: [
      {
        table: "materials",
        storageKey: "permanent/x/y/z",
        originalFileName: "notes.pdf",
        checksumSha256: "b".repeat(64),
      },
    ],
    retainedTables: [{ table: "subscriptions", reason: "financial/audit legal hold" }],
    knownGaps: [],
  };
}

describe("parseExportManifest", () => {
  test("accepts a well-formed manifest", () => {
    expect(() => parseExportManifest(validManifest())).not.toThrow();
  });

  test("rejects a wrong schema version rather than silently accepting it", () => {
    expect(() => parseExportManifest({ ...validManifest(), schemaVersion: 2 })).toThrow();
  });

  test("rejects a non-hex sha256", () => {
    const manifest = validManifest();
    manifest.tables[0]!.sha256 = "not-a-hash";
    expect(() => parseExportManifest(manifest)).toThrow();
  });

  test("rejects a missing knownGaps field rather than defaulting it silently", () => {
    const { knownGaps: _knownGaps, ...withoutGaps } = validManifest();
    expect(() => parseExportManifest(withoutGaps)).toThrow();
  });
});
