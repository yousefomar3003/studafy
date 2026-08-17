import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

export type ApprovalQueueItem = components["schemas"]["ApprovalQueueItem"];
export type PendingItemType = ApprovalQueueItem["item_type"];
export type GradeSubmissionDiff = components["schemas"]["GradeSubmissionDiff"];
export type TimetableVersionDiff = components["schemas"]["TimetableVersionDiff"];
export type BulkDecisionEntry = components["schemas"]["BulkDecisionEntry"];
export type DecisionResult = components["schemas"]["DecisionResult"];
export type BulkDecisionResult = components["schemas"]["BulkDecisionResult"];

/**
 * Query-key prefix for the queue list. The badge (`ApprovalQueueBadge.tsx`) and the principal
 * dashboard's tile (`tiles/PendingApprovalsTile.tsx`) key their own count queries under the bare
 * `["approval-queue"]` prefix, which is what both the realtime `grades.published` invalidation and
 * `useDecideApprovals` (`mutations.ts`) target — invalidating that prefix refetches this list too.
 */
export const APPROVAL_QUEUE_KEY = ["approval-queue", "list"] as const;

/** List of items currently awaiting approval, across both pending-item types. */
export async function fetchApprovalQueue(): Promise<{
  items: ApprovalQueueItem[];
  total: number;
}> {
  const { data } = await api.GET("/api/approvals/queue");
  // `readonly ApprovalQueueItem[]` loses its array prototype through the generated response type
  // here — the same pre-existing `@studafy/api-client` typing gap `NotificationBell.tsx` documents
  // for `notifications`. The annotation restores it without widening to `any`.
  return {
    items: (data?.items ?? []) as ApprovalQueueItem[],
    total: data?.total ?? 0,
  };
}
