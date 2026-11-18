import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../lib/api";
import { LICENSING_KEY } from "../platform/licensing/queries";

import type { components } from "@studafy/api-client";

/**
 * Reads and writes for the Student AI programme's dashboards (phase 6 of the plan,
 * docs/billing/ai-programme.md "Dashboards").
 *
 *   * The school's own: its summary and ledger (`aiRevenueShare:read`: the school admin, the
 *     principal and finance) and its upload consistency per class and teacher (`license:read`: the
 *     school admin and the principal).
 *   * The console's (`platform:read`, writes `platform:manage`): every school's row, one school's
 *     summary, ledger, licence measurements and upload consistency; recompute, payouts and
 *     re-measuring before the lock. Its keys sit under the license console's, so a console write
 *     anywhere refreshes these figures too.
 */

type Schemas = components["schemas"];
export type ProgrammeDashboard = Schemas["AiProgrammeDashboard"];
export type PlatformProgrammeDashboard = Schemas["PlatformAiProgrammeDashboard"];
export type ProgrammeSchoolRow = Schemas["AiProgrammeSchoolRow"];
export type ProgrammeEarnings = Schemas["AiProgrammeDashboardEarnings"];
export type ProgrammeTier = Schemas["AiProgrammeDashboardTier"];
export type RevenueShareLedger = Schemas["AiRevenueShareLedger"];
export type RevenueShareEntry = Schemas["AiRevenueShareEntry"];
export type RevenueSharePayout = Schemas["AiRevenueSharePayout"];
export type RevenueShareStatus = Schemas["AiRevenueShareStatus"];
export type LicenceRevenueShare = Schemas["AiLicenseRevenueShare"];
export type ConversionSnapshot = Schemas["AiConversionSnapshot"];
export type UploadConsistency = Schemas["UploadConsistency"];

export const REVENUE_SHARE_STATUSES: readonly RevenueShareStatus[] = [
  "pending",
  "owed",
  "zero",
  "credited",
  "payout_due",
  "paid_out",
  "forfeited",
  "void",
];

export const SCHOOL_PROGRAMME_KEY = ["ai-programme"] as const;
const PLATFORM_PROGRAMME_KEY = [...LICENSING_KEY, "ai-revenue-share"] as const;

function required<T>(data: T | undefined, what: string): T {
  if (data === undefined) throw new Error(`${what} returned no data.`);
  return data;
}

// ---------------------------------------------------------------------------------------------------
// The school's own
// ---------------------------------------------------------------------------------------------------

export function useSchoolProgrammeQuery() {
  return useQuery({
    queryKey: [...SCHOOL_PROGRAMME_KEY, "summary"] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/school/ai-revenue-share/summary");
      return required(data, "Programme summary") as ProgrammeDashboard;
    },
  });
}

export function useSchoolLedgerQuery() {
  return useQuery({
    queryKey: [...SCHOOL_PROGRAMME_KEY, "ledger"] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/school/ai-revenue-share");
      return required(data, "Revenue share") as RevenueShareLedger;
    },
  });
}

export function useSchoolUploadsQuery(enabled = true) {
  return useQuery({
    queryKey: [...SCHOOL_PROGRAMME_KEY, "uploads"] as const,
    enabled,
    queryFn: async () => {
      const { data } = await api.GET("/api/school/license/upload-consistency");
      return required(data, "Upload consistency") as UploadConsistency;
    },
  });
}

// ---------------------------------------------------------------------------------------------------
// The console's
// ---------------------------------------------------------------------------------------------------

export function useProgrammeSchoolsQuery() {
  return useQuery({
    queryKey: [...PLATFORM_PROGRAMME_KEY, "schools"] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/ai-revenue-share/schools");
      return required(data, "Programme schools").schools as ProgrammeSchoolRow[];
    },
  });
}

export function usePlatformProgrammeQuery(schoolId: string) {
  return useQuery({
    queryKey: [...PLATFORM_PROGRAMME_KEY, schoolId, "summary"] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/schools/{schoolId}/ai-revenue-share/summary", {
        params: { path: { schoolId } },
      });
      return required(data, "Programme summary") as PlatformProgrammeDashboard;
    },
  });
}

export function usePlatformLedgerQuery(schoolId: string, status: RevenueShareStatus | "") {
  return useQuery({
    queryKey: [...PLATFORM_PROGRAMME_KEY, schoolId, "ledger", status] as const,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/schools/{schoolId}/ai-revenue-share", {
        params: { path: { schoolId }, query: status ? { status } : {} },
      });
      return required(data, "Revenue share") as RevenueShareLedger;
    },
  });
}

export function usePlatformLicenceShareQuery(schoolId: string, licenseId: string | null) {
  return useQuery({
    queryKey: [...PLATFORM_PROGRAMME_KEY, schoolId, "licence", licenseId] as const,
    enabled: licenseId !== null,
    queryFn: async () => {
      const { data } = await api.GET(
        "/api/platform/schools/{schoolId}/licenses/{licenseId}/ai-revenue-share",
        { params: { path: { schoolId, licenseId: licenseId! } } },
      );
      return required(data, "Licence revenue share") as LicenceRevenueShare;
    },
  });
}

export function usePlatformUploadsQuery(schoolId: string) {
  return useQuery({
    queryKey: [...PLATFORM_PROGRAMME_KEY, schoolId, "uploads"] as const,
    queryFn: async () => {
      const { data } = await api.GET(
        "/api/platform/schools/{schoolId}/ai-programme/upload-consistency",
        { params: { path: { schoolId } } },
      );
      return required(data, "Upload consistency") as UploadConsistency;
    },
  });
}

function useConsoleMutation<Input, Output>(mutationFn: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LICENSING_KEY }),
  });
}

export function useRecomputeRevenueShare() {
  return useConsoleMutation(async (schoolId: string) => {
    const { data } = await api.POST("/api/platform/schools/{schoolId}/ai-revenue-share/recompute", {
      params: { path: { schoolId } },
    });
    return required(data, "Recompute");
  });
}

export function useRecordRevenueSharePayout() {
  return useConsoleMutation(
    async (input: {
      schoolId: string;
      currencyCode: string;
      amountMinor: number;
      reference: string;
      paidOn: string;
      note: string | null;
    }) => {
      const { schoolId, ...body } = input;
      const { data } = await api.POST("/api/platform/schools/{schoolId}/ai-revenue-share/payouts", {
        params: { path: { schoolId } },
        body,
      });
      return required(data, "Payout") as RevenueSharePayout;
    },
  );
}

export function useRemeasureConversion() {
  return useConsoleMutation(
    async (input: {
      schoolId: string;
      licenseId: string;
      reason: string;
      periodStart: string | null;
    }) => {
      const { data } = await api.POST(
        "/api/platform/schools/{schoolId}/licenses/{licenseId}/ai-revenue-share/measure",
        {
          params: { path: { schoolId: input.schoolId, licenseId: input.licenseId } },
          body: { reason: input.reason, periodStart: input.periodStart },
        },
      );
      return required(data, "Measurement") as LicenceRevenueShare;
    },
  );
}
