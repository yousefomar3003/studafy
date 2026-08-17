import type { AuditLogEntry } from "./queries";
import type { SelectOption } from "@studafy/ui";

export type AuditAction = AuditLogEntry["action"];

/** Mirrors `AUDIT_ACTIONS` in `packages/audit-reporting/src/index.ts` — kept as a literal map
 * (rather than derived) so a new action lands here as a type error, not a silent "insert"-shaped
 * fallback. */
export const ACTION_LABELS: Record<AuditAction, string> = {
  insert: "Created",
  update: "Updated",
  delete: "Deleted",
  login: "Logged in",
  logout: "Logged out",
  export: "Exported",
  permission_change: "Permission changed",
  read: "Viewed",
};

export const ACTION_OPTIONS: SelectOption<AuditAction | "">[] = [
  { value: "", label: "All actions" },
  ...(Object.entries(ACTION_LABELS) as [AuditAction, string][]).map(([value, label]) => ({
    value,
    label,
  })),
];
