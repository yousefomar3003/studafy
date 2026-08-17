import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { BulkDecisionEntry, BulkDecisionResult } from "./queries";

/**
 * Approves or rejects one or more pending items via `POST /api/approvals/bulk-decision` — the API
 * has no single-item decision endpoint, so a row action and the bulk toolbar both call this with a
 * one-element or many-element `entries` array. Each entry gets its own result; a failure on one
 * entry never throws for the whole call (see `bulkDecision` in
 * `apps/api/src/modules/grades/approval-queue-service.ts`), so callers read
 * `BulkDecisionResult.results` to find per-item failures rather than relying on `onError`.
 *
 * Decided items drop out of `listPendingApprovals`'s `WHERE status = 'submitted'/'pending'` clause
 * server-side, so invalidating the `["approval-queue"]` prefix (shared with the sidebar badge and
 * dashboard tile) is enough to empty the queue live on success — no optimistic patch needed.
 */
export function useDecideApprovals() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (entries: BulkDecisionEntry[]): Promise<BulkDecisionResult> => {
      const { data } = await api.POST("/api/approvals/bulk-decision", { body: { items: entries } });
      if (!data) throw new Error("Approval decision returned no data.");
      // `readonly DecisionResult[]` loses its array prototype through the generated response type
      // here — the same pre-existing `@studafy/api-client` typing gap `NotificationBell.tsx`
      // documents for `notifications`. The annotation restores it without widening to `any`.
      return data as BulkDecisionResult;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["approval-queue"] });
    },
  });
}
