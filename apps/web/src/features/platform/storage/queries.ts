import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

export type PlatformStorage = components["schemas"]["PlatformStorageSubscription"];
export type PlatformStorageInvoice = NonNullable<PlatformStorage["billing"]>["invoices"][number];

const key = (schoolId: string) => ["platform-storage-subscription", schoolId];

/** A school's storage add-on, its Stripe invoices and the overcharges refunded automatically. */
export function usePlatformStorageQuery(schoolId: string) {
  return useQuery({
    queryKey: key(schoolId),
    retry: false,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/schools/{schoolId}/storage-subscription", {
        params: { path: { schoolId } },
      });
      if (!data) throw new Error("The storage subscription returned no data.");
      return data as PlatformStorage;
    },
  });
}

export interface StorageRefundInput {
  invoiceId: string;
  amountMinor: number;
  reason: string;
  /** One per confirmation, so a repeated request never refunds twice. */
  requestKey: string;
}

export function useRefundStorageInvoice(schoolId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: StorageRefundInput) => {
      const { data } = await api.POST(
        "/api/platform/schools/{schoolId}/storage-subscription/invoices/{invoiceId}/refund",
        {
          params: { path: { schoolId, invoiceId: input.invoiceId } },
          body: {
            amountMinor: input.amountMinor,
            reason: input.reason,
            requestKey: input.requestKey,
          },
        },
      );
      if (!data) throw new Error("The refund returned no data.");
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(schoolId) }),
  });
}
