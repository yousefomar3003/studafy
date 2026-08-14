import { useQuery } from "@tanstack/react-query";

import { api } from "../../lib/api";

export const BILLING_OVERVIEW_QUERY_KEY = ["billing-overview"];

/**
 * No realtime event is routed for billing or storage changes yet (see
 * apps/realtime/src/event-routing.ts — only grades.published is routed today), so the subscription
 * banner and storage tile poll instead, same fallback NotificationBell uses for its unread count.
 */
const BILLING_OVERVIEW_POLL_MS = 60_000;

/**
 * Shared by SubscriptionStatusBanner and StorageUsageTile — both read from the one billing
 * overview endpoint, so a single query key lets TanStack Query dedupe the request between them.
 */
export function useBillingOverviewQuery() {
  return useQuery({
    queryKey: BILLING_OVERVIEW_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/subscriptions/current");
      return data;
    },
    refetchInterval: BILLING_OVERVIEW_POLL_MS,
  });
}
