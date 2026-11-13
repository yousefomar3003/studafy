import type {
  MessageReportListFilter,
  MessageReportPartyRole,
  MessageReportPriority,
  MessageReportReason,
  MessageReportStatus,
} from "./queries";

// Label maps hold translation keys, not display text — resolve with `t(...)` at render time.

export const MESSAGE_REPORT_STATUS_LABEL_KEYS: Record<MessageReportStatus, string> = {
  pending: "principal.messageReports.status.pending",
  in_review: "principal.messageReports.status.in_review",
  actioned: "principal.messageReports.status.actioned",
  dismissed: "principal.messageReports.status.dismissed",
};

export const MESSAGE_REPORT_PRIORITY_LABEL_KEYS: Record<MessageReportPriority, string> = {
  urgent: "principal.messageReports.priority.urgent",
  high: "principal.messageReports.priority.high",
  normal: "principal.messageReports.priority.normal",
};

export const MESSAGE_REPORT_REASON_LABEL_KEYS: Record<MessageReportReason, string> = {
  harassment: "principal.messageReports.reason.harassment",
  inappropriate: "principal.messageReports.reason.inappropriate",
  spam: "principal.messageReports.reason.spam",
  safety_concern: "principal.messageReports.reason.safety_concern",
  other: "principal.messageReports.reason.other",
};

export const MESSAGE_REPORT_ROLE_LABEL_KEYS: Record<MessageReportPartyRole, string> = {
  parent: "principal.messageReports.role.parent",
  teacher: "principal.messageReports.role.teacher",
};

export const MESSAGE_REPORT_FILTER_OPTION_KEYS: {
  value: MessageReportListFilter;
  labelKey: string;
}[] = [
  { value: "open", labelKey: "principal.messageReports.list.filterOpen" },
  { value: "pending", labelKey: MESSAGE_REPORT_STATUS_LABEL_KEYS.pending },
  { value: "in_review", labelKey: MESSAGE_REPORT_STATUS_LABEL_KEYS.in_review },
  { value: "actioned", labelKey: MESSAGE_REPORT_STATUS_LABEL_KEYS.actioned },
  { value: "dismissed", labelKey: MESSAGE_REPORT_STATUS_LABEL_KEYS.dismissed },
  { value: "all", labelKey: "principal.messageReports.list.filterAll" },
];

export type PillTone = "success" | "warning" | "danger" | "neutral";

export function priorityTone(priority: MessageReportPriority): PillTone {
  if (priority === "urgent") return "danger";
  if (priority === "high") return "warning";
  return "neutral";
}

export function statusTone(status: MessageReportStatus): PillTone {
  if (status === "actioned") return "success";
  if (status === "in_review") return "warning";
  if (status === "pending") return "danger";
  return "neutral";
}

/** Mirrors the API's review state machine (`pending → in_review | actioned | dismissed`,
 * `in_review → actioned | dismissed`; `actioned` and `dismissed` are final), so the detail screen
 * only offers a transition the server will accept. */
export const MESSAGE_REPORT_TRANSITIONS: Record<
  MessageReportStatus,
  readonly Exclude<MessageReportStatus, "pending">[]
> = {
  pending: ["in_review", "actioned", "dismissed"],
  in_review: ["actioned", "dismissed"],
  actioned: [],
  dismissed: [],
};

export const RESOLUTION_NOTE_MAX_LENGTH = 2000;

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", "\u00a0"],
]);

const ENTITY_PATTERN = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g;

/**
 * Decodes the HTML entities the API's sanitizer emits into message bodies (`&amp;` `&lt;` `&gt;`
 * `&quot;` `&apos;` `&nbsp;` and decimal / hex numeric references) in a single pass, so `&amp;lt;`
 * becomes the literal text `&lt;` rather than `<`. Anything unrecognized is left as is. The result
 * is rendered as a React text node — never as HTML. Mirrors the mobile app's `decodeHtmlEntities`.
 */
export function decodeHtmlEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(ENTITY_PATTERN, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1] === "x" || entity[1] === "X";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return match;
      }
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES.get(entity) ?? match;
  });
}
