// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { buildImportTemplate, coerceImportValue, prepareImport, runImport } from "./data-transfer";

import type { ImportField } from "./data-transfer";

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
