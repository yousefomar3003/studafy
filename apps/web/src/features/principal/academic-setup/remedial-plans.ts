import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

type Schemas = components["schemas"];

export type RemedialPlanList = Schemas["RemedialPlanList"];
export type RemedialPlanSummary = Schemas["RemedialPlanSummary"];
export type RemedialPlan = Schemas["RemedialPlan"];
export type RemedialPlanStatus = Schemas["RemedialPlanStatus"];

/**
 * Remedial plans (000268): teachers write them in the mobile app; leadership follows them up here
 * (the year's list by grade, subject, status and overdue review, a plan's timeline, follow-up
 * notes) and decides whether teachers may share plans with students and parents.
 */
export const REMEDIAL_PLANS_KEY = ["remedial-plans"] as const;
const SETTINGS_KEY = ["remedial-plan-settings"] as const;

export interface RemedialPlanFilters {
  gradeLevelId?: string;
  subjectId?: string;
  status?: RemedialPlanStatus;
  overdueOnly: boolean;
}

/** The response body re-typed as its schema (see `required` in queries.ts for why). */
function required<T>(data: unknown, what: string): T {
  if (data === undefined || data === null) throw new Error(`${what} returned no data.`);
  return data as T;
}

export function useRemedialPlans(yearId: string, filters: RemedialPlanFilters) {
  return useQuery({
    queryKey: [...REMEDIAL_PLANS_KEY, "list", yearId, filters],
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/remedial-plans", {
        params: {
          query: {
            academic_year_id: yearId,
            grade_level_id: filters.gradeLevelId,
            subject_id: filters.subjectId,
            status: filters.status,
            overdue: filters.overdueOnly ? "true" : undefined,
          },
        },
      });
      return required<RemedialPlanList>(data, "Remedial plans");
    },
  });
}

export function useRemedialPlan(planId: string | null) {
  return useQuery({
    queryKey: [...REMEDIAL_PLANS_KEY, "plan", planId],
    enabled: planId !== null,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/remedial-plans/{planId}", {
        params: { path: { planId: planId! } },
      });
      return required<RemedialPlan>(data, "Remedial plan");
    },
  });
}

export function useAddRemedialNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      planId,
      body,
      internal,
    }: {
      planId: string;
      body: string;
      internal: boolean;
    }) => {
      const { data } = await api.POST("/api/grading/remedial-plans/{planId}/notes", {
        params: { path: { planId } },
        body: { body, internal },
      });
      return required<RemedialPlan>(data, "Remedial plan");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: REMEDIAL_PLANS_KEY }),
  });
}

export function useRemedialSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/remedial-plan-settings");
      return required<Schemas["RemedialPlanSettings"]>(data, "Remedial plan settings");
    },
  });
}

export function useUpdateRemedialSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (familyVisible: boolean) => {
      const { data } = await api.PUT("/api/grading/remedial-plan-settings", {
        body: { family_visible: familyVisible },
      });
      return required<Schemas["RemedialPlanSettings"]>(data, "Remedial plan settings");
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(SETTINGS_KEY, settings);
      return queryClient.invalidateQueries({ queryKey: REMEDIAL_PLANS_KEY });
    },
  });
}
