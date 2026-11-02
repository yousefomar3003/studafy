import type { DisciplineIncidentStatus } from "./queries";
import type { components } from "@studafy/api-client";

type DisciplineSeverity = components["schemas"]["DisciplineIncident"]["severity"];
type DisciplineIncidentType = components["schemas"]["DisciplineIncident"]["incident_type"];

// Translation keys (not display text) — resolve with `t(...)` at render time so the label follows
// the active locale.

export const DISCIPLINE_TYPE_LABEL_KEYS: Record<DisciplineIncidentType, string> = {
  behavioral: "principal.discipline.type.behavioral",
  academic_integrity: "principal.discipline.type.academic_integrity",
  attendance: "principal.discipline.type.attendance",
  bullying: "principal.discipline.type.bullying",
  substance: "principal.discipline.type.substance",
  vandalism: "principal.discipline.type.vandalism",
  safety: "principal.discipline.type.safety",
  other: "principal.discipline.type.other",
};

export const DISCIPLINE_STATUS_LABEL_KEYS: Record<DisciplineIncidentStatus, string> = {
  reported: "principal.discipline.status.reported",
  under_review: "principal.discipline.status.under_review",
  resolved: "principal.discipline.status.resolved",
  escalated: "principal.discipline.status.escalated",
  closed: "principal.discipline.status.closed",
};

export const DISCIPLINE_SEVERITY_LABEL_KEYS: Record<DisciplineSeverity, string> = {
  minor: "principal.discipline.severity.minor",
  moderate: "principal.discipline.severity.moderate",
  major: "principal.discipline.severity.major",
  critical: "principal.discipline.severity.critical",
};

/** `dashboard-tile__status-pill` / `sf-chip`-style tone for a severity level. */
export function severityTone(severity: DisciplineSeverity): "success" | "warning" | "danger" {
  if (severity === "critical" || severity === "major") return "danger";
  if (severity === "moderate") return "warning";
  return "success";
}
