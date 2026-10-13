import { useMutation } from "@tanstack/react-query";

import { api } from "../../lib/api";

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
