import { api } from "../../../../lib/api";

import type {
  AttendanceExportJob,
  AttendanceFilters,
  AttendanceRecordHistory,
  AttendanceSummary,
  AttendanceTrends,
  CorrectedAttendanceRecord,
} from "../types";

function scope(filters: AttendanceFilters) {
  return filters.termId
    ? { term_id: filters.termId }
    : { start_date: filters.startDate, end_date: filters.endDate };
}

export async function fetchAttendanceSummary(
  filters: AttendanceFilters,
  groupBy: "class" | "student",
): Promise<AttendanceSummary> {
  const { data } = await api.GET("/api/attendance/reports/summary", {
    params: {
      query: {
        ...scope(filters),
        group_by: groupBy,
        limit: 500,
        offset: 0,
        ...(filters.classId ? { class_id: filters.classId } : {}),
      },
    },
  });
  if (!data) throw new Error("Attendance summary returned no data.");
  // The generated readonly-array response loses Array prototype members through openapi-fetch's
  // recursive response transform. Restore the concrete schema type at this boundary (same seam as
  // the established principal attendance query adapter).
  return data as AttendanceSummary;
}

export async function fetchAttendanceTrends(filters: AttendanceFilters): Promise<AttendanceTrends> {
  const interval = filters.interval === "term" ? "month" : filters.interval;
  const { data } = await api.GET("/api/attendance/reports/trends", {
    params: {
      query: {
        ...scope(filters),
        interval,
        ...(filters.classId ? { class_id: filters.classId } : {}),
      },
    },
  });
  if (!data) throw new Error("Attendance trends returned no data.");
  return data as AttendanceTrends;
}

export async function createAttendanceExport(
  filters: AttendanceFilters,
  fileFormat: "xlsx" | "pdf",
): Promise<AttendanceExportJob> {
  const { data } = await api.POST("/api/attendance/reports/export", {
    body: {
      ...scope(filters),
      file_format: fileFormat,
      group_by: filters.view === "class" ? "class" : "student",
      trend_interval: filters.interval === "term" ? "month" : filters.interval,
      ...(filters.classId ? { class_id: filters.classId } : {}),
    },
  });
  if (!data) throw new Error("Export request returned no job.");
  return data;
}

export async function fetchAttendanceExport(jobId: string): Promise<AttendanceExportJob> {
  const { data } = await api.GET("/api/attendance/reports/export/{jobId}", {
    params: { path: { jobId } },
  });
  if (!data) throw new Error("Export job returned no data.");
  return data;
}

export async function fetchRecordHistory(recordId: string): Promise<AttendanceRecordHistory> {
  const { data } = await api.GET("/api/attendance/records/{recordId}/history", {
    params: { path: { recordId } },
  });
  if (!data) throw new Error("Attendance history returned no data.");
  return data as AttendanceRecordHistory;
}

export async function correctAttendanceRecord(
  recordId: string,
  input: {
    status: "present" | "absent" | "late" | "excused";
    minutes_late?: number | null;
    reason: string;
  },
): Promise<CorrectedAttendanceRecord> {
  const { data } = await api.PATCH("/api/attendance/records/{recordId}", {
    params: { path: { recordId } },
    body: input,
  });
  if (!data) throw new Error("Correction returned no data.");
  return data;
}
