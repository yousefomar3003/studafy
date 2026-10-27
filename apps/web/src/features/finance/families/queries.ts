import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

// The generated types' `readonly` arrays lose their array prototype through `api.GET`'s response
// typing (the `@studafy/api-client` gap `NotificationBell.tsx` documents), so the shapes these pages
// read are restated here with plain arrays and the responses cast into them.

export type FamilyGuardian = components["schemas"]["FinanceFamilyGuardian"];
export type FamilyChild = components["schemas"]["FinanceFamilyChild"];
export type FamilyBalance = components["schemas"]["FinanceFamilyBalance"];
export type FinanceCommunication = components["schemas"]["FinanceCommunication"];
export type FamilySendResult = components["schemas"]["FamilySendResult"];
export type BulkReminderResult = components["schemas"]["BulkReminderResult"];
export type FamilyPaymentResult = components["schemas"]["FamilyPaymentResult"];
export type CreateFamilyPaymentBody = components["schemas"]["CreateFamilyPaymentBody"];
export type SiblingDiscountRule = components["schemas"]["SiblingDiscountRule"];
export type SiblingDiscountTier = components["schemas"]["SiblingDiscountTier"];

export interface FinanceFamily {
  id: string;
  display_name: string;
  guardians: FamilyGuardian[];
  children: FamilyChild[];
  balances: FamilyBalance[];
  overdue_invoice_count: number;
  last_payment_date: string | null;
  last_reminder_at: string | null;
}

export interface FinanceFamilyProfile extends FinanceFamily {
  communications: FinanceCommunication[];
}

type HouseholdView = components["schemas"]["FamilyFinancialView"];
type StudentSection = HouseholdView["students"][number];
export type HouseholdInvoice = StudentSection["invoices"][number];
export type HouseholdInstallment = StudentSection["installments"][number];
export type HouseholdPayment = StudentSection["payments"][number];

export interface HouseholdStudent {
  student_id: string;
  invoices: HouseholdInvoice[];
  installments: HouseholdInstallment[];
  payments: HouseholdPayment[];
}

export interface FamilyPaymentResponse {
  outcome: "completed" | "partial" | "failed";
  currency: string;
  results: FamilyPaymentResult[];
}

export interface FamilyFilters {
  search: string;
  siblingsOnly: boolean;
  balance: "" | "outstanding" | "overdue";
  sort: "name" | "outstanding";
}

export const FAMILIES_PAGE_SIZE = 20;

/** Every family query sits under this key, so one invalidation refreshes list and pages. */
export const FAMILIES_KEY = ["finance", "families"] as const;
export const SIBLING_DISCOUNT_KEY = ["finance", "sibling-discount"] as const;

export async function fetchFamiliesPage(
  filters: FamilyFilters,
  offset: number,
): Promise<{ items: FinanceFamily[]; total: number }> {
  const { data } = await api.GET("/api/finance/families", {
    params: {
      query: {
        search: filters.search.trim() || undefined,
        min_children: filters.siblingsOnly ? 2 : undefined,
        balance: filters.balance || undefined,
        sort: filters.sort,
        limit: FAMILIES_PAGE_SIZE,
        offset,
      },
    },
  });
  return { items: (data?.families ?? []) as FinanceFamily[], total: data?.total ?? 0 };
}

export async function fetchFamilyProfile(familyId: string): Promise<FinanceFamilyProfile> {
  const { data } = await api.GET("/api/finance/families/{familyId}/profile", {
    params: { path: { familyId } },
  });
  if (!data) throw new Error("Family not found.");
  return data as unknown as FinanceFamilyProfile;
}

/** The household's invoices, installments and payments per child (the parent app's view). */
export async function fetchHousehold(familyId: string): Promise<HouseholdStudent[]> {
  const { data } = await api.GET("/api/finance/families/{familyId}", {
    params: { path: { familyId } },
  });
  return (data?.students ?? []) as unknown as HouseholdStudent[];
}

export async function fetchSiblingDiscountRule(): Promise<SiblingDiscountRule> {
  const { data } = await api.GET("/api/finance/sibling-discount");
  if (!data) throw new Error("Sibling discount rule unavailable.");
  return data as SiblingDiscountRule;
}

function useFamilyMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: FAMILIES_KEY }),
  });
}

export function useSendReminder() {
  return useFamilyMutation(async (familyId: string) => {
    const { data } = await api.POST("/api/finance/families/{familyId}/reminders", {
      params: { path: { familyId } },
    });
    if (!data) throw new Error("Reminder returned no data.");
    return data as FamilySendResult;
  });
}

export function useSendStatement() {
  return useFamilyMutation(async (familyId: string) => {
    const { data } = await api.POST("/api/finance/families/{familyId}/statements", {
      params: { path: { familyId } },
    });
    if (!data) throw new Error("Statement returned no data.");
    return data as FamilySendResult;
  });
}

export function useSendBulkReminders() {
  return useFamilyMutation(async () => {
    const { data } = await api.POST("/api/finance/reminders", { body: {} });
    if (!data) throw new Error("Reminders returned no data.");
    return data as BulkReminderResult;
  });
}

export interface RecordFamilyPaymentInput {
  familyId: string;
  body: CreateFamilyPaymentBody;
  /** One key per submission attempt; see `payments/mutations.ts` for why the form owns it. */
  idempotencyKey: string;
}

export function useRecordFamilyPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ familyId, body, idempotencyKey }: RecordFamilyPaymentInput) => {
      const { data } = await api.POST("/api/finance/families/{familyId}/payments", {
        params: { path: { familyId }, header: { "idempotency-key": idempotencyKey } },
        body,
      });
      if (!data) throw new Error("Family payment returned no data.");
      return data as unknown as FamilyPaymentResponse;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: FAMILIES_KEY });
      await queryClient.invalidateQueries({ queryKey: ["finance", "payments"] });
    },
  });
}

export function useSaveSiblingDiscountRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: components["schemas"]["UpdateSiblingDiscountBody"]) => {
      const { data } = await api.PUT("/api/finance/sibling-discount", { body });
      if (!data) throw new Error("Sibling discount returned no data.");
      return data as SiblingDiscountRule;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SIBLING_DISCOUNT_KEY });
      await queryClient.invalidateQueries({ queryKey: FAMILIES_KEY });
    },
  });
}
