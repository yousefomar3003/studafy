import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../../lib/api";

import type { components } from "@studafy/api-client";

type Schemas = components["schemas"];
export type StudentPredictedGrades = Schemas["StudentPredictedGrades"];
export type PredictedGradesYear = Schemas["StudentPredictedGradesYear"];
export type StudentPredictedGrade = Schemas["StudentPredictedGrade"];

const predictedKey = (studentId: string) => ["predicted-grades", "student", studentId] as const;

/** A student's predicted grades by academic year (`GET /api/grading/students/{id}/predicted-grades`). */
export function useStudentPredictedGrades(studentId: string) {
  return useQuery({
    queryKey: predictedKey(studentId),
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/students/{studentId}/predicted-grades", {
        params: { path: { studentId } },
      });
      if (!data) throw new Error("Predicted grades returned no data.");
      return data as StudentPredictedGrades;
    },
  });
}

export interface PredictionInput {
  sectionId: string;
  subjectId: string;
  termId: string | null;
  /** null removes the prediction. */
  gradeLabel: string | null;
  note: string | null;
}

/**
 * Sets (or removes) one prediction through the section and subject's bulk route, the same one a
 * teacher saves from the app. The server checks the label against the subject's scale.
 */
export function useSavePrediction(studentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: PredictionInput) => {
      const { data } = await api.PUT(
        "/api/grading/sections/{sectionId}/subjects/{subjectId}/predicted-grades",
        {
          params: { path: { sectionId: input.sectionId, subjectId: input.subjectId } },
          body: {
            term_id: input.termId,
            grades: [{ student_id: studentId, grade_label: input.gradeLabel, note: input.note }],
          },
        },
      );
      if (!data) throw new Error("Saving the predicted grade returned no data.");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: predictedKey(studentId) }),
  });
}
