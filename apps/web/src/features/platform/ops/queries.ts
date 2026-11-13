import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "../../../lib/api";
import { PLATFORM_KEY } from "../queries";

import type { components } from "@studafy/api-client";

export type PlatformAnnouncement = components["schemas"]["PlatformAnnouncement"];
export type PlatformAnnouncementList = components["schemas"]["PlatformAnnouncementList"];
export type PlatformAnnouncementAudience = components["schemas"]["PlatformAnnouncementAudience"];
export type PlatformAnnouncementSeverity = components["schemas"]["PlatformAnnouncementSeverity"];
export type CreatePlatformAnnouncement = components["schemas"]["CreatePlatformAnnouncement"];
export type UpdatePlatformAnnouncement = components["schemas"]["UpdatePlatformAnnouncement"];
export type PlatformBanner = components["schemas"]["PlatformBanner"];
export type PlatformBannerList = components["schemas"]["PlatformBannerList"];
export type PlatformActivityEntry = components["schemas"]["PlatformActivityEntry"];
export type PlatformActivityList = components["schemas"]["PlatformActivityList"];
export type PlatformOperatorList = components["schemas"]["PlatformOperatorList"];
export type PlatformSystemHealth = components["schemas"]["PlatformSystemHealth"];
export type PlatformFlagOverviewList = components["schemas"]["PlatformFlagOverviewList"];
export type PlatformFlagOverview = PlatformFlagOverviewList["flags"][number];

export const PLATFORM_ANNOUNCEMENTS_KEY = [...PLATFORM_KEY, "announcements"] as const;
export const PLATFORM_ACTIVITY_KEY = [...PLATFORM_KEY, "activity"] as const;
export const PLATFORM_OPERATORS_KEY = [...PLATFORM_KEY, "operators"] as const;
export const PLATFORM_HEALTH_KEY = [...PLATFORM_KEY, "health"] as const;
export const PLATFORM_FLAGS_OVERVIEW_KEY = [...PLATFORM_KEY, "flags-overview"] as const;
/** Not under PLATFORM_KEY: every signed-in user reads it, not just the console. */
export const PLATFORM_BANNERS_KEY = ["platform-banners"] as const;

export const ACTIVITY_PAGE_SIZE = 50;

export interface ActivityFilters {
  actorId: string;
  action: string;
  targetTable: string;
  schoolId: string;
  /** yyyy-mm-dd, inclusive; empty means the API default (the last 30 days). */
  from: string;
  to: string;
}

export function useAnnouncementsQuery() {
  return useQuery({
    queryKey: PLATFORM_ANNOUNCEMENTS_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/announcements", {
        params: { query: { limit: 20 } },
      });
      if (!data) throw new Error("Announcements returned no data.");
      return (data as PlatformAnnouncementList).announcements;
    },
  });
}

export function useCreateAnnouncement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreatePlatformAnnouncement) => {
      const { data } = await api.POST("/api/platform/announcements", { body });
      if (!data) throw new Error("Creating the announcement returned no data.");
      return data as PlatformAnnouncement;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PLATFORM_ANNOUNCEMENTS_KEY });
      void queryClient.invalidateQueries({ queryKey: PLATFORM_BANNERS_KEY });
    },
  });
}

export function useUpdateAnnouncement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      announcementId,
      ...body
    }: UpdatePlatformAnnouncement & { announcementId: string }) => {
      const { data } = await api.PATCH("/api/platform/announcements/{announcementId}", {
        params: { path: { announcementId } },
        body,
      });
      if (!data) throw new Error("Updating the announcement returned no data.");
      return data as PlatformAnnouncement;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PLATFORM_ANNOUNCEMENTS_KEY });
      void queryClient.invalidateQueries({ queryKey: PLATFORM_BANNERS_KEY });
    },
  });
}

/** Live banners for the signed-in user; refreshed every few minutes, never retried noisily. */
export function usePlatformBanners(enabled: boolean) {
  return useQuery({
    queryKey: PLATFORM_BANNERS_KEY,
    enabled,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform-banners");
      return ((data as PlatformBannerList | undefined)?.banners ?? []) as PlatformBanner[];
    },
  });
}

function dayStart(value: string): string | undefined {
  return value ? new Date(`${value}T00:00:00`).toISOString() : undefined;
}

function dayEnd(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + 1);
  return date.toISOString();
}

export function useActivityQuery(filters: ActivityFilters) {
  return useInfiniteQuery({
    queryKey: [...PLATFORM_ACTIVITY_KEY, filters],
    initialPageParam: undefined as string | undefined,
    placeholderData: keepPreviousData,
    queryFn: async ({ pageParam }) => {
      const { data } = await api.GET("/api/platform/activity", {
        params: {
          query: {
            limit: ACTIVITY_PAGE_SIZE,
            cursor: pageParam,
            actorId: filters.actorId || undefined,
            action: (filters.action || undefined) as
              | "insert"
              | "update"
              | "delete"
              | "login"
              | "logout"
              | "export"
              | "permission_change"
              | "read"
              | undefined,
            targetTable: filters.targetTable.trim() || undefined,
            schoolId: filters.schoolId || undefined,
            from: dayStart(filters.from),
            to: dayEnd(filters.to),
          },
        },
      });
      if (!data) throw new Error("Activity returned no data.");
      return data as PlatformActivityList;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useOperatorsQuery() {
  return useQuery({
    queryKey: PLATFORM_OPERATORS_KEY,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/activity/operators");
      if (!data) throw new Error("Operators returned no data.");
      return (data as PlatformOperatorList).operators;
    },
  });
}

export function useSystemHealthQuery() {
  return useQuery({
    queryKey: PLATFORM_HEALTH_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/health");
      if (!data) throw new Error("System health returned no data.");
      return data as PlatformSystemHealth;
    },
  });
}

export function useFlagsOverviewQuery() {
  return useQuery({
    queryKey: PLATFORM_FLAGS_OVERVIEW_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/feature-flags");
      if (!data) throw new Error("Feature flags returned no data.");
      return (data as PlatformFlagOverviewList).flags;
    },
  });
}

/** Up to the first 100 schools by name, for the activity log's school filter. */
export function useSchoolOptionsQuery() {
  return useQuery({
    queryKey: [...PLATFORM_KEY, "school-options"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/schools", {
        params: { query: { limit: 100, offset: 0 } },
      });
      if (!data) throw new Error("Schools returned no data.");
      return (data as unknown as { schools: { id: string; name: string }[] }).schools;
    },
  });
}
