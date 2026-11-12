import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../../lib/api";

import type { components } from "@studafy/api-client";

type Schemas = components["schemas"];
export type AcademicTranscript = Schemas["AcademicTranscript"];
export type TranscriptContent = Schemas["TranscriptContent"];
export type TranscriptReadiness = Schemas["TranscriptReadiness"];

/** Everything transcript-related for one student shares this prefix, so one write refreshes all. */
const transcriptKeys = {
  student: (studentId: string) => ["transcripts", "student", studentId] as const,
  readiness: (studentId: string) => ["transcripts", "student", studentId, "readiness"] as const,
  list: (studentId: string) => ["transcripts", "student", studentId, "list"] as const,
  one: (transcriptId: string) => ["transcripts", "one", transcriptId] as const,
};

/** The response body re-typed as its schema; an empty body is an error, never `undefined` data. */
function required<T>(data: unknown, what: string): T {
  if (data === undefined || data === null) throw new Error(`${what} returned no data.`);
  return data as T;
}

/** What issuing would cover now, the cumulative figures, and why it cannot happen if it cannot. */
export function useTranscriptReadiness(studentId: string, enabled: boolean) {
  return useQuery({
    queryKey: transcriptKeys.readiness(studentId),
    enabled,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/students/{studentId}/transcript-readiness", {
        params: { path: { studentId } },
      });
      return required<TranscriptReadiness>(data, "Transcript readiness");
    },
  });
}

export function useStudentTranscripts(studentId: string) {
  return useQuery({
    queryKey: transcriptKeys.list(studentId),
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/students/{studentId}/transcripts", {
        params: { path: { studentId } },
      });
      return required<{ transcripts: AcademicTranscript[] }>(data, "Transcripts").transcripts;
    },
  });
}

export function useTranscript(transcriptId: string | undefined) {
  return useQuery({
    queryKey: transcriptKeys.one(transcriptId ?? ""),
    enabled: transcriptId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/transcripts/{transcriptId}", {
        params: { path: { transcriptId: transcriptId! } },
      });
      return required<AcademicTranscript>(data, "Transcript");
    },
  });
}

function useTranscriptMutation<Input>(
  studentId: string,
  mutationFn: (input: Input) => Promise<AcademicTranscript>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async (transcript) => {
      await queryClient.invalidateQueries({ queryKey: transcriptKeys.student(studentId) });
      await queryClient.invalidateQueries({ queryKey: ["transcripts", "one"] });
      queryClient.setQueryData(transcriptKeys.one(transcript.id), transcript);
    },
  });
}

export function useIssueTranscript(studentId: string) {
  return useTranscriptMutation(studentId, async () => {
    const { data } = await api.POST("/api/grading/students/{studentId}/transcripts", {
      params: { path: { studentId } },
    });
    return required<AcademicTranscript>(data, "Transcript issue");
  });
}

export function useReissueTranscript(studentId: string) {
  return useTranscriptMutation(
    studentId,
    async ({ transcriptId, reason }: { transcriptId: string; reason: string }) => {
      const { data } = await api.POST("/api/grading/transcripts/{transcriptId}/reissue", {
        params: { path: { transcriptId } },
        body: { reason },
      });
      return required<AcademicTranscript>(data, "Transcript reissue");
    },
  );
}

export function useRevokeTranscript(studentId: string) {
  return useTranscriptMutation(
    studentId,
    async ({ transcriptId, reason }: { transcriptId: string; reason: string }) => {
      const { data } = await api.POST("/api/grading/transcripts/{transcriptId}/revoke", {
        params: { path: { transcriptId } },
        body: { reason },
      });
      return required<AcademicTranscript>(data, "Transcript revoke");
    },
  );
}
