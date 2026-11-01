import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

export type SchoolPrivacyRequest = components["schemas"]["SchoolDataSubjectRequest"];
export type PrivacyRequestType = SchoolPrivacyRequest["request_type"];

/**
 * The school's data subject requests (`GET /api/privacy/dsr`, `privacy:manageDsr`): every export
 * and erasure filed about one of its people, newest first. Statuses move in the background
 * (the maintenance queue), so the list refetches whenever the page regains focus.
 */
export const PRIVACY_REQUESTS_KEY = ["admin", "privacy-requests"] as const;

export function usePrivacyRequests() {
  return useQuery({
    queryKey: PRIVACY_REQUESTS_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/privacy/dsr", { params: { query: { limit: 200 } } });
      return (data?.requests ?? []) as SchoolPrivacyRequest[];
    },
  });
}

export function useFilePrivacyRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { subject_user_id: string; request_type: PrivacyRequestType }) => {
      const { data } = await api.POST("/api/privacy/dsr", { body });
      if (!data) throw new Error("Filing the request returned no data.");
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PRIVACY_REQUESTS_KEY }),
  });
}

/** A completed export's download link: signed per request and short-lived, so it is fetched only
 * when the admin asks for it, never kept in the list. */
export async function fetchExportDownloadUrl(requestId: string): Promise<string | null> {
  const { data } = await api.GET("/api/privacy/dsr/{requestId}", {
    params: { path: { requestId } },
  });
  return data?.download_url ?? null;
}
