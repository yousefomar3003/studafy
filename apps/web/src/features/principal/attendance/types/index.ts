import type { components } from "@studafy/api-client";

export type AttendanceSummary = components["schemas"]["AttendanceReportSummary"];
export type AttendanceTrends = components["schemas"]["AttendanceReportTrends"];
export type AttendanceExportJob = components["schemas"]["AttendanceReportExportJob"];
export type AttendanceRecordHistory = components["schemas"]["AttendanceRecordHistory"];
export type CorrectedAttendanceRecord = components["schemas"]["CorrectedAttendanceRecord"];
export type AttendanceStatus = "present" | "absent" | "late" | "excused";
export type TrendInterval = "day" | "week" | "month" | "term";
export type DashboardView = "school" | "class";

export interface AttendanceFilters {
  view: DashboardView;
  startDate: string;
  endDate: string;
  termId?: string;
  classId?: string;
  grade?: string;
  sectionId?: string;
  status?: AttendanceStatus;
  interval: TrendInterval;
  breachesOnly: boolean;
}

export interface AttendanceMatrixRow {
  recordId: string;
  studentId: string;
  studentName: string;
  admissionNumber: string;
  classId: string;
  classCode: string;
  grade: string;
  sectionId: string;
  sectionName: string;
  sessionDate: string;
  status: AttendanceStatus;
  minutesLate: number | null;
  absentPercent: number;
  excusedPercent: number;
}

export interface AttendanceTimelineEntry {
  recordId: string;
  date: string;
  status: AttendanceStatus;
  minutesLate: number | null;
  reason: string | null;
  version: number;
  outOfWindow: boolean;
}

export interface StudentAttendanceProfile {
  studentId: string;
  studentName: string;
  admissionNumber: string;
  classCode: string;
  attendancePercent: number;
  timeline: AttendanceTimelineEntry[];
}

export interface AttendanceMetadata {
  grades: string[];
  sections: { id: string; name: string; grade: string }[];
}
