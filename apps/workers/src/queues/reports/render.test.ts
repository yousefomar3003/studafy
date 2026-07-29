import { attendanceExportJobDataSchema } from "@studafy/attendance-reporting";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";
import { Workbook } from "exceljs";
import { PDFDocument } from "pdf-lib";

import { renderPdf, renderXlsx } from "./render";

import type { RenderInput } from "./render";

const input: RenderInput = {
  generatedAt: new Date("2026-07-29T10:00:00.000Z"),
  filter: {
    termId: null,
    startDate: "2026-07-01",
    endDate: "2026-07-31",
  },
  groupBy: "class",
  trendInterval: "week",
  summary: {
    totals: {
      total_records: 4,
      present_count: 2,
      absent_count: 1,
      late_count: 1,
      excused_count: 0,
      present_percent: 50,
      absent_percent: 25,
      late_percent: 25,
      excused_percent: 0,
    },
    items: [
      {
        group_by: "class",
        class_id: "891a50fb-7f88-47be-95a4-161618024aa4",
        class_code: "7-A",
        total_records: 4,
        present_count: 2,
        absent_count: 1,
        late_count: 1,
        excused_count: 0,
        present_percent: 50,
        absent_percent: 25,
        late_percent: 25,
        excused_percent: 0,
      },
    ],
    total_groups: 1,
  },
  trends: [
    {
      bucket_start: "2026-07-06",
      total_records: 4,
      present_count: 2,
      absent_count: 1,
      late_count: 1,
      excused_count: 0,
      present_percent: 50,
      absent_percent: 25,
      late_percent: 25,
      excused_percent: 0,
    },
  ],
};

describe("attendance report artifacts", () => {
  test("XLSX contains metadata, summary, and trends sections", async () => {
    const artifact = await renderXlsx(input);
    const workbook = new Workbook();
    await workbook.xlsx.load(artifact.buffer as ArrayBuffer);

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "Metadata",
      "Summary",
      "Trends",
    ]);
    expect(workbook.getWorksheet("Metadata")?.getCell("B2").value).toBe("2026-07-29T10:00:00.000Z");
    expect(workbook.getWorksheet("Summary")?.getCell("A3").value).toBe("7-A");
    expect(workbook.getWorksheet("Trends")?.getCell("A2").value).toBe("2026-07-06");
  });

  test("PDF is a parseable document with report metadata", async () => {
    const artifact = await renderPdf(input);
    const document = await PDFDocument.load(artifact);
    expect(document.getTitle()).toBe("Studafy Attendance Summary");
    expect(document.getPageCount()).toBeGreaterThan(0);
  });

  test("queue payload schema is versioned and strict", () => {
    const payload = {
      version: 1,
      jobId: "f1eb83c0-ae1f-4b3a-962d-6db28640d68a",
      schoolId: "5f417184-d876-4e6a-88cb-9fd589141b54",
      requestedByUserId: "c9dac2e9-8b48-416f-a0dd-e21f6d6c1dac",
      filter: input.filter,
      groupBy: input.groupBy,
      trendInterval: input.trendInterval,
      fileFormat: "pdf",
    };
    expect(attendanceExportJobDataSchema.safeParse(payload).success).toBe(true);
    expect(attendanceExportJobDataSchema.safeParse({ ...payload, version: 2 }).success).toBe(false);
    expect(attendanceExportJobDataSchema.safeParse({ ...payload, unexpected: true }).success).toBe(
      false,
    );
  });
});
