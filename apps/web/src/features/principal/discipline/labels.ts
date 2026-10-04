import type { DisciplineAction, DisciplineIncidentStatus } from "./queries";

export {
  DISCIPLINE_SEVERITY_LABEL_KEYS,
  DISCIPLINE_STATUS_LABEL_KEYS,
  DISCIPLINE_TYPE_LABEL_KEYS,
  severityTone,
} from "../labels";

type DisciplineActionType = DisciplineAction["action_type"];
type DisciplineActionStatus = DisciplineAction["status"];

// Label maps below hold translation keys, not display text — resolve with `t(...)` at render time.

export const DISCIPLINE_ACTION_TYPE_LABEL_KEYS: Record<DisciplineActionType, string> = {
  verbal_warning: "principal.discipline.actionType.verbal_warning",
  written_warning: "principal.discipline.actionType.written_warning",
  detention: "principal.discipline.actionType.detention",
  in_school_suspension: "principal.discipline.actionType.in_school_suspension",
  out_of_school_suspension: "principal.discipline.actionType.out_of_school_suspension",
  expulsion: "principal.discipline.actionType.expulsion",
  parent_meeting: "principal.discipline.actionType.parent_meeting",
  counseling_referral: "principal.discipline.actionType.counseling_referral",
  community_service: "principal.discipline.actionType.community_service",
  other: "principal.discipline.actionType.other",
};

export const DISCIPLINE_ACTION_STATUS_LABEL_KEYS: Record<DisciplineActionStatus, string> = {
  pending: "principal.discipline.actionStatus.pending",
  active: "principal.discipline.actionStatus.active",
  completed: "principal.discipline.actionStatus.completed",
  revoked: "principal.discipline.actionStatus.revoked",
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

/** Button-copy translation key for each transition target. "resolved" is deliberately absent — resolving goes
 * through `ResolveIncidentModal`, gated on having at least one recorded action, rather than a plain
 * status-transition button. */
export const INCIDENT_TRANSITION_LABEL_KEYS: Partial<Record<DisciplineIncidentStatus, string>> = {
  under_review: "principal.discipline.transition.under_review",
  escalated: "principal.discipline.transition.escalated",
  closed: "principal.discipline.transition.closed",
};
