import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  correctAttendanceRecord,
  createAttendanceExport,
  fetchAttendanceExport,
  fetchAttendanceSummary,
  fetchAttendanceTrends,
  fetchRecordHistory,
} from "../api/attendanceApi";
import {
  fetchAttendanceMatrixFixture,
  fetchAttendanceMetadataFixture,
  fetchStudentProfileFixture,
} from "../api/attendanceFixtures";

import type { AttendanceFilters } from "../types";

export const attendanceKeys = {
  all: ["principal-attendance"] as const,
  summary: (filters: AttendanceFilters, groupBy: "class" | "student") =>
    [...attendanceKeys.all, "summary", groupBy, filters] as const,
  trends: (filters: AttendanceFilters) => [...attendanceKeys.all, "trends", filters] as const,
  matrix: () => [...attendanceKeys.all, "matrix"] as const,
  metadata: () => [...attendanceKeys.all, "metadata"] as const,
  profile: (studentId: string) => [...attendanceKeys.all, "profile", studentId] as const,
  history: (recordId: string) => [...attendanceKeys.all, "history", recordId] as const,
};

export function useAttendanceSummary(filters: AttendanceFilters, groupBy: "class" | "student") {
  return useQuery({
    queryKey: attendanceKeys.summary(filters, groupBy),
    queryFn: () => fetchAttendanceSummary(filters, groupBy),
  });
}

export function useAttendanceTrends(filters: AttendanceFilters) {
  return useQuery({
    queryKey: attendanceKeys.trends(filters),
    queryFn: () => fetchAttendanceTrends(filters),
  });
}

export function useAttendanceMatrix() {
  return useQuery({ queryKey: attendanceKeys.matrix(), queryFn: fetchAttendanceMatrixFixture });
}

export function useAttendanceMetadata() {
  return useQuery({ queryKey: attendanceKeys.metadata(), queryFn: fetchAttendanceMetadataFixture });
}

export function useStudentProfile(studentId: string | null) {
  return useQuery({
    queryKey: attendanceKeys.profile(studentId ?? "none"),
    queryFn: () => fetchStudentProfileFixture(studentId!),
    enabled: studentId !== null,
  });
}

export function useRecordHistory(recordId: string | null) {
  return useQuery({
    queryKey: attendanceKeys.history(recordId ?? "none"),
    queryFn: () => fetchRecordHistory(recordId!),
    enabled: recordId !== null,
    retry: false,
  });
}

export function useCorrectAttendance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      recordId,
      status,
      minutesLate,
      reason,
    }: {
      recordId: string;
      status: "present" | "absent" | "late" | "excused";
      minutesLate?: number | null;
      reason: string;
    }) =>
      correctAttendanceRecord(recordId, {
        status,
        minutes_late: status === "late" ? minutesLate : null,
        reason,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
    },
  });
}

export function useAttendanceExport(filters: AttendanceFilters) {
  const create = useMutation({
    mutationFn: (format: "xlsx" | "pdf") => createAttendanceExport(filters, format),
  });
  const jobId = create.data?.id;
  const job = useQuery({
    queryKey: [...attendanceKeys.all, "export", jobId],
    queryFn: () => fetchAttendanceExport(jobId!),
    enabled: Boolean(jobId),
    initialData: create.data,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "processing" ? 1_500 : false;
    },
  });
  return { create, job: job.data, isPolling: job.isFetching };
}
