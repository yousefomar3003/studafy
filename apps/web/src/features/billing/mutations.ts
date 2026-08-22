import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../lib/api";

import { BILLING_OVERVIEW_QUERY_KEY } from "./queries";

import type { SubscriptionCancellationState } from "./queries";

/** Opens the payment provider's own portal (payment method, tax details, past receipts) in a new
 * tab — Studafy never stores card details itself, so this is the only place to manage them. */
export function useOpenBillingPortal() {
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/subscriptions/portal", {
        body: { returnUrl: window.location.href },
      });
      if (!data) throw new Error("Billing portal session returned no data.");
      return data;
    },
  });
}

/** Checkout entry: creates a seat-based checkout session for the selected plan and returns the
 * provider's hosted checkout URL to redirect to. */
export function useStartSchoolCheckout() {
  return useMutation({
    mutationFn: async (planId: string) => {
      const returnPath = `${window.location.origin}/portal/billing`;
      const { data } = await api.POST("/api/subscriptions/school/checkout", {
        body: {
          planId,
          successUrl: `${returnPath}?checkout=success`,
          cancelUrl: `${returnPath}?checkout=cancelled`,
        },
      });
      if (!data) throw new Error("Checkout session returned no data.");
      return data;
    },
  });
}

export interface AiCheckoutInput {
  studentId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
}

/** Checkout entry for the per-student AI add-on (ST-208): creates a checkout session for one
 * student's AI price and returns the provider's hosted checkout URL to redirect to. Web-channel
 * only, same posture as `useStartSchoolCheckout` above — the mobile app that deep-links a parent
 * here cannot call `/api/subscriptions/ai/checkout` itself. */
export function useStartAiCheckout() {
  return useMutation({
    mutationFn: async (input: AiCheckoutInput) => {
      const { data } = await api.POST("/api/subscriptions/ai/checkout", { body: input });
      if (!data) throw new Error("Checkout session returned no data.");
      return data;
    },
  });
}

export interface CancelSubscriptionInput {
  reason?: string;
}

/** Schedules cancellation at the end of the current billing period; access continues until then. */
export function useCancelSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ reason }: CancelSubscriptionInput) => {
      const { data } = await api.POST("/api/subscriptions/current/cancel", {
        body: { reason: reason || undefined },
      });
      if (!data) throw new Error("Cancellation returned no data.");
      return data as SubscriptionCancellationState;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BILLING_OVERVIEW_QUERY_KEY });
    },
  });
}

/** Undoes a pending end-of-period cancellation. */
export function useReverseSubscriptionCancellation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/subscriptions/current/cancel/reverse");
      if (!data) throw new Error("Reversal returned no data.");
      return data as SubscriptionCancellationState;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BILLING_OVERVIEW_QUERY_KEY });
    },
  });
}
