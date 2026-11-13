/**
 * Student progress report type (ST-176).
 *
 * The third entry in the report type registry. The storage key and content headers follow the
 * attendance pattern (`reports/<schoolId>/<jobId>/...`, attachment download). The renderer reads
 * the replica under the requesting user's role scope — the report contains exactly the published
 * grades, attendance and teacher comments that user is entitled to see — then draws a PDF with the
 * same Noto Sans Arabic + bidi approach the finance worker uses, so Arabic school data renders
 * correctly.
 *
 * Grades and attendance delegate to the shared @studafy/grades-reporting and
 * @studafy/attendance-reporting packages, guaranteeing the report reconciles with the published
 * grades API and the attendance summary API.
 */

import notoSansArabic from "@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-400-normal.woff" with { type: "file" };
import * as fontkit from "@pdf-lib/fontkit";
import {
  queryCompleteAttendanceReport,
  type AttendanceSummaryResult,
  type AttendanceTrendPoint,
  type ResolvedReportFilter,
} from "@studafy/attendance-reporting";
import {
  calculateGradeBreakdown,
  loadPublishedGradeRows,
  queryStudentTermSummary,
  round2,
  type PublishedGradeItem,
} from "@studafy/grades-reporting";
import {
  queryStudentIdentity,
  queryTeacherTermComments,
  queryTermInfo,
  type ProgressReportJobData,
  type StudentIdentity,
  type TeacherTermComment,
  type TermInfo,
} from "@studafy/progress-reporting";
import bidiFactory from "bidi-js";
import { PDFDocument, rgb } from "pdf-lib";

import { withTenantTx } from "../../db/tenant-tx";

import type { ReportRenderDeps } from "./report-types";
import type { TransactionSql } from "postgres";

export function progressReportStorageKey(data: ProgressReportJobData): string {
  return `reports/${data.schoolId}/${data.jobId}/progress-report.pdf`;
}

export function progressContentType(): string {
  return "application/pdf";
}

export function progressContentDisposition(): string {
  return `attachment; filename="progress-report.pdf"`;
}

export interface TermSummaryDisplay {
  term_average_percentage: number | null;
  term_gpa: number | null;
  total_credits: number;
}

export interface ProgressReportRenderInput {
  generatedAt: Date;
  student: StudentIdentity;
  term: TermInfo;
  grades: PublishedGradeItem[];
  termSummary: TermSummaryDisplay;
  attendance: { summary: AttendanceSummaryResult; trends: AttendanceTrendPoint[] };
  comments: TeacherTermComment[];
}

const bidi = bidiFactory();
const ARABIC_PATTERN = /[\u0600-\u06ff]/;

function visualPdfText(value: string): string {
  if (!ARABIC_PATTERN.test(value)) return value;
  const characters = [...value];
  const levels = bidi.getEmbeddingLevels(value, "rtl");
  for (const [start, end] of bidi.getReorderSegments(value, levels)) {
    const reversed = characters.slice(start, end + 1).reverse();
    characters.splice(start, reversed.length, ...reversed);
  }
  for (const [index, replacement] of bidi.getMirroredCharactersMap(value, levels)) {
    characters[index] = replacement;
  }
  return characters.join("");
}

/** Wrap a long logical string into fixed-width lines for page drawing. */
function wrapText(value: string, width: number): string[] {
  const lines: string[] = [];
  for (let offset = 0; offset < value.length; offset += width) {
    lines.push(value.slice(offset, offset + width));
  }
  return lines.length === 0 ? [""] : lines;
}

export async function renderProgressReportPdf(
  input: ProgressReportRenderInput,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  document.setTitle("Studafy Progress Report");
  document.setSubject(
    "Per-student term progress report: published grades, attendance and teacher comments",
  );
  document.setCreationDate(input.generatedAt);
  document.setModificationDate(input.generatedAt);
  const fontBytes = await Bun.file(notoSansArabic).arrayBuffer();
  const font = await document.embedFont(fontBytes, { subset: true });

  const pageSize: [number, number] = [595, 842];
  const margin = 36;
  let page = document.addPage(pageSize);
  let y = page.getHeight() - margin;

  const drawLine = (value: string, size = 8, useBold = false, color = rgb(0.08, 0.12, 0.18)) => {
    const rendered = visualPdfText(value);
    const width = font.widthOfTextAtSize(rendered, size);
    const rtl = ARABIC_PATTERN.test(value);
    const x = rtl ? Math.max(margin, page.getWidth() - margin - width) : margin;
    page.drawText(rendered, { x, y, size, font, color });
    return width;
  };

  const nextRow = (size = 15) => {
    y -= size;
    if (y < margin) {
      page = document.addPage(pageSize);
      y = page.getHeight() - margin;
    }
  };

  const section = (label: string) => {
    y -= 6;
    drawLine(label, 12, true, rgb(0.12, 0.31, 0.47));
    nextRow(18);
  };

  const bodyText = (value: string, size = 8) => {
    const width = 110;
    for (const line of wrapText(value, width)) {
      drawLine(line, size);
      nextRow(12);
    }
  };

  drawLine("Studafy Progress Report", 16, true);
  nextRow(20);
  drawLine(`Generated: ${input.generatedAt.toISOString()}`, 9);
  nextRow(14);
  drawLine(`Student: ${input.student.studentName}`, 10, true);
  nextRow(14);
  drawLine(`Admission number: ${input.student.admissionNumber}`, 9);
  nextRow(12);
  drawLine(`Term: ${input.term.termName} (${input.term.startsOn} to ${input.term.endsOn})`, 9);
  nextRow(18);

  section("Published Grades");
  if (input.grades.length === 0) {
    bodyText("No published grades for this term.");
    nextRow();
  } else {
    for (const grade of input.grades) {
      const line =
        `${grade.course.name} (${grade.class.code}) — ${grade.label} — ` +
        `${grade.percentage === null ? "n/a" : `${grade.percentage}%`} — ` +
        `Grade ${grade.grade_label ?? "n/a"}` +
        (grade.gpa_points === null ? "" : ` — GPA ${grade.gpa_points}`) +
        ` — ${grade.course.credit_hours} credit${grade.course.credit_hours === 1 ? "" : "s"}`;
      bodyText(line);
    }
    const summaryLine =
      `Term average: ${input.termSummary.term_average_percentage === null ? "n/a" : `${input.termSummary.term_average_percentage}%`} | ` +
      `Term GPA: ${input.termSummary.term_gpa ?? "n/a"} | ` +
      `Credits: ${input.termSummary.total_credits}`;
    nextRow();
    drawLine(summaryLine, 9, true);
    nextRow();
  }

  section("Attendance");
  const totals = input.attendance.summary.totals;
  const attendanceLine =
    `Total records: ${totals.total_records} | ` +
    `Present: ${totals.present_count} (${totals.present_percent}%) | ` +
    `Absent: ${totals.absent_count} (${totals.absent_percent}%) | ` +
    `Late: ${totals.late_count} (${totals.late_percent}%) | ` +
    `Excused: ${totals.excused_count} (${totals.excused_percent}%)`;
  bodyText(attendanceLine);
  if (totals.total_records === 0) bodyText("No attendance records in this term.");

  section("Teacher Comments");
  if (input.comments.length === 0) {
    bodyText("No teacher comments for this term.");
  } else {
    for (const comment of input.comments) {
      drawLine(`${comment.courseName} (${comment.classCode}) — ${comment.authorName}`, 9, true);
      nextRow(12);
      bodyText(comment.comment);
      nextRow(8);
    }
  }

  return document.save({ useObjectStreams: false });
}

interface ProgressReportData {
  student: StudentIdentity;
  term: TermInfo;
  grades: PublishedGradeItem[];
  termSummary: TermSummaryDisplay;
  attendance: { summary: AttendanceSummaryResult; trends: AttendanceTrendPoint[] };
  comments: TeacherTermComment[];
}

async function collectProgressReport(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  termId: string,
): Promise<ProgressReportData> {
  const student = await queryStudentIdentity(tx, schoolId, studentId);
  if (!student) throw new Error("student is not visible to the requesting user");

  const term = await queryTermInfo(tx, schoolId, termId);
  if (!term) throw new Error("academic term does not exist");

  const rows = await loadPublishedGradeRows(tx, schoolId, studentId, termId);
  const { grades } = await calculateGradeBreakdown(tx, schoolId, rows);
  const summary = await queryStudentTermSummary(tx, schoolId, studentId, termId);

  const attendanceFilter: ResolvedReportFilter = {
    termId,
    startDate: term.startsOn,
    endDate: term.endsOn,
    studentId,
  };
  const attendance = await queryCompleteAttendanceReport(
    tx,
    schoolId,
    attendanceFilter,
    "student",
    "week",
  );
  const comments = await queryTeacherTermComments(tx, schoolId, studentId, termId);

  return {
    student,
    term,
    grades,
    termSummary: {
      term_average_percentage:
        summary === null || summary.term_average_percentage === null
          ? null
          : round2(Number(summary.term_average_percentage)),
      term_gpa:
        summary === null || summary.term_gpa === null ? null : round2(Number(summary.term_gpa)),
      total_credits: summary ? round2(Number(summary.total_credits)) : 0,
    },
    attendance,
    comments,
  };
}

export async function renderProgressReport(
  deps: ReportRenderDeps<ProgressReportJobData>,
): Promise<Uint8Array> {
  const replica = deps.replica;
  if (!replica) throw new Error("progress report requires a read database");
  const data = deps.data;
  const report = await withTenantTx(
    replica,
    { schoolId: data.schoolId, userId: data.requestedByUserId },
    (tx) => collectProgressReport(tx, data.schoolId, data.studentId, data.termId),
    { readOnly: true },
  );
  return renderProgressReportPdf({ generatedAt: deps.now, ...report });
}
