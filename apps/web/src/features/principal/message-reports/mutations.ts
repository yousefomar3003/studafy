import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import { MESSAGE_REPORTS_KEY_ROOT } from "./queries";

import type { MessageReport } from "./queries";
import type { components } from "@studafy/api-client";

export type UpdateMessageReportInput = components["schemas"]["UpdateMessageReportBody"];

/**
 * Moves a report along its review workflow (`in_review`, `actioned`, `dismissed`). Invalidates the
 * whole `message-reports` prefix on success *and* failure: a 409
 * `MESSAGE_REPORT_INVALID_TRANSITION` means another reviewer got there first, so the stale view
 * must be refetched either way.
 */
export function useUpdateMessageReport(reportId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateMessageReportInput): Promise<MessageReport> => {
      const { data } = await api.PATCH("/api/messaging/reports/{reportId}", {
        params: { path: { reportId } },
        body: input,
      });
      if (!data) throw new Error("Message report update returned no data.");
      return data.report;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: MESSAGE_REPORTS_KEY_ROOT }),
  });
}
