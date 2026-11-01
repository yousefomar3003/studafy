import type { AiReportPriority, AiReportStatus } from "./queries";

/** Mirrors `ALLOWED_TRANSITIONS` in apps/api/src/modules/ai/moderation/reports.ts. */
export const AI_REPORT_TRANSITIONS: Record<AiReportStatus, readonly AiReportStatus[]> = {
  pending: ["in_review", "escalated", "actioned", "dismissed"],
  in_review: ["escalated", "actioned", "dismissed"],
  escalated: ["actioned", "dismissed"],
  actioned: [],
  dismissed: [],
};

export const AI_REPORT_STATUSES: readonly AiReportStatus[] = [
  "pending",
  "in_review",
  "escalated",
  "actioned",
  "dismissed",
];

/** The API's `resolution_note` cap. */
export const AI_RESOLUTION_NOTE_MAX_LENGTH = 2000;

export function aiPriorityTone(priority: AiReportPriority): "danger" | "warning" | "neutral" {
  return priority === "urgent" ? "danger" : priority === "high" ? "warning" : "neutral";
}

export function aiStatusTone(status: AiReportStatus): "danger" | "warning" | "success" | "neutral" {
  if (status === "escalated") return "danger";
  if (status === "pending" || status === "in_review") return "warning";
  if (status === "actioned") return "success";
  return "neutral";
}
