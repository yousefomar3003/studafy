import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import { SELF_DSR_QUERY_KEY } from "./queries";

import type { components } from "@studafy/api-client";

type DsrRequestType = components["schemas"]["CreateSelfDataSubjectRequestBody"]["request_type"];

/**
 * Files a self-service GDPR export or erasure request (`POST /api/privacy/me/dsr`) — the caller is
 * always the subject; there is no id to pass. Used by `DeleteAccountPage` for account deletion, and
 * reusable for a "download my data" export action without any new plumbing.
 */
export function useFileSelfDsrRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (requestType: DsrRequestType) => {
      const { data } = await api.POST("/api/privacy/me/dsr", {
        body: { request_type: requestType },
      });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SELF_DSR_QUERY_KEY });
    },
  });
}
