import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

type Schemas = components["schemas"];

export type ExternalExam = Schemas["ExternalExam"];
export type ExternalExamComponent = Schemas["ExternalExamComponent"];
export type ExternalExamBody = Schemas["ExternalExamBody"];
export type ExternalExamPreset = Schemas["ExternalExamPreset"];
export type ExternalExamPresetKey = Schemas["ExternalExamPresetKey"];
export type ExternalExamResult = Schemas["ExternalExamResult"];
export type RecordExternalExamResultBody = Schemas["RecordExternalExamResultBody"];
export type UpdateExternalExamResultBody = Schemas["UpdateExternalExamResultBody"];

/**
 * External exams and test scores (SAT, IELTS, IGCSE finals...): the school's catalogue, managed in
 * Academic setup, and each student's results, recorded on the student's page. The catalogue is not
 * tied to an academic year. Every write refreshes both: recording a result locks how its exam is
 * scored (`has_scores`), and editing an exam renames what results show.
 */
export const EXTERNAL_EXAMS_KEY = ["external-exams"] as const;

const keys = {
  presets: [...EXTERNAL_EXAMS_KEY, "presets"] as const,
  catalogue: (includeArchived: boolean) =>
    [...EXTERNAL_EXAMS_KEY, "catalogue", includeArchived] as const,
  results: (studentId: string) => [...EXTERNAL_EXAMS_KEY, "results", studentId] as const,
};

/** The response body re-typed as its schema (see `required` in queries.ts for why). */
function required<T>(data: unknown, what: string): T {
  if (data === undefined || data === null) throw new Error(`${what} returned no data.`);
  return data as T;
}

export function useExternalExamPresets(enabled = true) {
  return useQuery({
    queryKey: keys.presets,
    enabled,
    staleTime: Infinity,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/external-exam-presets");
      return required<Schemas["ExternalExamPresetList"]>(data, "External exam presets").presets;
    },
  });
}

export function useExternalExams(includeArchived: boolean, enabled = true) {
  return useQuery({
    queryKey: keys.catalogue(includeArchived),
    enabled,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/external-exams", {
        params: { query: { include_archived: includeArchived ? "true" : "false" } },
      });
      return required<Schemas["ExternalExamList"]>(data, "External exams").exams;
    },
  });
}

export function useStudentExternalExamResults(studentId: string) {
  return useQuery({
    queryKey: keys.results(studentId),
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/students/{studentId}/external-exam-results", {
        params: { path: { studentId } },
      });
      return required<Schemas["ExternalExamResultList"]>(data, "External exam results").results;
    },
  });
}

function useExternalExamMutation<Input, Output>(mutationFn: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: EXTERNAL_EXAMS_KEY }),
  });
}

export function useAddExternalExamFromPreset() {
  return useExternalExamMutation(async (body: Schemas["ExternalExamFromPresetBody"]) => {
    const { data } = await api.POST("/api/grading/external-exams/from-preset", { body });
    return required<ExternalExam>(data, "External exam");
  });
}

export function useSaveExternalExam() {
  return useExternalExamMutation(
    async ({ examId, body }: { examId: string | null; body: ExternalExamBody }) => {
      if (examId) {
        const { data } = await api.PUT("/api/grading/external-exams/{examId}", {
          params: { path: { examId } },
          body,
        });
        return required<ExternalExam>(data, "External exam");
      }
      const { data } = await api.POST("/api/grading/external-exams", { body });
      return required<ExternalExam>(data, "External exam");
    },
  );
}

export function useSetExternalExamArchived() {
  return useExternalExamMutation(
    async ({ examId, archived }: { examId: string; archived: boolean }) => {
      const path = archived
        ? "/api/grading/external-exams/{examId}/archive"
        : "/api/grading/external-exams/{examId}/restore";
      const { data } = await api.POST(path, { params: { path: { examId } } });
      return required<ExternalExam>(data, "External exam");
    },
  );
}

export function useSaveExternalExamResult(studentId: string) {
  return useExternalExamMutation(
    async (
      input:
        | { resultId: null; body: RecordExternalExamResultBody }
        | { resultId: string; body: UpdateExternalExamResultBody },
    ) => {
      if (input.resultId) {
        const { data } = await api.PUT("/api/grading/external-exam-results/{resultId}", {
          params: { path: { resultId: input.resultId } },
          body: input.body,
        });
        return required<ExternalExamResult>(data, "External exam result");
      }
      const { data } = await api.POST("/api/grading/students/{studentId}/external-exam-results", {
        params: { path: { studentId } },
        body: input.body as RecordExternalExamResultBody,
      });
      return required<ExternalExamResult>(data, "External exam result");
    },
  );
}

export function useDeleteExternalExamResult() {
  return useExternalExamMutation(async (resultId: string) => {
    await api.DELETE("/api/grading/external-exam-results/{resultId}", {
      params: { path: { resultId } },
    });
  });
}
