import type { DisciplineAction, DisciplineIncidentStatus } from "./queries";

export {
  DISCIPLINE_SEVERITY_LABELS,
  DISCIPLINE_STATUS_LABELS,
  DISCIPLINE_TYPE_LABELS,
  severityTone,
} from "../labels";

type DisciplineActionType = DisciplineAction["action_type"];
type DisciplineActionStatus = DisciplineAction["status"];

export const DISCIPLINE_ACTION_TYPE_LABELS: Record<DisciplineActionType, string> = {
  verbal_warning: "Verbal warning",
  written_warning: "Written warning",
  detention: "Detention",
  in_school_suspension: "In-school suspension",
  out_of_school_suspension: "Out-of-school suspension",
  expulsion: "Expulsion",
  parent_meeting: "Parent meeting",
  counseling_referral: "Counseling referral",
  community_service: "Community service",
  other: "Other",
};

export const DISCIPLINE_ACTION_STATUS_LABELS: Record<DisciplineActionStatus, string> = {
  pending: "Pending",
  active: "Active",
  completed: "Completed",
  revoked: "Revoked",
};

/** Mirrors `VALID_INCIDENT_TRANSITIONS` in
 * `apps/api/src/modules/discipline/discipline-service.ts` — kept in sync by hand so the workflow
 * buttons on the detail screen only ever offer a transition the server will actually accept. */
export const INCIDENT_STATUS_TRANSITIONS: Record<
  DisciplineIncidentStatus,
  readonly DisciplineIncidentStatus[]
> = {
  reported: ["under_review", "resolved", "escalated", "closed"],
  under_review: ["resolved", "escalated", "closed"],
  resolved: ["closed"],
  escalated: ["under_review", "resolved", "closed"],
  closed: [],
};

/** Button copy for each transition target. "resolved" is deliberately absent — resolving goes
 * through `ResolveIncidentModal`, gated on having at least one recorded action, rather than a plain
 * status-transition button. */
export const INCIDENT_TRANSITION_LABELS: Partial<Record<DisciplineIncidentStatus, string>> = {
  under_review: "Start review",
  escalated: "Escalate",
  closed: "Close",
};
