import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

export type MessageReport = components["schemas"]["MessageReport"];
export type MessageReportDetail = components["schemas"]["MessageReportDetail"];
export type MessageReportEvidenceMessage = components["schemas"]["MessageReportEvidenceMessage"];
export type MessageReportEvidenceAttachment =
  components["schemas"]["MessageReportEvidenceAttachment"];
export type MessageReportStatus = MessageReport["status"];
export type MessageReportPriority = MessageReport["priority"];
export type MessageReportReason = MessageReport["reason_category"];
export type MessageReportPartyRole = MessageReport["reporter"]["role"];

/** "open" is the server's own pending + in_review filter; "all" omits the status parameter. */
export type MessageReportListFilter = MessageReportStatus | "open" | "all";

export const MESSAGE_REPORTS_PAGE_SIZE = 25;

/** Every query below keys off this root, so one invalidation after a review action refreshes the
 * list, the detail view and the dashboard tile together. */
export const MESSAGE_REPORTS_KEY_ROOT = ["message-reports"] as const;
export const messageReportListKey = (filter: MessageReportListFilter, offset: number) =>
  [...MESSAGE_REPORTS_KEY_ROOT, "list", filter, offset] as const;
export const messageReportKey = (reportId: string) =>
  [...MESSAGE_REPORTS_KEY_ROOT, "detail", reportId] as const;
export const messageReportTileKey = (limit: number) =>
  [...MESSAGE_REPORTS_KEY_ROOT, "tile", limit] as const;

export interface MessageReportPage {
  reports: MessageReport[];
  total: number;
}

/** One page of the review queue, already ordered by the server (open first, then priority, then
 * soonest `respond_by`). */
export async function fetchMessageReports(
  filter: MessageReportListFilter,
  offset: number,
  limit: number = MESSAGE_REPORTS_PAGE_SIZE,
): Promise<MessageReportPage> {
  const { data } = await api.GET("/api/messaging/reports", {
    params: {
      query: {
        limit,
        offset,
        ...(filter === "all" ? {} : { status: filter }),
      },
    },
  });
  // Same readonly-array typing gap the discipline queries document; the annotation restores the
  // array prototype without widening to `any`.
  return {
    reports: (data?.reports ?? []) as MessageReport[],
    total: data?.total ?? 0,
  };
}

/** One report with its evidence transcript (oldest first). Attachment `download_url`s are
 * pre-signed for five minutes, so refetching this query is how the page refreshes them. */
export async function fetchMessageReport(reportId: string): Promise<MessageReportDetail> {
  const { data } = await api.GET("/api/messaging/reports/{reportId}", {
    params: { path: { reportId } },
  });
  if (!data) throw new Error("Message report fetch returned no data.");
  // The readonly `messages` array hits the same generated-type gap as above.
  return data.report as MessageReportDetail;
}
