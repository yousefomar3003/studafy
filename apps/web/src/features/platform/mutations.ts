import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../lib/api";

import {
  PLATFORM_KEY,
  PLATFORM_PLANS_KEY,
  PLATFORM_REFUNDS_KEY,
  PLATFORM_SETTINGS_KEY,
  schoolDetailKey,
} from "./queries";

import type {
  PlatformFeatureFlagState,
  PlatformInquiry,
  PlatformInquiryStatus,
  PlatformRefundRequest,
  PlatformSchoolDetail,
  PlatformSchoolStatus,
  PlatformSetting,
} from "./queries";
import type { components } from "@studafy/api-client";

type UpdatePlanBody = components["schemas"]["UpdatePlatformPlan"];
type StatusChangeResult = components["schemas"]["UpdatePlatformSchoolStatusResult"];

/**
 * `PATCH /api/platform/schools/{schoolId}/status`. The response carries the fresh school record,
 * written straight into the detail cache; every list and the overview are invalidated because a
 * status change moves the school between their buckets.
 */
export function useChangeSchoolStatus(schoolId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { status: PlatformSchoolStatus; reason: string }) => {
      const { data } = await api.PATCH("/api/platform/schools/{schoolId}/status", {
        params: { path: { schoolId } },
        body,
      });
      if (!data) throw new Error("Status change returned no data.");
      return data as StatusChangeResult;
    },
    onSuccess: (result) => {
      queryClient.setQueryData(schoolDetailKey(schoolId), result.school);
      void queryClient.invalidateQueries({ queryKey: PLATFORM_KEY });
    },
  });
}

export function useSetFeatureFlag(schoolId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      flag: PlatformFeatureFlagState["name"];
      enabled: boolean | null;
    }) => {
      const { data } = await api.PUT("/api/platform/schools/{schoolId}/feature-flags/{flagName}", {
        params: { path: { schoolId, flagName: input.flag } },
        body: { enabled: input.enabled },
      });
      if (!data) throw new Error("Feature flag update returned no data.");
      return data as PlatformSchoolDetail;
    },
    onSuccess: (school) => {
      queryClient.setQueryData(schoolDetailKey(schoolId), school);
    },
  });
}

export function useUpdatePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ planId, patch }: { planId: string; patch: UpdatePlanBody }) => {
      const { data } = await api.PATCH("/api/platform/plans/{planId}", {
        params: { path: { planId } },
        body: patch,
      });
      if (!data) throw new Error("Plan update returned no data.");
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PLATFORM_PLANS_KEY }),
  });
}

export function useUpdatePlanPrice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { planId: string; priceId: string; isActive: boolean }) => {
      const { data } = await api.PATCH("/api/platform/plans/{planId}/prices/{priceId}", {
        params: { path: { planId: input.planId, priceId: input.priceId } },
        body: { isActive: input.isActive },
      });
      if (!data) throw new Error("Price update returned no data.");
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PLATFORM_PLANS_KEY }),
  });
}

/** `POST /api/admin/subscriptions/sync-prices` — publishes local plans/prices to Stripe. */
export function useSyncPlanPrices() {
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/admin/subscriptions/sync-prices");
      if (!data) throw new Error("Price sync returned no data.");
      return data;
    },
  });
}

export function useUpdatePlatformSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: PlatformSetting["value"] }) => {
      const { data } = await api.PATCH("/api/platform/settings/{key}", {
        params: { path: { key } },
        body: { value },
      });
      if (!data) throw new Error("Setting update returned no data.");
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PLATFORM_SETTINGS_KEY }),
  });
}

/** `PATCH /api/platform/inquiries/{inquiryId}` — move an inquiry along the pipeline, edit notes. */
export function useUpdateInquiry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      inquiryId: string;
      status?: PlatformInquiryStatus;
      internalNotes?: string | null;
    }) => {
      const { inquiryId, ...body } = input;
      const { data } = await api.PATCH("/api/platform/inquiries/{inquiryId}", {
        params: { path: { inquiryId } },
        body,
      });
      if (!data) throw new Error("Inquiry update returned no data.");
      return data as PlatformInquiry;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [...PLATFORM_KEY, "inquiries"] }),
  });
}

type RefundApproval = components["schemas"]["PlatformRefundApproval"];

/**
 * `POST /api/platform/refund-requests/{schoolId}/{requestId}/approve` — issues the refund. Every
 * refund query is invalidated: the request moves between status tabs, and a failure is recorded on
 * the row even though the call itself errors.
 */
export function useApproveRefund() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      schoolId: string;
      requestId: string;
      amountMinor?: number;
      paymentReference?: string;
      cancelSubscription?: boolean;
      note?: string;
    }) => {
      const { schoolId, requestId, ...body } = input;
      const { data } = await api.POST(
        "/api/platform/refund-requests/{schoolId}/{requestId}/approve",
        { params: { path: { schoolId, requestId } }, body },
      );
      if (!data) throw new Error("Refund approval returned no data.");
      return data as RefundApproval;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: PLATFORM_REFUNDS_KEY }),
  });
}

/** `POST /api/platform/refund-requests/{schoolId}/{requestId}/reject` — the note is required. */
export function useRejectRefund() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { schoolId: string; requestId: string; note: string }) => {
      const { schoolId, requestId, note } = input;
      const { data } = await api.POST(
        "/api/platform/refund-requests/{schoolId}/{requestId}/reject",
        { params: { path: { schoolId, requestId } }, body: { note } },
      );
      if (!data) throw new Error("Refund rejection returned no data.");
      return data as PlatformRefundRequest;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: PLATFORM_REFUNDS_KEY }),
  });
}
