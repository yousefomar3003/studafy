import { api } from "../../../lib/api";
import { fetchOpenDisciplineIncidents } from "../queries";

import type { DisciplineIncident, DisciplineIncidentStatus } from "../queries";
import type { components } from "@studafy/api-client";

export type { DisciplineIncident, DisciplineIncidentStatus };
export type DisciplineAction = components["schemas"]["DisciplineAction"];

const LIST_LIMIT = 100;

/** "open" fans out to three statuses client-side (see `fetchOpenDisciplineIncidents` in
 * `../queries.ts`); "all" drops the status filter; anything else is one exact status. */
export type IncidentListFilter = "open" | DisciplineIncidentStatus | "all";

export const DISCIPLINE_KEY_ROOT = ["discipline-incidents"] as const;
export const disciplineListKey = (filter: IncidentListFilter) =>
  [...DISCIPLINE_KEY_ROOT, "list", filter] as const;
export const disciplineIncidentKey = (incidentId: string) =>
  [...DISCIPLINE_KEY_ROOT, "detail", incidentId] as const;
export const disciplineActionsKey = (incidentId: string) =>
  [...DISCIPLINE_KEY_ROOT, "actions", incidentId] as const;
export const PARENT_VISIBILITY_KEY = [...DISCIPLINE_KEY_ROOT, "parent-visibility"] as const;

/** Incidents for one list filter, including the teacher-reported inbox (`status: "reported"`) and
 * the dashboard's merged "open" view. Shares its "open" fan-out with the dashboard tile so both
 * agree on what counts as open. */
export async function fetchIncidentsByFilter(
  filter: IncidentListFilter,
): Promise<DisciplineIncident[]> {
  if (filter === "open") {
    const { items } = await fetchOpenDisciplineIncidents(LIST_LIMIT);
    return items;
  }
  const { data } = await api.GET("/api/discipline/incidents", {
    params: {
      query: {
        limit: LIST_LIMIT,
        offset: 0,
        ...(filter === "all" ? {} : { status: filter }),
      },
    },
  });
  // `readonly DisciplineIncident[]` loses its array prototype through the generated response type
  // here — the same pre-existing `@studafy/api-client` typing gap `NotificationBell.tsx` documents
  // for `notifications`. The annotation restores it without widening to `any`.
  return (data?.incidents ?? []) as DisciplineIncident[];
}

export async function fetchIncident(incidentId: string): Promise<DisciplineIncident> {
  const { data } = await api.GET("/api/discipline/incidents/{incidentId}", {
    params: { path: { incidentId } },
  });
  if (!data) throw new Error("Discipline incident fetch returned no data.");
  return data;
}

export async function fetchIncidentActions(incidentId: string): Promise<DisciplineAction[]> {
  const { data } = await api.GET("/api/discipline/incidents/{incidentId}/actions", {
    params: { path: { incidentId } },
  });
  return (data?.actions ?? []) as DisciplineAction[];
}

/** School-wide policy (`app.school_settings.parent_discipline_visibility`, edited on the admin
 * Settings page) gating whether a *resolved* incident becomes visible to the student's parent —
 * not a per-incident flag. Fetched directly rather than through `features/admin/settings/queries`
 * to avoid coupling this module to that page's file layout for the sake of one boolean. */
export async function fetchParentDisciplineVisibility(): Promise<boolean> {
  const { data } = await api.GET("/api/schools/current/settings");
  return data?.parent_discipline_visibility ?? false;
}
