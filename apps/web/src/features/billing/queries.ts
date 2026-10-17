import { useQuery } from "@tanstack/react-query";

import { api } from "../../lib/api";

import type { components } from "@studafy/api-client";

export type BillingOverview = components["schemas"]["BillingOverview"];

// ---------------------------------------------------------------------------
// Overview — the school's subscription row, read by the admin dashboard's `StorageUsageTile` for
// storage used against the plan's cap. Schools no longer pay for a plan (migration 000126), so
// nothing on the web shows the plan itself.
// ---------------------------------------------------------------------------

export const BILLING_OVERVIEW_QUERY_KEY = ["billing-overview"];

/**
 * No realtime event is routed for billing or storage changes yet (see
 * apps/realtime/src/event-routing.ts — only grades.published is routed today), so the storage
 * tile polls instead, same fallback NotificationBell uses for its unread count.
 */
const BILLING_OVERVIEW_POLL_MS = 60_000;

/** The admin dashboard's `StorageUsageTile` reads storage usage from here. */
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

// ---------------------------------------------------------------------------
// AI add-on purchase -- what the signed-in user can buy: the add-on's price and the students (self
// or linked children) it can be bought for, each with whether it is already active.
// ---------------------------------------------------------------------------

export type AiOffer = components["schemas"]["AiAddOnOffer"];

export const AI_OFFER_QUERY_KEY = ["ai-offer"];

export async function fetchAiOffer(): Promise<AiOffer> {
  const { data } = await api.GET("/api/subscriptions/ai/offer");
  if (!data) throw new Error("The AI offer returned no data.");
  // The generated response type drops `students`' Array prototype -- the same pre-existing
  // `@studafy/api-client` typing gap other list responses cast around; the shape is unchanged.
  return data as AiOffer;
}
