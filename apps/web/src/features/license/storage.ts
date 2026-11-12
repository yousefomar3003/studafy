import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../lib/api";
import { BILLING_OVERVIEW_QUERY_KEY } from "../billing/queries";

import type { components } from "@studafy/api-client";

/**
 * The school's paid storage add-on (`/portal/license/storage`): what it can buy, and buying,
 * changing and canceling it. Every write refreshes the offer and the admin dashboard's storage tile,
 * which reads the same cap.
 */

type Schemas = components["schemas"];
export type StorageOffer = Schemas["StorageAddOnOffer"];
export type StorageTier = Schemas["StorageAddOnTier"];
// Registered once and reused nullable by `current.price`, so the component itself reads as nullable.
export type StoragePrice = NonNullable<Schemas["StorageAddOnPrice"]>;
export type StorageCurrent = Schemas["StorageAddOnCurrent"];
export type StorageInterval = StoragePrice["interval"];

export const STORAGE_OFFER_KEY = ["storage-addon-offer"];

function required<T>(data: T | undefined, what: string): T {
  if (data === undefined) throw new Error(`${what} returned no data.`);
  return data;
}

export function useStorageOfferQuery() {
  return useQuery({
    queryKey: STORAGE_OFFER_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/subscriptions/storage/offer");
      // The generated response type drops the arrays' prototype -- the same @studafy/api-client
      // typing gap other list responses cast around; the shape is unchanged.
      return required(data, "The storage offer") as StorageOffer;
    },
  });
}

function useStorageMutation<Input, Output>(mutationFn: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: STORAGE_OFFER_KEY }),
        queryClient.invalidateQueries({ queryKey: BILLING_OVERVIEW_QUERY_KEY }),
      ]);
    },
  });
}

/** Starts the payment provider's hosted checkout; the caller sends the browser to `url`. */
export function useStartStorageCheckout() {
  return useMutation({
    mutationFn: async (input: { priceId: string; successUrl: string; cancelUrl: string }) => {
      const { data } = await api.POST("/api/subscriptions/storage/checkout", { body: input });
      return required(data, "Storage checkout");
    },
  });
}

export function useChangeStorageTier() {
  return useStorageMutation(async (priceId: string) => {
    const { data } = await api.POST("/api/subscriptions/storage/change", {
      body: { priceId },
    });
    return required(data, "Storage change") as StorageCurrent;
  });
}

/** `true` stops the add-on renewing at the end of its period; `false` keeps it renewing. */
export function useSetStorageCancellation() {
  return useStorageMutation(async (cancel: boolean) => {
    const { data } = cancel
      ? await api.POST("/api/subscriptions/storage/cancel")
      : await api.POST("/api/subscriptions/storage/cancel/reverse");
    return required(data, "Storage cancellation");
  });
}
