import { useQuery } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

type DataSubjectRequest = components["schemas"]["DataSubjectRequest"];

/**
 * The caller's own data subject request history (`GET /api/privacy/me/dsr`) — used to show
 * whether an export/erasure request is already in flight, so `DeleteAccountPage` doesn't let
 * someone file a second erasure request while one is still queued.
 */
export const SELF_DSR_QUERY_KEY = ["privacy-self-dsr"] as const;

export function useSelfDsrRequestsQuery() {
  return useQuery({
    queryKey: SELF_DSR_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/privacy/me/dsr");
      // A bare-array response body loses its array type through the generated client here — same
      // pre-existing gap `SessionsPage.tsx` documents for `sessions`/`devices` — so this is cast
      // explicitly rather than left to infer as `{}`.
      return (data ?? []) as readonly DataSubjectRequest[];
    },
  });
}
