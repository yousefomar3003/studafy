import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

type Schemas = components["schemas"];

export type GraduationSet = Schemas["GraduationRequirementSet"];
export type GraduationSetBody = Schemas["GraduationRequirementSetInput"];
export type GraduationRuleType = Schemas["GraduationRuleType"];
export type GraduationStatus = Schemas["GraduationStatus"];
export type GraduationSetEvaluation = Schemas["GraduationSetEvaluation"];
export type GraduationRuleEvaluation = Schemas["GraduationRuleEvaluation"];
export type GraduationChecklist = Schemas["GraduationChecklist"];
export type GraduationReport = Schemas["GraduationReport"];

/**
 * Graduation requirements: the school's requirement sets, managed in Academic setup (not tied to an
 * academic year), each student's checklist on the student page, and the grade-level report of
 * students not on track. Every write refreshes all of them: a checklist depends on the sets.
 */
export const GRADUATION_KEY = ["graduation-requirements"] as const;

const keys = {
  sets: [...GRADUATION_KEY, "sets"] as const,
  checklist: (studentId: string) => [...GRADUATION_KEY, "checklist", studentId] as const,
  preview: (setId: string, studentId: string) =>
    [...GRADUATION_KEY, "preview", setId, studentId] as const,
  report: (yearId: string, gradeLevelId: string) =>
    [...GRADUATION_KEY, "report", yearId, gradeLevelId] as const,
};

/** The response body re-typed as its schema (see `required` in queries.ts for why). */
function required<T>(data: unknown, what: string): T {
  if (data === undefined || data === null) throw new Error(`${what} returned no data.`);
  return data as T;
}

export function useGraduationSets(enabled = true) {
  return useQuery({
    queryKey: keys.sets,
    enabled,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/graduation-requirement-sets");
      return required<Schemas["GraduationRequirementSetList"]>(data, "Graduation requirements")
        .sets;
    },
  });
}

export function useStudentGraduationChecklist(studentId: string) {
  return useQuery({
    queryKey: keys.checklist(studentId),
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/students/{studentId}/graduation-requirements", {
        params: { path: { studentId } },
      });
      return required<GraduationChecklist>(data, "Graduation checklist");
    },
  });
}

export function useGraduationPreview(setId: string | undefined, studentId: string | undefined) {
  return useQuery({
    queryKey: keys.preview(setId ?? "", studentId ?? ""),
    enabled: setId !== undefined && studentId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/graduation-requirement-sets/{setId}/preview", {
        params: { path: { setId: setId! }, query: { student_id: studentId! } },
      });
      return required<Schemas["GraduationPreview"]>(data, "Graduation preview");
    },
  });
}

export function useGraduationReport(yearId: string | undefined, gradeLevelId: string | undefined) {
  return useQuery({
    queryKey: keys.report(yearId ?? "", gradeLevelId ?? ""),
    enabled: yearId !== undefined && gradeLevelId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/graduation-requirements/report", {
        params: { query: { academic_year_id: yearId!, grade_level_id: gradeLevelId! } },
      });
      return required<GraduationReport>(data, "Graduation report");
    },
  });
}

function useGraduationMutation<Input, Output>(mutationFn: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: GRADUATION_KEY }),
  });
}

export function useSaveGraduationSet() {
  return useGraduationMutation(
    async ({ setId, body }: { setId: string | null; body: GraduationSetBody }) => {
      if (setId) {
        const { data } = await api.PUT("/api/grading/graduation-requirement-sets/{setId}", {
          params: { path: { setId } },
          body,
        });
        return required<GraduationSet>(data, "Graduation requirement set");
      }
      const { data } = await api.POST("/api/grading/graduation-requirement-sets", { body });
      return required<GraduationSet>(data, "Graduation requirement set");
    },
  );
}

export function useDeleteGraduationSet() {
  return useGraduationMutation(async (setId: string) => {
    await api.DELETE("/api/grading/graduation-requirement-sets/{setId}", {
      params: { path: { setId } },
    });
  });
}
