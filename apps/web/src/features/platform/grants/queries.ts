import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";
import { uploadReceipt } from "../licensing/mutations";
import { PLATFORM_FINANCE_KEY, PLATFORM_KEY } from "../queries";

import type { components, operations } from "@studafy/api-client";

/**
 * Manual grants in the platform console (db/migrations/000211): storage caps and feature tiers given
 * by hand, usually after a cash payment. Reads and writes for the school card, the user lookup's
 * "Grant paid tier" and the Manual grants page.
 */

export type ManualGrant = components["schemas"]["PlatformManualGrant"];
export type CreateGrantBody = components["schemas"]["PlatformCreateManualGrant"];
type GrantListQuery = NonNullable<operations["listPlatformManualGrants"]["parameters"]["query"]>;
export type GrantFilter = NonNullable<GrantListQuery["filter"]>;
export type GrantKind = ManualGrant["kind"];

export const GIB = 1024 ** 3;
/** The sold storage tiers, offered as presets. */
export const STORAGE_PRESETS = { "100gb": 100 * GIB, "1tb": 1024 * GIB } as const;

export const GRANTS_KEY = [...PLATFORM_KEY, "grants"] as const;
export const schoolGrantsKey = (schoolId: string) => [...GRANTS_KEY, "school", schoolId] as const;

export function useSchoolGrantsQuery(schoolId: string) {
  return useQuery({
    queryKey: schoolGrantsKey(schoolId),
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/schools/{schoolId}/grants", {
        params: { path: { schoolId }, query: { filter: "all" } },
      });
      if (!data) throw new Error("Grant list returned no data.");
      return data.grants as ManualGrant[];
    },
    enabled: schoolId !== "",
  });
}

export function useAllGrantsQuery(filter: GrantFilter, kind: GrantKind | "") {
  return useQuery({
    queryKey: [...GRANTS_KEY, "all", filter, kind] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/grants", {
        params: { query: { filter, ...(kind ? { kind } : {}) } },
      });
      if (!data) throw new Error("Grant list returned no data.");
      return data.grants as ManualGrant[];
    },
  });
}

export interface CreateGrantInput {
  schoolId: string;
  body: Omit<CreateGrantBody, "receiptStorageKey">;
  receipt: File | null;
}

/** Every grant list, the finance totals and the school's own data move together. */
function useInvalidateGrants() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: GRANTS_KEY });
    void queryClient.invalidateQueries({ queryKey: PLATFORM_FINANCE_KEY });
  };
}

export function useCreateGrant() {
  const invalidate = useInvalidateGrants();
  return useMutation({
    mutationFn: async ({ schoolId, body, receipt }: CreateGrantInput) => {
      const receiptStorageKey = receipt ? await uploadReceipt(schoolId, receipt) : undefined;
      const { data } = await api.POST("/api/platform/schools/{schoolId}/grants", {
        params: { path: { schoolId } },
        body: { ...body, ...(receiptStorageKey ? { receiptStorageKey } : {}) },
      });
      if (!data) throw new Error("Grant returned no data.");
      return data as ManualGrant;
    },
    onSuccess: invalidate,
  });
}

export function useRevokeGrant() {
  const invalidate = useInvalidateGrants();
  return useMutation({
    mutationFn: async (input: { schoolId: string; grantId: string; reason: string }) => {
      const { data } = await api.POST("/api/platform/schools/{schoolId}/grants/{grantId}/revoke", {
        params: { path: { schoolId: input.schoolId, grantId: input.grantId } },
        body: { reason: input.reason },
      });
      if (!data) throw new Error("Revoke returned no data.");
      return data as ManualGrant;
    },
    onSuccess: invalidate,
  });
}

/** A short-lived link to the grant's receipt, fetched on demand. */
export async function fetchGrantReceiptUrl(schoolId: string, grantId: string): Promise<string> {
  const { data } = await api.GET("/api/platform/schools/{schoolId}/grants/{grantId}/receipt-file", {
    params: { path: { schoolId, grantId } },
  });
  if (!data) throw new Error("Receipt link returned no data.");
  return data.url;
}

/** `months` from now, as the API's ISO end. */
export function endAfterMonths(months: number, from: Date = new Date()): string {
  const end = new Date(from);
  end.setMonth(end.getMonth() + months);
  return end.toISOString();
}

/** A decimal amount ("12.50") in the currency's minor unit, or null when it is not a valid amount. */
export function toMinor(amount: string, minorUnit = 2): number | null {
  const parts = amount.trim().split(".");
  if (parts.length > 2) return null;
  const [whole = "", fraction = ""] = parts;
  const digits = /^\d+$/;
  if (!digits.test(whole) || (parts.length === 2 && !digits.test(fraction))) return null;
  if (fraction.length > minorUnit) return null;
  return Number(whole) * 10 ** minorUnit + Number(fraction.padEnd(minorUnit, "0") || 0);
}
