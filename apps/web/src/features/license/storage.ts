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
export type StorageCurrent = NonNullable<Schemas["StorageAddOnCurrent"]>;
export type StorageInterval = StoragePrice["interval"];
export type StorageChangePreview = Schemas["StorageAddOnChangePreview"];
export type StorageBilling = NonNullable<Schemas["StorageAddOnBilling"]>;
export type StorageInvoice = Schemas["StorageAddOnInvoice"];
export type StorageCard = Schemas["StorageAddOnCard"];

export const STORAGE_OFFER_KEY = ["storage-addon-offer"];

function required<T>(data: T | undefined, what: string): T {
  if (data === undefined) throw new Error(`${what} returned no data.`);
  return data;
}

/** `poll`: refetch every few seconds, while a payment is being confirmed. */
export function useStorageOfferQuery(options: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: STORAGE_OFFER_KEY,
    refetchInterval: options.poll ? 3_000 : false,
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
        queryClient.invalidateQueries({ queryKey: ["storage-addon-billing"] }),
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

/**
 * The exact cost of switching to `priceId` (null: nothing to preview), computed by the payment
 * provider. Never cached: an amount shown is always one just computed. `attempt` forces a new one.
 */
export function useStorageChangePreview(priceId: string | null, attempt = 0) {
  return useQuery({
    queryKey: ["storage-change-preview", priceId, attempt],
    enabled: priceId !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data } = await api.POST("/api/subscriptions/storage/change/preview", {
        body: { priceId: priceId! },
      });
      return required(data, "Storage change preview") as StorageChangePreview;
    },
  });
}

/** A change for exactly the amount the school confirmed from a preview. */
export interface StorageChangeInput {
  priceId: string;
  prorationDate: string;
  expectedAmountMinor: number;
  /** One per confirmation, so a repeated request can never charge twice. */
  requestKey: string;
  /** The saved card to pay with; only this card is charged. */
  paymentMethodId?: string | null;
  /** Also make it the card renewals are charged to. */
  useForRenewals?: boolean;
}

export function useChangeStorageTier() {
  return useStorageMutation(async (input: StorageChangeInput) => {
    const { data } = await api.POST("/api/subscriptions/storage/change", { body: input });
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

export const STORAGE_BILLING_KEY = ["storage-addon-billing"];

/** The add-on's card, next bill and invoices, read from the payment provider. */
export function useStorageBillingQuery(enabled: boolean) {
  return useQuery({
    queryKey: STORAGE_BILLING_KEY,
    enabled,
    retry: false,
    queryFn: async () => {
      const { data } = await api.GET("/api/subscriptions/storage/billing");
      return (data ?? null) as StorageBilling | null;
    },
  });
}

/** Undo the change scheduled for the next renewal. */
export function useUndoStorageChange() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/subscriptions/storage/change/undo");
      return required(data, "Undo storage change") as StorageCurrent;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: STORAGE_OFFER_KEY }),
        queryClient.invalidateQueries({ queryKey: STORAGE_BILLING_KEY }),
      ]);
    },
  });
}

/** A hosted page where the school replaces its card; the caller sends the browser to `url`. */
export function useStoragePaymentMethodSession() {
  return useMutation({
    mutationFn: async (returnUrl: string) => {
      const { data } = await api.POST("/api/subscriptions/storage/payment-method", {
        body: { returnUrl },
      });
      return required(data, "Payment method page");
    },
  });
}

/** The school's saved cards to pay a storage change with, the renewal card first. */
export function useStorageCardsQuery(enabled: boolean) {
  return useQuery({
    queryKey: ["storage-addon-cards"],
    enabled,
    staleTime: 0,
    retry: false,
    queryFn: async () => {
      const { data } = await api.GET("/api/subscriptions/storage/cards");
      return (data?.cards ?? []) as StorageCard[];
    },
  });
}

/** A hosted page to save a new card (nothing is charged); the caller sends the browser to `url`. */
export function useStorageCardSetup() {
  return useMutation({
    mutationFn: async (input: { successUrl: string; cancelUrl: string }) => {
      const { data } = await api.POST("/api/subscriptions/storage/cards/setup", { body: input });
      return required(data, "Card setup page");
    },
  });
}
