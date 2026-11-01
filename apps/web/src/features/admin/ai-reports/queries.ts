import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";
import { fetchStudent, studentQueryKey } from "../students/queries";

import type { components } from "@studafy/api-client";

export type AiReportSummary = components["schemas"]["AiContentReportSummary"];
export type AiReport = components["schemas"]["AiContentReport"];
export type AiReportStatus = AiReportSummary["status"];
export type AiReportPriority = AiReportSummary["priority"];

/**
 * The AI content moderation queue (`/api/ai/moderation/reports`, `aiContent:moderate`): students'
 * reports of AI output and the safety filter's escalations. The list omits the reported text; only
 * the detail read returns it, and that read is audit-logged on the server.
 */
const KEY = ["admin", "ai-reports"] as const;
const PAGE_SIZE = 50;

export function aiReportKey(reportId: string) {
  return [...KEY, "detail", reportId] as const;
}

/** `status` undefined lists every open report (pending, in review, escalated). */
export function useAiReports(status: AiReportStatus | undefined, page: number) {
  return useQuery({
    queryKey: [...KEY, "list", status ?? "open", page],
    queryFn: async () => {
      const { data } = await api.GET("/api/ai/moderation/reports", {
        params: { query: { status, limit: PAGE_SIZE, offset: page * PAGE_SIZE } },
      });
      return {
        reports: (data?.reports ?? []) as AiReportSummary[],
        total: data?.total ?? 0,
        pageSize: PAGE_SIZE,
      };
    },
  });
}

export function useAiReport(reportId: string) {
  return useQuery({
    queryKey: aiReportKey(reportId),
    queryFn: async () => {
      const { data } = await api.GET("/api/ai/moderation/reports/{reportId}", {
        params: { path: { reportId } },
      });
      if (!data) throw new Error("AI content report not found.");
      return data as AiReport;
    },
  });
}

export interface ReviewAiReportInput {
  status: Exclude<AiReportStatus, "pending">;
  resolution_note?: string;
}

export function useReviewAiReport(reportId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: ReviewAiReportInput) => {
      const { data } = await api.PATCH("/api/ai/moderation/reports/{reportId}", {
        params: { path: { reportId } },
        body,
      });
      if (!data) throw new Error("Review returned no data.");
      return data as AiReport;
    },
    // Refetch either way: on a 409 another moderator moved the report first.
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

/** The reports' students by id, so the queue shows names rather than ids. Each student is one
 * small cached read; a page of reports rarely spans many students. */
export function useStudentNames(studentIds: readonly string[]) {
  const unique = [...new Set(studentIds)];
  return useQueries({
    queries: unique.map((studentId) => ({
      queryKey: studentQueryKey(studentId),
      queryFn: () => fetchStudent(studentId),
      staleTime: 5 * 60_000,
    })),
    combine: (results) => {
      const names = new Map<string, string>();
      results.forEach((result, index) => {
        if (result.data) {
          const student = result.data;
          names.set(
            unique[index]!,
            `${student.preferred_name ?? student.first_name} ${student.last_name}`,
          );
        }
      });
      return names;
    },
  });
}
