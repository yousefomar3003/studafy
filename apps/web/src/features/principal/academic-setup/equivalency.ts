import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

type Schemas = components["schemas"];

export type EquivalencyRuleSet = Schemas["EquivalencyRuleSet"];
export type EquivalencyRuleSetBody = Schemas["EquivalencyRuleSetInput"];
export type EquivalencyPart = Schemas["EquivalencyPart"];
export type EquivalencyPartType = Schemas["EquivalencyPartType"];
export type EquivalencySourceSystem = Schemas["EquivalencySourceSystem"];
export type EquivalencyStatus = Schemas["EquivalencyStatus"];
export type EquivalencyEstimate = Schemas["EquivalencyEstimate"];
export type EquivalencyIssue = Schemas["EquivalencyIssue"];
export type EquivalencyPartResult = Schemas["EquivalencyPartResult"];
export type EquivalencyStudentList = Schemas["EquivalencyStudentList"];
export type StudentEquivalency = Schemas["StudentEquivalency"];
export type MultiYearConfig = Schemas["MultiYearResultConfig"];
export type MultiYearConfigBody = Schemas["MultiYearResultConfigInput"];
export type MultiYearStatus = Schemas["MultiYearStatus"];
export type MultiYearYearStatus = Schemas["MultiYearYearStatus"];
export type StudentMultiYearResults = Schemas["StudentMultiYearResults"];

/**
 * Tawjihi equivalency (estimates under the school's own rules) and multi-year results: rule sets and
 * configurations managed in Academic setup (not tied to an academic year), a grade level's
 * estimates, and each student's estimate and multi-year result on the student page. Every write
 * refreshes all of them: a student's figures depend on the rules.
 */
export const EQUIVALENCY_KEY = ["academic-equivalency"] as const;

const keys = {
  sets: [...EQUIVALENCY_KEY, "sets"] as const,
  configs: [...EQUIVALENCY_KEY, "configs"] as const,
  student: (studentId: string) => [...EQUIVALENCY_KEY, "student", studentId] as const,
  multiYear: (studentId: string) => [...EQUIVALENCY_KEY, "multi-year", studentId] as const,
  list: (setId: string, yearId: string, gradeLevelId: string) =>
    [...EQUIVALENCY_KEY, "list", setId, yearId, gradeLevelId] as const,
};

/** The response body re-typed as its schema (see `required` in queries.ts for why). */
function required<T>(data: unknown, what: string): T {
  if (data === undefined || data === null) throw new Error(`${what} returned no data.`);
  return data as T;
}

export function useEquivalencyRuleSets(enabled = true) {
  return useQuery({
    queryKey: keys.sets,
    enabled,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/equivalency-rule-sets");
      return required<Schemas["EquivalencyRuleSetList"]>(data, "Equivalency rule sets").sets;
    },
  });
}

export function useEquivalencyStudentList(
  setId: string | undefined,
  yearId: string | undefined,
  gradeLevelId: string | undefined,
) {
  return useQuery({
    queryKey: keys.list(setId ?? "", yearId ?? "", gradeLevelId ?? ""),
    enabled: setId !== undefined && yearId !== undefined && gradeLevelId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/equivalency-rule-sets/{setId}/students", {
        params: {
          path: { setId: setId! },
          query: { academic_year_id: yearId!, grade_level_id: gradeLevelId! },
        },
      });
      return required<EquivalencyStudentList>(data, "Equivalency list");
    },
  });
}

export function useStudentEquivalency(studentId: string) {
  return useQuery({
    queryKey: keys.student(studentId),
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/students/{studentId}/equivalency", {
        params: { path: { studentId } },
      });
      return required<StudentEquivalency>(data, "Equivalency estimate");
    },
  });
}

export function useMultiYearConfigs(enabled = true) {
  return useQuery({
    queryKey: keys.configs,
    enabled,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/multi-year-result-configs");
      return required<Schemas["MultiYearResultConfigList"]>(data, "Multi-year results").configs;
    },
  });
}

export function useStudentMultiYearResults(studentId: string) {
  return useQuery({
    queryKey: keys.multiYear(studentId),
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/students/{studentId}/multi-year-results", {
        params: { path: { studentId } },
      });
      return required<StudentMultiYearResults>(data, "Multi-year results");
    },
  });
}

function useEquivalencyMutation<Input, Output>(mutationFn: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: EQUIVALENCY_KEY }),
  });
}

export function useSaveEquivalencyRuleSet() {
  return useEquivalencyMutation(
    async ({ setId, body }: { setId: string | null; body: EquivalencyRuleSetBody }) => {
      if (setId) {
        const { data } = await api.PUT("/api/grading/equivalency-rule-sets/{setId}", {
          params: { path: { setId } },
          body,
        });
        return required<EquivalencyRuleSet>(data, "Equivalency rule set");
      }
      const { data } = await api.POST("/api/grading/equivalency-rule-sets", { body });
      return required<EquivalencyRuleSet>(data, "Equivalency rule set");
    },
  );
}

export function useDeleteEquivalencyRuleSet() {
  return useEquivalencyMutation(async (setId: string) => {
    await api.DELETE("/api/grading/equivalency-rule-sets/{setId}", {
      params: { path: { setId } },
    });
  });
}

export function useSaveMultiYearConfig() {
  return useEquivalencyMutation(
    async ({ configId, body }: { configId: string | null; body: MultiYearConfigBody }) => {
      if (configId) {
        const { data } = await api.PUT("/api/grading/multi-year-result-configs/{configId}", {
          params: { path: { configId } },
          body,
        });
        return required<MultiYearConfig>(data, "Multi-year result");
      }
      const { data } = await api.POST("/api/grading/multi-year-result-configs", { body });
      return required<MultiYearConfig>(data, "Multi-year result");
    },
  );
}

export function useDeleteMultiYearConfig() {
  return useEquivalencyMutation(async (configId: string) => {
    await api.DELETE("/api/grading/multi-year-result-configs/{configId}", {
      params: { path: { configId } },
    });
  });
}
