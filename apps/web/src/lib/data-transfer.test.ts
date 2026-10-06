// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  buildExportCsv,
  buildImportTemplate,
  coerceImportValue,
  collectCursorPages,
  collectOffsetPages,
  exportFilename,
  prepareImport,
  runImport,
} from "./data-transfer";

import type { ImportField } from "./data-transfer";

describe("collectCursorPages", () => {
  test("follows cursors until exhausted", async () => {
    const pages: Record<string, { items: number[]; nextCursor?: string }> = {
      start: { items: [1, 2], nextCursor: "b" },
      b: { items: [3], nextCursor: "c" },
      c: { items: [4] },
    };
    const result = await collectCursorPages(async (cursor) => pages[cursor ?? "start"]!);
    expect(result).toEqual({ rows: [1, 2, 3, 4], truncated: false });
  });

  test("stops at the row cap and reports truncation", async () => {
    const result = await collectCursorPages(async () => ({ items: [1, 2, 3], nextCursor: "x" }), 5);
    expect(result).toEqual({ rows: [1, 2, 3, 1, 2], truncated: true });
  });
});

describe("collectOffsetPages", () => {
  test("pages by offset until total", async () => {
    const data = [1, 2, 3, 4, 5];
    const result = await collectOffsetPages(async (offset) => ({
      items: data.slice(offset, offset + 2),
      total: data.length,
    }));
    expect(result).toEqual({ rows: data, truncated: false });
  });

  test("stops on an empty page even if total overcounts", async () => {
    const result = await collectOffsetPages(async (offset) => ({
      items: offset === 0 ? [1] : [],
      total: 10,
    }));
    expect(result).toEqual({ rows: [1], truncated: false });
  });

  test("reports truncation at the cap", async () => {
    const result = await collectOffsetPages(async () => ({ items: [1, 2], total: 100 }), 3);
    expect(result).toEqual({ rows: [1, 2, 1], truncated: true });
  });
});

describe("export helpers", () => {
  test("buildExportCsv maps columns over rows", () => {
    const csv = buildExportCsv(
      [
        { header: "Name", value: (row: { name: string; n: number }) => row.name },
        { header: "N", value: (row) => row.n },
      ],
      [{ name: "A", n: 1 }],
    );
    expect(csv).toBe("Name,N\r\nA,1");
  });

  test("exportFilename dates the file", () => {
    expect(exportFilename("classes", new Date(2026, 0, 5))).toBe("classes-2026-01-05.csv");
  });
});

const FIELDS: ImportField[] = [
  { key: "name", label: "Name", required: true, maxLength: 5 },
  { key: "starts_on", label: "Start", type: "date" },
  { key: "kind", label: "Kind", options: ["Holiday", "Exam"] },
  { key: "count", label: "Count", type: "integer" },
];

describe("coerceImportValue", () => {
  test("blank optional is null, blank required is an issue", () => {
    expect(coerceImportValue(FIELDS[1]!, " ")).toEqual({ value: null });
    expect(coerceImportValue(FIELDS[0]!, "")).toEqual({
      issue: { code: "required", field: "Name" },
    });
  });

  test("rejects impossible dates", () => {
    expect(coerceImportValue(FIELDS[1]!, "2026-02-30")).toEqual({
      issue: { code: "invalidDate", field: "Start" },
    });
    expect(coerceImportValue(FIELDS[1]!, "2026-02-28")).toEqual({ value: "2026-02-28" });
  });

  test("matches options case-insensitively and keeps canonical spelling", () => {
    expect(coerceImportValue(FIELDS[2]!, "exam")).toEqual({ value: "Exam" });
  });

  test("enforces maxLength and integer", () => {
    expect(coerceImportValue(FIELDS[0]!, "toolong")).toMatchObject({ issue: { code: "tooLong" } });
    expect(coerceImportValue(FIELDS[3]!, "1.5")).toMatchObject({
      issue: { code: "invalidInteger" },
    });
  });
});

describe("prepareImport", () => {
  const spec = {
    fields: FIELDS,
    toRecord: (values: Readonly<Record<string, unknown>>) =>
      values.name === "bad" ? { errors: ["Custom rejection"] } : { ...values },
  };

  test("validates rows and matches headers loosely", () => {
    const result = prepareImport(
      "Name,Starts On,extra\nAda,2026-01-01,x\n,2026-13-01,y\nbad,,z",
      spec,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ignoredColumns).toEqual(["extra"]);
    expect(result.rows.map((row) => [row.line, row.issues.map((i) => i.code)])).toEqual([
      [2, []],
      [3, ["required", "invalidDate"]],
      [4, ["custom"]],
    ]);
    expect(result.rows[0]!.record).toEqual({
      name: "Ada",
      starts_on: "2026-01-01",
      kind: null,
      count: null,
    });
  });

  test("rejects files missing required columns, empty files, and oversized files", () => {
    expect(prepareImport("starts_on\n2026-01-01", spec)).toEqual({
      ok: false,
      reason: "missingColumns",
      missingColumns: ["name"],
    });
    expect(prepareImport("name\n", spec)).toEqual({ ok: false, reason: "empty" });
    expect(prepareImport("name\na\nb\nc", spec, 2)).toEqual({
      ok: false,
      reason: "tooManyRows",
      limit: 2,
    });
  });

  test("template round-trips through prepareImport", () => {
    const template = buildImportTemplate([
      { key: "name", label: "Name", required: true, example: "Ada" },
    ]);
    const result = prepareImport(template, { fields: FIELDS.slice(0, 1), toRecord: (v) => v });
    expect(result.ok && result.rows[0]!.record).toEqual({ name: "Ada" });
  });
});

describe("runImport", () => {
  test("creates valid rows only and records failures by line", async () => {
    const created: string[] = [];
    const results = await runImport(
      [
        { line: 2, raw: {}, record: "a", issues: [] },
        { line: 3, raw: {}, record: null, issues: [{ code: "required" }] },
        { line: 4, raw: {}, record: "boom", issues: [] },
      ],
      async (record: string) => {
        if (record === "boom") throw new Error("Duplicate");
        created.push(record);
      },
    );
    expect(created).toEqual(["a"]);
    expect(results).toEqual([
      { line: 2, ok: true },
      { line: 4, ok: false, error: "Duplicate" },
    ]);
  });

  test("stops when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const results = await runImport(
      [{ line: 2, raw: {}, record: "a", issues: [] }],
      async () => undefined,
      { signal: controller.signal },
    );
    expect(results).toEqual([]);
  });
});
