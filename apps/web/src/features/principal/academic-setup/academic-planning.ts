import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

type Schemas = components["schemas"];

export type PlanningSettings = Schemas["PlanningSettings"];
export type PlanningSettingsBody = Schemas["PlanningSettingsBody"];
export type LearningOutcome = Schemas["LearningOutcome"];
export type LearningOutcomeBody = Schemas["LearningOutcomeBody"];
export type LearningOutcomeUpdateBody = Schemas["LearningOutcomeUpdateBody"];
export type LearningOutcomeImportResult = Schemas["LearningOutcomeImportResult"];
export type PlanStatus = Schemas["AcademicPlanStatus"];
export type PlanReviews = Schemas["AcademicPlanReviews"];
export type PlanCoverage = Schemas["PlanCoverage"];
export type TermPlan = Schemas["TermPlan"];
export type LessonPlan = Schemas["LessonPlan"];
export type ReviewDecision = Schemas["AcademicPlanReviewDecision"];

/**
 * Learning outcomes and lesson and term plans (000267). Leadership manages the catalogue, the
 * achievement scale and plan due dates here, reviews submitted plans and reads coverage; teachers
 * write plans and record achievement in the mobile app.
 */
export const PLANNING_KEY = ["academic-planning"] as const;

/** The response body re-typed as its schema (see `required` in queries.ts for why). */
function required<T>(data: unknown, what: string): T {
  if (data === undefined || data === null) throw new Error(`${what} returned no data.`);
  return data as T;
}

function useInvalidatingMutation<Input, Output>(mutationFn: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PLANNING_KEY }),
  });
}

// ---------------------------------------------------------------------------
// Settings and catalogue
// ---------------------------------------------------------------------------

export function usePlanningSettings() {
  return useQuery({
    queryKey: [...PLANNING_KEY, "settings"],
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/planning-settings");
      return required<PlanningSettings>(data, "Planning settings");
    },
  });
}

export function useUpdatePlanningSettings() {
  return useInvalidatingMutation(async (body: PlanningSettingsBody) => {
    const { data } = await api.PUT("/api/grading/planning-settings", { body });
    return required<PlanningSettings>(data, "Planning settings");
  });
}

export function useLearningOutcomes(filter: { subjectId?: string; gradeLevelId?: string }) {
  return useQuery({
    queryKey: [...PLANNING_KEY, "outcomes", filter.subjectId, filter.gradeLevelId],
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/learning-outcomes", {
        params: {
          query: {
            subject_id: filter.subjectId,
            grade_level_id: filter.gradeLevelId,
            include_archived: "true",
          },
        },
      });
      return required<Schemas["LearningOutcomeList"]>(data, "Learning outcomes").outcomes;
    },
  });
}

export function useCreateLearningOutcome() {
  return useInvalidatingMutation(async (body: LearningOutcomeBody) => {
    const { data } = await api.POST("/api/grading/learning-outcomes", { body });
    return required<LearningOutcome>(data, "Learning outcome");
  });
}

export function useUpdateLearningOutcome() {
  return useInvalidatingMutation(
    async ({ outcomeId, body }: { outcomeId: string; body: LearningOutcomeUpdateBody }) => {
      const { data } = await api.PATCH("/api/grading/learning-outcomes/{outcomeId}", {
        params: { path: { outcomeId } },
        body,
      });
      return required<LearningOutcome>(data, "Learning outcome");
    },
  );
}

export function useDeleteLearningOutcome() {
  return useInvalidatingMutation(async (outcomeId: string) => {
    await api.DELETE("/api/grading/learning-outcomes/{outcomeId}", {
      params: { path: { outcomeId } },
    });
  });
}

export function useImportLearningOutcomes() {
  return useInvalidatingMutation(async (body: { csv: string; dry_run: boolean }) => {
    const { data } = await api.POST("/api/grading/learning-outcomes/import", { body });
    return required<LearningOutcomeImportResult>(data, "Outcome import");
  });
}

// ---------------------------------------------------------------------------
// Plans: coverage and review
// ---------------------------------------------------------------------------

export function usePlanCoverage(termId: string | undefined) {
  return useQuery({
    queryKey: [...PLANNING_KEY, "coverage", termId],
    enabled: termId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/plan-coverage", {
        params: { query: { term_id: termId! } },
      });
      return required<PlanCoverage>(data, "Plan coverage");
    },
  });
}

export function usePlanReviews(yearId: string, status: PlanStatus) {
  return useQuery({
    queryKey: [...PLANNING_KEY, "reviews", yearId, status],
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/plan-reviews", {
        params: { query: { academic_year_id: yearId, status } },
      });
      return required<PlanReviews>(data, "Plan reviews");
    },
  });
}

export type PlanKind = "term" | "lesson";

export function usePlanDetail(kind: PlanKind, planId: string) {
  return useQuery({
    queryKey: [...PLANNING_KEY, "plan", kind, planId],
    queryFn: async () => {
      if (kind === "term") {
        const { data } = await api.GET("/api/grading/term-plans/{planId}", {
          params: { path: { planId } },
        });
        return { kind, plan: required<TermPlan>(data, "Term plan") } as const;
      }
      const { data } = await api.GET("/api/grading/lesson-plans/{planId}", {
        params: { path: { planId } },
      });
      return { kind, plan: required<LessonPlan>(data, "Lesson plan") } as const;
    },
  });
}

export function useReviewPlan() {
  return useInvalidatingMutation(
    async ({
      kind,
      planId,
      decision,
      comment,
    }: {
      kind: PlanKind;
      planId: string;
      decision: ReviewDecision;
      comment: string | null;
    }) => {
      const init = { params: { path: { planId } }, body: { decision, comment } };
      if (kind === "term") {
        await api.POST("/api/grading/term-plans/{planId}/review", init);
      } else {
        await api.POST("/api/grading/lesson-plans/{planId}/review", init);
      }
    },
  );
}
