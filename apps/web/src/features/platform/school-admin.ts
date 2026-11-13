import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../lib/api";

import { PLATFORM_KEY, schoolDetailKey } from "./queries";

import type { PlatformSchoolDetail } from "./queries";
import type { components } from "@studafy/api-client";

/**
 * Data hooks for the console's per-school administration: the usage panel, the profile editor
 * and whole-school exports (`/api/platform/schools/{schoolId}/usage|profile|exports`).
 */

export type PlatformSchoolUsage = components["schemas"]["PlatformSchoolUsage"];
export type PlatformSchoolExport = components["schemas"]["PlatformSchoolExport"];
export type UpdateSchoolProfileBody = components["schemas"]["UpdatePlatformSchoolProfile"];

export function schoolUsageKey(schoolId: string) {
  return [...PLATFORM_KEY, "school-usage", schoolId] as const;
}

export function schoolExportsKey(schoolId: string) {
  return [...PLATFORM_KEY, "school-exports", schoolId] as const;
}

/** How often the exports list refreshes while one is still being built. */
export const EXPORT_POLL_MS = 10_000;

/** `GET /api/platform/schools/{schoolId}/usage` — the school's usage panel. */
export function useSchoolUsageQuery(schoolId: string) {
  return useQuery({
    queryKey: schoolUsageKey(schoolId),
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/schools/{schoolId}/usage", {
        params: { path: { schoolId } },
      });
      if (!data) throw new Error("School usage returned no data.");
      return data as PlatformSchoolUsage;
    },
  });
}

/** `GET /api/platform/schools/{schoolId}/exports` — polls while an export is queued or running. */
export function useSchoolExportsQuery(schoolId: string) {
  return useQuery({
    queryKey: schoolExportsKey(schoolId),
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/schools/{schoolId}/exports", {
        params: { path: { schoolId } },
      });
      if (!data) throw new Error("School exports returned no data.");
      return (data as { exports: PlatformSchoolExport[] }).exports;
    },
    refetchInterval: (query) =>
      query.state.data?.some((item) => item.status === "queued" || item.status === "processing")
        ? EXPORT_POLL_MS
        : false,
  });
}

/** `PATCH /api/platform/schools/{schoolId}/profile` — writes the fresh school into the cache. */
export function useUpdateSchoolProfile(schoolId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: UpdateSchoolProfileBody) => {
      const { data } = await api.PATCH("/api/platform/schools/{schoolId}/profile", {
        params: { path: { schoolId } },
        body,
      });
      if (!data) throw new Error("Profile update returned no data.");
      return data as PlatformSchoolDetail;
    },
    onSuccess: (school) => {
      queryClient.setQueryData(schoolDetailKey(schoolId), school);
      void queryClient.invalidateQueries({ queryKey: [...PLATFORM_KEY, "schools"] });
    },
  });
}

/** `POST /api/platform/schools/{schoolId}/exports` — files and queues a whole-school export. */
export function useCreateSchoolExport(schoolId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (reason: string) => {
      const { data } = await api.POST("/api/platform/schools/{schoolId}/exports", {
        params: { path: { schoolId } },
        body: { reason },
      });
      if (!data) throw new Error("Export request returned no data.");
      return data as PlatformSchoolExport;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: schoolExportsKey(schoolId) });
    },
  });
}

/**
 * `GET /api/platform/schools/{schoolId}/exports/{exportId}` — asks for a fresh one-hour download
 * link. A mutation, not a query: every link issued is audited, so it is only fetched on a click.
 */
export function useSchoolExportLink(schoolId: string) {
  return useMutation({
    mutationFn: async (exportId: string) => {
      const { data } = await api.GET("/api/platform/schools/{schoolId}/exports/{exportId}", {
        params: { path: { schoolId, exportId } },
      });
      if (!data) throw new Error("Export returned no data.");
      return data as PlatformSchoolExport;
    },
  });
}
