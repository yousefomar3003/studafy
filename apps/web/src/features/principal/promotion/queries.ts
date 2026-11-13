import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";
import { SECTIONS_KEY_ROOT } from "../../admin/timetable/queries";
import { SECTION_STUDENTS_KEY_ROOT } from "../sections/queries";

import type { components } from "@studafy/api-client";

export type PromotionPreview = components["schemas"]["PromotionPreview"];
export type PromotionPreviewStudent = components["schemas"]["PromotionPreviewStudent"];
export type PromotionTargetSection = components["schemas"]["PromotionTargetSection"];
export type PromotionDecision = components["schemas"]["PromotionDecision"];
export type PromotionOutcome = components["schemas"]["PromotionOutcome"];

/** The apply endpoint takes at most this many decisions per request. */
export const PROMOTION_BATCH_SIZE = 100;

const PREVIEW_KEY = ["promotion", "preview"] as const;

export function usePromotionPreview(
  sourceYearId: string | undefined,
  targetYearId: string | undefined,
) {
  return useQuery({
    queryKey: [...PREVIEW_KEY, sourceYearId, targetYearId],
    enabled: Boolean(sourceYearId && targetYearId && sourceYearId !== targetYearId),
    queryFn: async () => {
      const { data } = await api.GET("/api/academics/promotions/preview", {
        params: { query: { source_year_id: sourceYearId!, target_year_id: targetYearId! } },
      });
      return data as PromotionPreview;
    },
  });
}

/**
 * Applies the decisions in batches of {@link PROMOTION_BATCH_SIZE}, one request after another, and
 * returns every outcome. A failed request stops the run; the batches before it are kept (the server
 * applies each student on its own, and re-running is safe).
 */
export function useApplyPromotion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      sourceYearId: string;
      targetYearId: string;
      decisions: PromotionDecision[];
    }) => {
      const outcomes: PromotionOutcome[] = [];
      for (let start = 0; start < input.decisions.length; start += PROMOTION_BATCH_SIZE) {
        const { data } = await api.POST("/api/academics/promotions/apply", {
          body: {
            source_year_id: input.sourceYearId,
            target_year_id: input.targetYearId,
            decisions: input.decisions.slice(start, start + PROMOTION_BATCH_SIZE),
          },
        });
        outcomes.push(...((data?.outcomes ?? []) as PromotionOutcome[]));
      }
      return outcomes;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PREVIEW_KEY });
      void queryClient.invalidateQueries({ queryKey: SECTION_STUDENTS_KEY_ROOT });
      void queryClient.invalidateQueries({ queryKey: SECTIONS_KEY_ROOT });
    },
  });
}
