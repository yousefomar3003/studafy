import type { DisciplineIncidentStatus } from "./queries";
import type { components } from "@studafy/api-client";

type DisciplineSeverity = components["schemas"]["DisciplineIncident"]["severity"];
type DisciplineIncidentType = components["schemas"]["DisciplineIncident"]["incident_type"];

export const DISCIPLINE_TYPE_LABELS: Record<DisciplineIncidentType, string> = {
  behavioral: "Behavioral",
  academic_integrity: "Academic integrity",
  attendance: "Attendance",
  bullying: "Bullying",
  substance: "Substance",
  vandalism: "Vandalism",
  safety: "Safety",
  other: "Other",
};

export const DISCIPLINE_STATUS_LABELS: Record<DisciplineIncidentStatus, string> = {
  reported: "Reported",
  under_review: "Under review",
  resolved: "Resolved",
  escalated: "Escalated",
  closed: "Closed",
};

export const DISCIPLINE_SEVERITY_LABELS: Record<DisciplineSeverity, string> = {
  minor: "Minor",
  moderate: "Moderate",
  major: "Major",
  critical: "Critical",
};

/** `dashboard-tile__status-pill` / `sf-chip`-style tone for a severity level. */
export function severityTone(severity: DisciplineSeverity): "success" | "warning" | "danger" {
  if (severity === "critical" || severity === "major") return "danger";
  if (severity === "moderate") return "warning";
  return "success";
}
