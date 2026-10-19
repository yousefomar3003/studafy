import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../lib/api";

import { AI_REFUND_REQUESTS_QUERY_KEY } from "./queries";

import type { SubscriptionRefundReason, SubscriptionRefundRequest } from "./queries";

export interface AiCheckoutInput {
  studentId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
}

/** Checkout entry for the per-student AI add-on (ST-208): creates a checkout session for one
 * student's AI price and returns the provider's hosted checkout URL to redirect to. Web-channel
 * only — the mobile app sells the add-on through the store's own billing instead and cannot call
 * `/api/subscriptions/ai/checkout` itself. */
export function useStartAiCheckout() {
  return useMutation({
    mutationFn: async (input: AiCheckoutInput) => {
      const { data } = await api.POST("/api/subscriptions/ai/checkout", { body: input });
      if (!data) throw new Error("Checkout session returned no data.");
      return data;
    },
  });
}

export interface CreateAiRefundRequestInput {
  studentId: string;
  reason: SubscriptionRefundReason;
  details?: string;
}

/** Files a refund request for an AI add-on, for Studafy staff to review. Nothing is refunded until
 * they approve it. */
export function useCreateAiRefundRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ studentId, reason, details }: CreateAiRefundRequestInput) => {
      const { data } = await api.POST("/api/subscriptions/ai/refund-requests", {
        body: { studentId, reason, details: details || undefined },
      });
      if (!data) throw new Error("Refund request returned no data.");
      return data as SubscriptionRefundRequest;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: AI_REFUND_REQUESTS_QUERY_KEY });
    },
  });
}
