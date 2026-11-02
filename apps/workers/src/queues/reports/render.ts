import { Workbook } from "exceljs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import type {
  AttendanceMetrics,
  AttendanceSummaryItem,
  AttendanceSummaryResult,
  AttendanceTrendPoint,
  ReportGroupBy,
  ReportTrendInterval,
  ResolvedReportFilter,
} from "@studafy/attendance-reporting";

export interface RenderInput {
  generatedAt: Date;
  filter: ResolvedReportFilter;
  groupBy: ReportGroupBy;
  trendInterval: ReportTrendInterval;
  summary: AttendanceSummaryResult;
  trends: AttendanceTrendPoint[];
}

const METRIC_HEADERS = [
  "Total",
  "Present",
  "Present %",
  "Absent",
  "Absent %",
  "Late",
  "Late %",
  "Excused",
  "Excused %",
] as const;

function metricValues(metrics: AttendanceMetrics): (string | number)[] {
  return [
    metrics.total_records,
    metrics.present_count,
    metrics.present_percent,
    metrics.absent_count,
    metrics.absent_percent,
    metrics.late_count,
    metrics.late_percent,
    metrics.excused_count,
    metrics.excused_percent,
  ];
}

function groupValues(item: AttendanceSummaryItem): (string | number)[] {
  return item.group_by === "class"
    ? [item.class_code, ...metricValues(item)]
    : [item.student_name, item.admission_number, ...metricValues(item)];
}

export async function renderXlsx(input: RenderInput): Promise<Uint8Array> {
  const workbook = new Workbook();
  workbook.creator = "Studafy";
  workbook.created = input.generatedAt;
  workbook.modified = input.generatedAt;

  const metadata = workbook.addWorksheet("Metadata");
  metadata.addRows([
    ["Report", "Attendance Summary"],
    ["Generated at (UTC)", input.generatedAt.toISOString()],
    ["Term ID", input.filter.termId ?? ""],
    ["Start date", input.filter.startDate],
    ["End date", input.filter.endDate],
    ["Class ID", input.filter.classId ?? ""],
    ["Student ID", input.filter.studentId ?? ""],
    ["Grouped by", input.groupBy],
    ["Trend interval", input.trendInterval],
  ]);
  metadata.getColumn(1).font = { bold: true };
  metadata.columns = [{ width: 24 }, { width: 48 }];

  const summary = workbook.addWorksheet("Summary");
  const groupHeaders = input.groupBy === "class" ? ["Class"] : ["Student", "Admission number"];
  summary.addRow([...groupHeaders, ...METRIC_HEADERS]);
  summary.addRow([
    "Overall",
    ...(input.groupBy === "student" ? [""] : []),
    ...metricValues(input.summary.totals),
  ]);
  for (const item of input.summary.items) summary.addRow(groupValues(item));
  summary.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  summary.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
  summary.views = [{ state: "frozen", ySplit: 1 }];
  summary.columns.forEach((column, index) => {
    column.width = index < groupHeaders.length ? 24 : 13;
  });

  const trends = workbook.addWorksheet("Trends");
  trends.addRow(["Bucket", ...METRIC_HEADERS]);
  for (const point of input.trends) {
    trends.addRow([point.bucket_start, ...metricValues(point)]);
  }
  trends.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  trends.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
  trends.views = [{ state: "frozen", ySplit: 1 }];
  trends.columns.forEach((column, index) => {
    column.width = index === 0 ? 16 : 13;
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

export async function renderPdf(input: RenderInput): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setTitle("Studafy Attendance Summary");
  document.setAuthor("Studafy");
  document.setCreationDate(input.generatedAt);
  document.setModificationDate(input.generatedAt);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const pageSize: [number, number] = [842, 595];
  const margin = 36;
  const rowHeight = 15;

  let page = document.addPage(pageSize);
  let y = page.getHeight() - margin;

  const addText = (text: string, x: number, size = 8, useBold = false) => {
    page.drawText(text.slice(0, 52), {
      x,
      y,
      size,
      font: useBold ? bold : regular,
      color: rgb(0.08, 0.13, 0.2),
    });
  };
  const nextRow = () => {
    y -= rowHeight;
    if (y < margin) {
      page = document.addPage(pageSize);
      y = page.getHeight() - margin;
    }
  };

  addText("Studafy Attendance Summary", margin, 16, true);
  nextRow();
  addText(`Generated: ${input.generatedAt.toISOString()}`, margin, 9);
  nextRow();
  addText(
    `Period: ${input.filter.startDate} to ${input.filter.endDate} | Group: ${input.groupBy}`,
    margin,
    9,
  );
  nextRow();
  addText(
    `Overall: ${input.summary.totals.total_records} records | Present ${input.summary.totals.present_percent}% | Absent ${input.summary.totals.absent_percent}% | Late ${input.summary.totals.late_percent}% | Excused ${input.summary.totals.excused_percent}%`,
    margin,
    9,
  );
  nextRow();
  nextRow();
  addText("Summary", margin, 12, true);
  nextRow();

  const drawMetricRow = (label: string, metrics: AttendanceMetrics) => {
    addText(label, margin, 7);
    const values = [
      metrics.total_records,
      `${metrics.present_count} (${metrics.present_percent}%)`,
      `${metrics.absent_count} (${metrics.absent_percent}%)`,
      `${metrics.late_count} (${metrics.late_percent}%)`,
      `${metrics.excused_count} (${metrics.excused_percent}%)`,
    ];
    values.forEach((value, index) => addText(String(value), 330 + index * 90, 7));
    nextRow();
  };

  addText("Group", margin, 7, true);
  ["Total", "Present", "Absent", "Late", "Excused"].forEach((header, index) =>
    addText(header, 330 + index * 90, 7, true),
  );
  nextRow();
  for (const item of input.summary.items) {
    const label =
      item.group_by === "class"
        ? item.class_code
        : `${item.student_name} (${item.admission_number})`;
    drawMetricRow(label, item);
  }

  nextRow();
  addText(`Trends (${input.trendInterval})`, margin, 12, true);
  nextRow();
  for (const point of input.trends) drawMetricRow(point.bucket_start, point);

  return document.save({ useObjectStreams: false });
}
