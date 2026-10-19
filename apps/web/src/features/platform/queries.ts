import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { api } from "../../lib/api";

import type { components, operations } from "@studafy/api-client";

export type PlatformOverview = components["schemas"]["PlatformOverview"];
export type PlatformSchoolSummary = components["schemas"]["PlatformSchoolSummary"];
export type PlatformSchoolDetail = components["schemas"]["PlatformSchoolDetail"];
export type PlatformSchoolStatus = components["schemas"]["PlatformSchoolStatus"];
export type PlatformFeatureFlagState = components["schemas"]["PlatformFeatureFlagState"];
export type PlatformPlan = components["schemas"]["PlatformPlan"];
export type PlatformPlanPrice = components["schemas"]["PlatformPlanPrice"];
export type PlatformSetting = components["schemas"]["PlatformSetting"];
export type PlatformUserLookupResult = components["schemas"]["PlatformUserLookupResult"];
export type PlatformSchoolMember = components["schemas"]["PlatformSchoolMember"];
export type PlatformSchoolMemberList = components["schemas"]["PlatformSchoolMemberList"];
type SchoolMembersQuery = NonNullable<
  operations["listPlatformSchoolMembers"]["parameters"]["query"]
>;
export type PlatformMemberRole = NonNullable<SchoolMembersQuery["role"]>;
export type PlatformMemberStatus = PlatformSchoolMember["status"];
export type PlatformFinance = components["schemas"]["PlatformFinance"];
export type PlatformInquiry = components["schemas"]["PlatformInquiry"];
export type PlatformInquiryStatus = components["schemas"]["PlatformInquiryStatus"];
export type PlatformAiMetrics =
  operations["getAiMetrics"]["responses"][200]["content"]["application/json"];

// The generated response types lose readonly arrays' prototype (a pre-existing `@studafy/api-client`
// typing gap -- see admin/settings/queries.ts for the same cast). The shapes are identical; each
// fetcher below casts back to the named component schema.

export const PLATFORM_KEY = ["platform"] as const;
export const PLATFORM_OVERVIEW_KEY = [...PLATFORM_KEY, "overview"] as const;
export const PLATFORM_PLANS_KEY = [...PLATFORM_KEY, "plans"] as const;
export const PLATFORM_SETTINGS_KEY = [...PLATFORM_KEY, "settings"] as const;
export const PLATFORM_FINANCE_KEY = [...PLATFORM_KEY, "finance"] as const;
export const PLATFORM_AI_METRICS_KEY = [...PLATFORM_KEY, "ai-metrics"] as const;

export interface SchoolListFilters {
  search: string;
  status: PlatformSchoolStatus | "";
  page: number;
}

export const SCHOOLS_PAGE_SIZE = 25;
export const INQUIRIES_PAGE_SIZE = 25;
export const SCHOOL_MEMBERS_PAGE_SIZE = 25;

export interface SchoolMemberFilters {
  role: PlatformMemberRole | "";
  status: PlatformMemberStatus | "";
  search: string;
  page: number;
}

export interface InquiryListFilters {
  search: string;
  status: PlatformInquiryStatus | "";
  page: number;
}

export function inquiriesListKey(filters: InquiryListFilters) {
  return [...PLATFORM_KEY, "inquiries", filters] as const;
}

export function schoolsListKey(filters: SchoolListFilters) {
  return [...PLATFORM_KEY, "schools", filters] as const;
}

export function schoolDetailKey(schoolId: string) {
  return [...PLATFORM_KEY, "school", schoolId] as const;
}

/** `GET /api/platform/overview` — platform-wide totals for the console home. */
export function usePlatformOverviewQuery() {
  return useQuery({
    queryKey: PLATFORM_OVERVIEW_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/overview");
      if (!data) throw new Error("Platform overview returned no data.");
      return data as PlatformOverview;
    },
  });
}

/** `GET /api/platform/finance` — Studafy's own revenue and billing health across every school. */
export function usePlatformFinanceQuery() {
  return useQuery({
    queryKey: PLATFORM_FINANCE_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/finance");
      if (!data) throw new Error("Platform finance returned no data.");
      return data as PlatformFinance;
    },
  });
}

/** `GET /api/ai/admin/metrics` — per-school AI usage, provider cost and margin this period. */
export function useAiMetricsQuery() {
  return useQuery({
    queryKey: PLATFORM_AI_METRICS_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/ai/admin/metrics");
      if (!data) throw new Error("AI metrics returned no data.");
      return data as PlatformAiMetrics;
    },
  });
}

/** `GET /api/platform/inquiries` — one page of "Talk to us" inquiries, newest first. */
export function useInquiriesQuery(filters: InquiryListFilters) {
  return useQuery({
    queryKey: inquiriesListKey(filters),
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/inquiries", {
        params: {
          query: {
            search: filters.search || undefined,
            status: filters.status || undefined,
            limit: INQUIRIES_PAGE_SIZE,
            offset: filters.page * INQUIRIES_PAGE_SIZE,
          },
        },
      });
      if (!data) throw new Error("Inquiry list returned no data.");
      return data as { inquiries: PlatformInquiry[]; total: number; newCount: number };
    },
    placeholderData: keepPreviousData,
  });
}

/** `GET /api/platform/schools` — one page of schools, offset-paged (the platform is small). */
export function useSchoolsListQuery(filters: SchoolListFilters) {
  return useQuery({
    queryKey: schoolsListKey(filters),
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/schools", {
        params: {
          query: {
            search: filters.search || undefined,
            status: filters.status || undefined,
            limit: SCHOOLS_PAGE_SIZE,
            offset: filters.page * SCHOOLS_PAGE_SIZE,
          },
        },
      });
      if (!data) throw new Error("School list returned no data.");
      return data as { schools: PlatformSchoolSummary[]; total: number };
    },
    placeholderData: keepPreviousData,
  });
}

/** `GET /api/platform/schools/{schoolId}` — one school with flags and allowed transitions. */
export function useSchoolDetailQuery(schoolId: string) {
  return useQuery({
    queryKey: schoolDetailKey(schoolId),
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/schools/{schoolId}", {
        params: { path: { schoolId } },
      });
      if (!data) throw new Error("School detail returned no data.");
      return data as PlatformSchoolDetail;
    },
  });
}

export function schoolMembersKey(schoolId: string, filters: SchoolMemberFilters) {
  // Not under schoolDetailKey: every fetch is audited, so it should not refetch alongside the detail.
  return [...PLATFORM_KEY, "school-members", schoolId, filters] as const;
}

/** `GET /api/platform/schools/{schoolId}/members` — one page of a school's accounts. Audited. */
export function useSchoolMembersQuery(schoolId: string, filters: SchoolMemberFilters) {
  return useQuery({
    queryKey: schoolMembersKey(schoolId, filters),
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/schools/{schoolId}/members", {
        params: {
          path: { schoolId },
          query: {
            role: filters.role || undefined,
            status: filters.status || undefined,
            search: filters.search || undefined,
            limit: SCHOOL_MEMBERS_PAGE_SIZE,
            offset: filters.page * SCHOOL_MEMBERS_PAGE_SIZE,
          },
        },
      });
      if (!data) throw new Error("School members returned no data.");
      return data as PlatformSchoolMemberList;
    },
    placeholderData: keepPreviousData,
  });
}

export function usePlansQuery() {
  return useQuery({
    queryKey: PLATFORM_PLANS_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/plans");
      if (!data) throw new Error("Plan list returned no data.");
      return data.plans as PlatformPlan[];
    },
  });
}

export function usePlatformSettingsQuery() {
  return useQuery({
    queryKey: PLATFORM_SETTINGS_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/settings");
      if (!data) throw new Error("Platform settings returned no data.");
      return data.settings as PlatformSetting[];
    },
  });
}

/** Cross-school account lookup. Disabled until a submitted email is set. */
export function useUserLookupQuery(email: string) {
  return useQuery({
    queryKey: [...PLATFORM_KEY, "user-lookup", email] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/users/lookup", {
        params: { query: { email } },
      });
      if (!data) throw new Error("User lookup returned no data.");
      return data.matches as PlatformUserLookupResult[];
    },
    enabled: email !== "",
  });
}

// ---------------------------------------------------------------------------
// Subscription refund requests
// ---------------------------------------------------------------------------

export type PlatformRefundRequest = components["schemas"]["PlatformRefundRequest"];
export type PlatformRefundDetail = components["schemas"]["PlatformRefundRequestDetail"];
export type PlatformRefundStatus = components["schemas"]["SubscriptionRefundStatus"];
export type PlatformRefundScope = components["schemas"]["SubscriptionRefundScope"];

export const REFUNDS_PAGE_SIZE = 25;

export interface RefundListFilters {
  search: string;
  status: PlatformRefundStatus | "";
  scope: PlatformRefundScope | "";
  page: number;
}

export const PLATFORM_REFUNDS_KEY = [...PLATFORM_KEY, "refunds"] as const;

/** `GET /api/platform/refund-requests` — one page of every school's refund requests. */
export function useRefundRequestsQuery(filters: RefundListFilters) {
  return useQuery({
    queryKey: [...PLATFORM_REFUNDS_KEY, "list", filters] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/refund-requests", {
        params: {
          query: {
            search: filters.search || undefined,
            status: filters.status || undefined,
            scope: filters.scope || undefined,
            limit: REFUNDS_PAGE_SIZE,
            offset: filters.page * REFUNDS_PAGE_SIZE,
          },
        },
      });
      if (!data) throw new Error("Refund request list returned no data.");
      return data as { requests: PlatformRefundRequest[]; total: number; pendingCount: number };
    },
    placeholderData: keepPreviousData,
  });
}

/** One request plus the school's recent paid payments to refund from. */
export function useRefundRequestQuery(schoolId: string, requestId: string) {
  return useQuery({
    queryKey: [...PLATFORM_REFUNDS_KEY, "detail", schoolId, requestId] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/refund-requests/{schoolId}/{requestId}", {
        params: { path: { schoolId, requestId } },
      });
      if (!data) throw new Error("Refund request returned no data.");
      return data as PlatformRefundDetail;
    },
  });
}
