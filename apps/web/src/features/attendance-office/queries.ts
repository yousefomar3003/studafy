import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../lib/api";

import type { components } from "@studafy/api-client";

export type AttendanceSession = components["schemas"]["AttendanceSession"];
export type AttendanceRecord = components["schemas"]["AttendanceRecord"];
export type AttendanceStatus = AttendanceRecord["status"];
export type BatchRecordItem = components["schemas"]["BatchRecordItem"];
type Enrollment = components["schemas"]["Enrollment"];

/**
 * Data for the attendance office (`/portal/attendance`). The academic structure (terms, classes,
 * students) is read through the principal's school queries; this file adds the attendance-taking
 * reads and writes the office needs on top. Registers are daily (`period` null): the office takes
 * one register per class per school day, which is what an attendance office records.
 */
const KEY = "attendance-office";

const SESSION_PAGE_SIZE = 100;
const MAX_PAGES = 50;
/** `POST /api/attendance/records/batch` accepts at most 50 records per call. */
const BATCH_SIZE = 50;

export const sessionsForDateKey = (date: string) => [KEY, "sessions", date] as const;
export const sessionRecordsKey = (sessionId: string) => [KEY, "records", sessionId] as const;
export const rosterKey = (classId: string) => [KEY, "roster", classId] as const;

/** Every daily register opened in the school on `date`, keyed by class id. */
async function fetchDailySessions(date: string): Promise<Map<string, AttendanceSession>> {
  const byClass = new Map<string, AttendanceSession>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data } = await api.GET("/api/attendance/sessions", {
      params: {
        query: { session_date: date, limit: SESSION_PAGE_SIZE, offset: page * SESSION_PAGE_SIZE },
      },
    });
    const rows = (data?.attendance_sessions ?? []) as AttendanceSession[];
    for (const session of rows) {
      if (session.period === null && session.status !== "cancelled") {
        byClass.set(session.class_id, session);
      }
    }
    if (rows.length < SESSION_PAGE_SIZE) break;
  }
  return byClass;
}

export function useDailySessions(date: string) {
  return useQuery({ queryKey: sessionsForDateKey(date), queryFn: () => fetchDailySessions(date) });
}

/** Student ids actively enrolled in a class — the register's roster. */
async function fetchRoster(classId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data } = await api.GET("/api/academics/classes/{classId}/enrollments", {
      params: {
        path: { classId },
        query: { status: "active", limit: SESSION_PAGE_SIZE, offset: page * SESSION_PAGE_SIZE },
      },
    });
    // Same readonly-array typing gap in the generated response as the other paged readers here.
    const rows = (data?.enrollments ?? []) as Enrollment[];
    ids.push(...rows.map((enrollment) => enrollment.student_id));
    if (rows.length < SESSION_PAGE_SIZE || ids.length >= (data?.total ?? 0)) break;
  }
  return ids;
}

export function useRoster(classId: string) {
  return useQuery({ queryKey: rosterKey(classId), queryFn: () => fetchRoster(classId) });
}

export function useSessionRecords(sessionId: string | undefined) {
  return useQuery({
    queryKey: sessionRecordsKey(sessionId ?? ""),
    enabled: sessionId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/attendance/sessions/{sessionId}/records", {
        params: { path: { sessionId: sessionId! } },
      });
      return (data?.records ?? []) as AttendanceRecord[];
    },
  });
}

/**
 * Saves a register in one go: opens (or reuses) the class's daily session, records every entry not
 * already recorded in batches of 50, then submits the session so it counts in reports and becomes
 * correctable. Every step is idempotent server-side, so retrying after a partial failure finishes
 * the job rather than duplicating it.
 */
export function useSubmitRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      classId: string;
      date: string;
      existingSession: AttendanceSession | undefined;
      records: BatchRecordItem[];
    }) => {
      let session = input.existingSession;
      if (!session) {
        const { data } = await api.POST("/api/attendance/sessions", {
          body: { class_id: input.classId, session_date: input.date },
        });
        if (!data) throw new Error("Opening the register returned no session.");
        session = data;
      }
      if (session.status === "draft") {
        const { data } = await api.PATCH("/api/attendance/sessions/{sessionId}", {
          params: { path: { sessionId: session.id } },
          body: { status: "open" },
        });
        if (!data) throw new Error("Opening the register returned no session.");
        session = data;
      }

      for (let start = 0; start < input.records.length; start += BATCH_SIZE) {
        await api.POST("/api/attendance/records/batch", {
          body: {
            attendance_session_id: session.id,
            records: input.records.slice(start, start + BATCH_SIZE),
          },
        });
      }

      if (session.status === "open") {
        await api.PATCH("/api/attendance/sessions/{sessionId}", {
          params: { path: { sessionId: session.id } },
          body: { status: "submitted" },
        });
      }
      return session.id;
    },
    onSuccess: (sessionId, input) => {
      void queryClient.invalidateQueries({ queryKey: sessionsForDateKey(input.date) });
      void queryClient.invalidateQueries({ queryKey: sessionRecordsKey(sessionId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Dashboard reads (view-only for every role that opens the dashboard)
// ---------------------------------------------------------------------------

export type AttendanceSummary = components["schemas"]["AttendanceReportSummary"];
export type StudentSummaryItem = components["schemas"]["AttendanceReportStudentSummaryItem"];
export type StudentAttendanceEntry = components["schemas"]["StudentAttendanceEntry"];
type StudentProfile = components["schemas"]["StudentProfile"];

/** What a report covers: a whole term, or an explicit inclusive date range. */
export type ReportScope = { termId: string } | { startDate: string; endDate: string };

function scopeQuery(scope: ReportScope) {
  return "termId" in scope
    ? { term_id: scope.termId }
    : { start_date: scope.startDate, end_date: scope.endDate };
}

const SUMMARY_PAGE_SIZE = 500;

/**
 * Attendance totals for the scope, with one item per student when `groupBy` is "student" (paged
 * through, so a large school's whole list comes back). Row scope applies server-side: a teacher's
 * totals and students cover only the classes they teach.
 */
async function fetchSummary(
  scope: ReportScope,
  groupBy: "class" | "student",
  studentId?: string,
): Promise<AttendanceSummary> {
  let first: AttendanceSummary | undefined;
  const items: AttendanceSummary["items"][number][] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data } = await api.GET("/api/attendance/reports/summary", {
      params: {
        query: {
          ...scopeQuery(scope),
          group_by: groupBy,
          limit: SUMMARY_PAGE_SIZE,
          offset: page * SUMMARY_PAGE_SIZE,
          ...(studentId ? { student_id: studentId } : {}),
        },
      },
    });
    if (!data) throw new Error("Attendance summary returned no data.");
    // Same readonly-array typing gap in the generated response as the other paged readers here.
    const summary = data as AttendanceSummary;
    first ??= summary;
    items.push(...summary.items);
    if (items.length >= summary.pagination.total || summary.items.length < SUMMARY_PAGE_SIZE) break;
  }
  return { ...first!, items };
}

export function useAttendanceSummary(
  scope: ReportScope | undefined,
  groupBy: "class" | "student",
  studentId?: string,
) {
  return useQuery({
    queryKey: [KEY, "summary", groupBy, scope, studentId ?? null],
    enabled: scope !== undefined,
    queryFn: () => fetchSummary(scope!, groupBy, studentId),
  });
}

/** One student's records in sessions dated within the range, newest first. */
export function useStudentAttendance(studentId: string, startDate?: string, endDate?: string) {
  return useQuery({
    queryKey: [KEY, "student-records", studentId, startDate, endDate],
    enabled: Boolean(startDate && endDate),
    queryFn: async () => {
      const { data } = await api.GET("/api/attendance/students/{studentId}/records", {
        params: {
          path: { studentId },
          query: { start_date: startDate!, end_date: endDate! },
        },
      });
      return (data?.records ?? []) as StudentAttendanceEntry[];
    },
  });
}

export function useStudent(studentId: string) {
  return useQuery({
    queryKey: [KEY, "student", studentId],
    queryFn: async () => {
      const { data } = await api.GET("/api/students/{studentId}", {
        params: { path: { studentId } },
      });
      return (data ?? null) as StudentProfile | null;
    },
  });
}

/** Students matching a name or admission number, within the caller's row scope. */
export function useStudentSearch(term: string) {
  const query = term.trim();
  return useQuery({
    queryKey: [KEY, "student-search", query],
    enabled: query.length >= 2,
    queryFn: async () => {
      const { data } = await api.GET("/api/students", {
        params: { query: { search: query, limit: 8 } },
      });
      return (data?.students ?? []) as StudentProfile[];
    },
  });
}

/** Attendance rate: present plus late, since a late student attended. */
export function attendanceRate(metrics: { present_percent: number; late_percent: number }): number {
  return metrics.present_percent + metrics.late_percent;
}
