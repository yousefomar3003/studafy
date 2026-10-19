import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../lib/api";

import { PLATFORM_KEY } from "./queries";

import type { components } from "@studafy/api-client";

export type PlatformApplication = components["schemas"]["PlatformSchoolApplication"];
export type PlatformApplicationSummary = components["schemas"]["PlatformSchoolApplicationSummary"];
export type PlatformApplicationStatus = components["schemas"]["SchoolApplicationStatus"];

export const APPLICATIONS_PAGE_SIZE = 25;
const APPLICATIONS_KEY = [...PLATFORM_KEY, "applications"] as const;

export interface ApplicationListFilters {
  search: string;
  status: PlatformApplicationStatus | "";
  page: number;
}

export function applicationsListKey(filters: ApplicationListFilters) {
  return [...APPLICATIONS_KEY, "list", filters] as const;
}

export function applicationDetailKey(applicationId: string) {
  return [...APPLICATIONS_KEY, "detail", applicationId] as const;
}

/** `GET /api/platform/school-applications` — one page of sign-up applications, newest first. */
export function useApplicationsQuery(filters: ApplicationListFilters) {
  return useQuery({
    queryKey: applicationsListKey(filters),
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/school-applications", {
        params: {
          query: {
            search: filters.search || undefined,
            status: filters.status || undefined,
            limit: APPLICATIONS_PAGE_SIZE,
            offset: filters.page * APPLICATIONS_PAGE_SIZE,
          },
        },
      });
      if (!data) throw new Error("Application list returned no data.");
      return data as {
        applications: PlatformApplicationSummary[];
        total: number;
        pendingCount: number;
      };
    },
    placeholderData: keepPreviousData,
  });
}

/**
 * `GET /api/platform/school-applications/{applicationId}`. The proof link inside is a short-lived
 * pre-signed URL, so the record is never treated as fresh for long.
 */
export function useApplicationQuery(applicationId: string) {
  return useQuery({
    queryKey: applicationDetailKey(applicationId),
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/school-applications/{applicationId}", {
        params: { path: { applicationId } },
      });
      if (!data) throw new Error("Application returned no data.");
      return data as PlatformApplication;
    },
    enabled: applicationId !== "",
    staleTime: 60_000,
  });
}

function useDecision(decision: "approve" | "reject") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { applicationId: string; text: string }) => {
      const params = { path: { applicationId: input.applicationId } };
      const { data } =
        decision === "approve"
          ? await api.POST("/api/platform/school-applications/{applicationId}/approve", {
              params,
              body: { note: input.text || undefined },
            })
          : await api.POST("/api/platform/school-applications/{applicationId}/reject", {
              params,
              body: { reason: input.text },
            });
      if (!data) throw new Error("Application decision returned no data.");
      return data as PlatformApplication;
    },
    onSuccess: (application) => {
      queryClient.setQueryData(applicationDetailKey(application.id), application);
      // An approval also creates a school, so every console list and the overview move.
      return queryClient.invalidateQueries({ queryKey: PLATFORM_KEY });
    },
  });
}

/** `POST …/approve` — creates and provisions the school; the applicant is emailed. */
export function useApproveApplication() {
  return useDecision("approve");
}

/** `POST …/reject` — the reason is emailed to the applicant. */
export function useRejectApplication() {
  return useDecision("reject");
}
