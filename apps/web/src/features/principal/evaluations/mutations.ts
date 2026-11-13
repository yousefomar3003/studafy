import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import { EVALUATION_KEY_ROOT, EVALUATION_TEMPLATES_KEY_ROOT } from "./queries";

import type { Evaluation, EvaluationCriteriaTemplate, EvaluationScore } from "./queries";
import type { components } from "@studafy/api-client";

export type CreateEvaluationInput = components["schemas"]["CreateEvaluationBody"];
export type UpdateEvaluationInput = components["schemas"]["UpdateEvaluationBody"];
export type CreateTemplateInput = components["schemas"]["CreateCriteriaTemplateBody"];
export type UpdateTemplateInput = components["schemas"]["UpdateCriteriaTemplateBody"];
export type UpsertScoreInput = components["schemas"]["UpsertScoreBody"];

export interface UpsertScoreParams {
  criteriaTemplateId: string;
  input: UpsertScoreInput;
}

/**
 * Every evaluation mutation below invalidates the whole `teacher-evaluations` prefix, the same
 * coarse choice `discipline/mutations.ts` makes: the dashboard tile, the evaluation list (however
 * it's currently filtered), a teacher's evaluation history, and this evaluation's own detail/scores
 * all key off this root, and a single edit can move all of them at once.
 */
function useInvalidateEvaluations() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: EVALUATION_KEY_ROOT });
}

function useInvalidateTemplates() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: EVALUATION_TEMPLATES_KEY_ROOT });
}

/** Starts a new evaluation cycle for a teacher, always in `draft` status. */
export function useCreateEvaluation() {
  const invalidate = useInvalidateEvaluations();

  return useMutation({
    mutationFn: async (input: CreateEvaluationInput): Promise<Evaluation> => {
      const { data } = await api.POST("/api/evaluations", { body: input });
      if (!data) throw new Error("Evaluation creation returned no data.");
      return data;
    },
    onSuccess: async () => {
      await invalidate();
    },
  });
}

/** Partial update to an evaluation's fields — the mutation the notes/narrative autosave and the
 * rating select both call (see `EvaluationDetailPage.tsx`). */
export function useUpdateEvaluation(evaluationId: string) {
  const invalidate = useInvalidateEvaluations();

  return useMutation({
    mutationFn: async (input: UpdateEvaluationInput): Promise<Evaluation> => {
      const { data } = await api.PATCH("/api/evaluations/{evaluationId}", {
        params: { path: { evaluationId } },
        body: input,
      });
      if (!data) throw new Error("Evaluation update returned no data.");
      return data;
    },
    onSuccess: async () => {
      await invalidate();
    },
  });
}

/** `draft → submitted` only; the server 409s on any other current status. */
export function useSubmitEvaluation(evaluationId: string) {
  const invalidate = useInvalidateEvaluations();

  return useMutation({
    mutationFn: async (): Promise<Evaluation> => {
      const { data } = await api.POST("/api/evaluations/{evaluationId}/submit", {
        params: { path: { evaluationId } },
      });
      if (!data) throw new Error("Evaluation submission returned no data.");
      return data;
    },
    onSuccess: async () => {
      await invalidate();
    },
  });
}

/** Marks the evaluation visible to its teacher. Backed by a RESTRICTIVE RLS policy on
 * `app.teacher_evaluations`, not just this flag — an unshared evaluation is unreadable by the
 * teacher's own account at the database level, not merely hidden by the UI. */
export function useShareEvaluation(evaluationId: string) {
  const invalidate = useInvalidateEvaluations();

  return useMutation({
    mutationFn: async (): Promise<Evaluation> => {
      const { data } = await api.POST("/api/evaluations/{evaluationId}/share", {
        params: { path: { evaluationId } },
      });
      if (!data) throw new Error("Evaluation share returned no data.");
      return data;
    },
    onSuccess: async () => {
      await invalidate();
    },
  });
}

/** Upserts one criteria score, keyed by `(evaluationId, criteriaTemplateId)`. Full-replace PUT
 * semantics, so an omitted `comment` clears it rather than leaving a stale value — the same
 * omit-means-empty convention `discipline/mutations.ts`'s `useCreateAction` uses. */
export function useUpsertScore(evaluationId: string) {
  const invalidate = useInvalidateEvaluations();

  return useMutation({
    mutationFn: async ({
      criteriaTemplateId,
      input,
    }: UpsertScoreParams): Promise<EvaluationScore> => {
      const { data } = await api.PUT(
        "/api/evaluations/{evaluationId}/scores/{criteriaTemplateId}",
        {
          params: { path: { evaluationId, criteriaTemplateId } },
          body: input,
        },
      );
      if (!data) throw new Error("Score upsert returned no data.");
      return data;
    },
    onSuccess: async () => {
      await invalidate();
    },
  });
}

export function useCreateTemplate() {
  const invalidate = useInvalidateTemplates();

  return useMutation({
    mutationFn: async (input: CreateTemplateInput): Promise<EvaluationCriteriaTemplate> => {
      const { data } = await api.POST("/api/evaluations/templates", { body: input });
      if (!data) throw new Error("Criteria template creation returned no data.");
      return data;
    },
    onSuccess: async () => {
      await invalidate();
    },
  });
}

/** Also the mutation `CriteriaTemplatesPage`'s "Reactivate" button uses, via `{ is_active: true }`. */
export function useUpdateTemplate(templateId: string) {
  const invalidate = useInvalidateTemplates();

  return useMutation({
    mutationFn: async (input: UpdateTemplateInput): Promise<EvaluationCriteriaTemplate> => {
      const { data } = await api.PATCH("/api/evaluations/templates/{templateId}", {
        params: { path: { templateId } },
        body: input,
      });
      if (!data) throw new Error("Criteria template update returned no data.");
      return data;
    },
    onSuccess: async () => {
      await invalidate();
    },
  });
}

/** Soft-delete (`is_active=false`) — past evaluations keep their recorded scores against this
 * template, it just stops being offered for new scoring. */
export function useDeactivateTemplate() {
  const invalidate = useInvalidateTemplates();

  return useMutation({
    mutationFn: async (templateId: string): Promise<void> => {
      await api.DELETE("/api/evaluations/templates/{templateId}", {
        params: { path: { templateId } },
      });
    },
    onSuccess: async () => {
      await invalidate();
    },
  });
}
