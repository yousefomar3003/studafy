/**
 * The AI content moderation queue's rules (ST-306): what can be reported, how urgent each report
 * is, when it must be answered by, and which status changes the review workflow allows.
 *
 * Pure -- no I/O. `moderation/persistence.ts` stores what these functions decide, and the routes
 * validate their request bodies against the same tuples, so the API, the database CHECKs
 * (migration 000118), and this file cannot drift apart silently.
 */

/** Every AI output a report can point at. `ask_question` only ever comes from the safety filter. */
export const AI_CONTENT_TYPES = [
  "ask_question",
  "ask_answer",
  "quiz",
  "flashcard_deck",
  "summary",
] as const;
export type AiContentType = (typeof AI_CONTENT_TYPES)[number];

/** The content types a student can report from the app. */
export const REPORTABLE_CONTENT_TYPES = [
  "ask_answer",
  "quiz",
  "flashcard_deck",
  "summary",
] as const satisfies readonly AiContentType[];
export type ReportableContentType = (typeof REPORTABLE_CONTENT_TYPES)[number];

/**
 * Why the item was reported. `child_safety` is also what the safety filter files its escalations
 * under, so the most serious user reports and the filter's catches share one priority lane.
 */
export const REPORT_REASON_CATEGORIES = [
  "child_safety",
  "unsafe",
  "inappropriate",
  "inaccurate",
  "other",
] as const;
export type ReportReasonCategory = (typeof REPORT_REASON_CATEGORIES)[number];

export const REPORT_PRIORITIES = ["urgent", "high", "normal"] as const;
export type ReportPriority = (typeof REPORT_PRIORITIES)[number];

export const REPORT_STATUSES = [
  "pending",
  "in_review",
  "escalated",
  "actioned",
  "dismissed",
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** Statuses still waiting on a moderator; the queue's default view. */
export const OPEN_REPORT_STATUSES: readonly ReportStatus[] = ["pending", "in_review", "escalated"];

const PRIORITY_BY_REASON: Record<ReportReasonCategory, ReportPriority> = {
  child_safety: "urgent",
  unsafe: "high",
  inappropriate: "high",
  inaccurate: "normal",
  other: "normal",
};

/**
 * Response targets per priority, in hours. These are the "timely response" commitment the
 * moderation runbook (docs/ai/content-moderation-runbook.md) publishes to schools; change both
 * together.
 */
export const REPORT_RESPONSE_HOURS: Record<ReportPriority, number> = {
  urgent: 24,
  high: 48,
  normal: 120,
};

export function reportPriority(reason: ReportReasonCategory): ReportPriority {
  // eslint-disable-next-line security/detect-object-injection -- `reason` is typed to the fixed REPORT_REASON_CATEGORIES tuple
  return PRIORITY_BY_REASON[reason];
}

export function reportRespondBy(priority: ReportPriority, now: Date): Date {
  // eslint-disable-next-line security/detect-object-injection -- `priority` is typed to the fixed REPORT_PRIORITIES tuple
  return new Date(now.getTime() + REPORT_RESPONSE_HOURS[priority] * 60 * 60 * 1000);
}

/**
 * The review workflow. `escalated` means handed to an outside authority (see the runbook); it
 * stays open until the moderator records the outcome. `actioned` and `dismissed` are final.
 */
const ALLOWED_TRANSITIONS: Record<ReportStatus, readonly ReportStatus[]> = {
  pending: ["in_review", "escalated", "actioned", "dismissed"],
  in_review: ["escalated", "actioned", "dismissed"],
  escalated: ["actioned", "dismissed"],
  actioned: [],
  dismissed: [],
};

export function canTransitionReport(from: ReportStatus, to: ReportStatus): boolean {
  // eslint-disable-next-line security/detect-object-injection -- `from` is typed to the fixed REPORT_STATUSES tuple
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** ck_ai_content_reports_content_snapshot's length cap. */
export const REPORT_SNAPSHOT_MAX_CHARS = 60_000;

const TRUNCATION_MARKER = "\n[... truncated]";

/** Fit reported text into the snapshot column, marking any cut so a reviewer knows there is more. */
export function toReportSnapshot(text: string): string {
  if (text.length <= REPORT_SNAPSHOT_MAX_CHARS) return text;
  return text.slice(0, REPORT_SNAPSHOT_MAX_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}
