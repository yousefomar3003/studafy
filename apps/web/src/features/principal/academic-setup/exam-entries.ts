import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import { EXTERNAL_EXAMS_KEY } from "./external-exams";

import type { components } from "@studafy/api-client";

type Schemas = components["schemas"];

export type ExamSession = Schemas["ExamSession"];
export type ExamEntry = Schemas["ExamEntry"];
export type ExamEntryStatus = Schemas["ExamEntryStatus"];
export type ExamSessionEntries = Schemas["ExamSessionEntries"];
export type ExamEntrySubjectBody = Schemas["ExamEntrySubjectBody"];
export type BulkCreateExamEntriesBody = Schemas["BulkCreateExamEntriesBody"];
export type BulkCreateExamEntriesResult = Schemas["BulkCreateExamEntriesResult"];
export type StudentExamEntry = Schemas["StudentExamEntry"];

/**
 * Exam entries: sessions of the school's external exams ("IGCSE May/June 2027") and the students
 * entered for them, managed in Academic setup. Every write refreshes the external exam queries too:
 * a student's results can link to their entry, and an entry counts the results recorded from it.
 */
export const EXAM_ENTRIES_KEY = [...EXTERNAL_EXAMS_KEY, "entries"] as const;

const keys = {
  sessions: [...EXAM_ENTRIES_KEY, "sessions"] as const,
  session: (sessionId: string) => [...EXAM_ENTRIES_KEY, "session", sessionId] as const,
  student: (studentId: string) => [...EXAM_ENTRIES_KEY, "student", studentId] as const,
};

/** The response body re-typed as its schema (see `required` in queries.ts for why). */
function required<T>(data: unknown, what: string): T {
  if (data === undefined || data === null) throw new Error(`${what} returned no data.`);
  return data as T;
}

export function useExamSessions(enabled = true) {
  return useQuery({
    queryKey: keys.sessions,
    enabled,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/external-exam-sessions");
      return required<Schemas["ExamSessionList"]>(data, "Exam sessions").sessions;
    },
  });
}

export function useExamSessionEntries(sessionId: string) {
  return useQuery({
    queryKey: keys.session(sessionId),
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/external-exam-sessions/{sessionId}/entries", {
        params: { path: { sessionId } },
      });
      return required<ExamSessionEntries>(data, "Exam entries");
    },
  });
}

export function useStudentExamEntries(studentId: string, enabled = true) {
  return useQuery({
    queryKey: keys.student(studentId),
    enabled,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/students/{studentId}/external-exam-entries", {
        params: { path: { studentId } },
      });
      return required<Schemas["StudentExamEntryList"]>(data, "Exam entries").entries;
    },
  });
}

/** The board's entry list, fetched with the session's token (a plain link could not carry it). */
export async function fetchExamEntriesCsv(sessionId: string, includeDrafts: boolean) {
  const { data } = await api.GET("/api/grading/external-exam-sessions/{sessionId}/entries/export", {
    params: { path: { sessionId }, query: { include_drafts: includeDrafts ? "true" : "false" } },
    parseAs: "blob",
  });
  if (!data) throw new Error("Export unavailable");
  return data as unknown as Blob;
}

function useEntriesMutation<Input, Output>(mutationFn: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: EXTERNAL_EXAMS_KEY }),
  });
}

export function useSaveExamSession() {
  return useEntriesMutation(
    async (
      input:
        | { sessionId: null; body: Schemas["CreateExamSessionBody"] }
        | { sessionId: string; body: Schemas["UpdateExamSessionBody"] },
    ) => {
      if (input.sessionId) {
        const { data } = await api.PUT("/api/grading/external-exam-sessions/{sessionId}", {
          params: { path: { sessionId: input.sessionId } },
          body: input.body,
        });
        return required<ExamSession>(data, "Exam session");
      }
      const { data } = await api.POST("/api/grading/external-exam-sessions", {
        body: input.body as Schemas["CreateExamSessionBody"],
      });
      return required<ExamSession>(data, "Exam session");
    },
  );
}

export function useDeleteExamSession() {
  return useEntriesMutation(async (sessionId: string) => {
    await api.DELETE("/api/grading/external-exam-sessions/{sessionId}", {
      params: { path: { sessionId } },
    });
  });
}

export function useCreateExamEntries(sessionId: string) {
  return useEntriesMutation(async (body: BulkCreateExamEntriesBody) => {
    const { data } = await api.POST("/api/grading/external-exam-sessions/{sessionId}/entries", {
      params: { path: { sessionId } },
      body,
    });
    return required<BulkCreateExamEntriesResult>(data, "Exam entries");
  });
}

export function useChangeExamEntryStatus(sessionId: string) {
  return useEntriesMutation(async (body: { entry_ids: string[]; status: ExamEntryStatus }) => {
    const { data } = await api.POST(
      "/api/grading/external-exam-sessions/{sessionId}/entries/status",
      { params: { path: { sessionId } }, body },
    );
    return required<Schemas["ChangeExamEntryStatusResult"]>(data, "Exam entries").updated;
  });
}

export function useAssignCandidateNumbers(sessionId: string) {
  return useEntriesMutation(async (body: Schemas["AssignCandidateNumbersBody"]) => {
    const { data } = await api.POST(
      "/api/grading/external-exam-sessions/{sessionId}/candidate-numbers",
      { params: { path: { sessionId } }, body },
    );
    return required<Schemas["AssignCandidateNumbersResult"]>(data, "Candidate numbers").assigned;
  });
}

export function useUpdateExamEntry() {
  return useEntriesMutation(
    async ({ entryId, body }: { entryId: string; body: Schemas["UpdateExamEntryBody"] }) => {
      const { data } = await api.PUT("/api/grading/external-exam-entries/{entryId}", {
        params: { path: { entryId } },
        body,
      });
      return required<ExamEntry>(data, "Exam entry");
    },
  );
}

export function useDeleteExamEntry() {
  return useEntriesMutation(async (entryId: string) => {
    await api.DELETE("/api/grading/external-exam-entries/{entryId}", {
      params: { path: { entryId } },
    });
  });
}
