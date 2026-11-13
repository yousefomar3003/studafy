import type { AuditLogEntry } from "./queries";

export type AuditAction = AuditLogEntry["action"];

/** Mirrors `AUDIT_ACTIONS` in `packages/audit-reporting/src/index.ts` — kept as a literal map
 * (rather than derived) so a new action lands here as a type error, not a silent "insert"-shaped
 * fallback. Values are translation keys (`adminSchool.audit.actions.*`), resolved with `t()` at
 * render time so a runtime language switch re-labels them. */
export const ACTION_LABEL_KEYS: Record<AuditAction, string> = {
  insert: "adminSchool.audit.actions.insert",
  update: "adminSchool.audit.actions.update",
  delete: "adminSchool.audit.actions.delete",
  login: "adminSchool.audit.actions.login",
  logout: "adminSchool.audit.actions.logout",
  export: "adminSchool.audit.actions.export",
  permission_change: "adminSchool.audit.actions.permission_change",
  read: "adminSchool.audit.actions.read",
};

/** The action filter's options as `{ value, labelKey }` — the "all actions" entry first. */
export const ACTION_OPTION_KEYS: { value: AuditAction | ""; labelKey: string }[] = [
  { value: "", labelKey: "adminSchool.audit.allActions" },
  ...(Object.entries(ACTION_LABEL_KEYS) as [AuditAction, string][]).map(([value, labelKey]) => ({
    value,
    labelKey,
  })),
];
