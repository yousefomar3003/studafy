import { api } from "../../lib/api";

import type { components } from "@studafy/api-client";

export type DisciplineIncident = components["schemas"]["DisciplineIncident"];
export type DisciplineIncidentStatus = DisciplineIncident["status"];

/** Non-terminal incident statuses — what "open" means for this dashboard. `resolved` and `closed`
 * are done; everything else still needs a principal's attention. */
export const OPEN_DISCIPLINE_STATUSES: readonly DisciplineIncidentStatus[] = [
  "reported",
  "under_review",
  "escalated",
];

async function fetchIncidentsByStatus(
  status: DisciplineIncidentStatus,
  limit: number,
): Promise<{ items: DisciplineIncident[]; total: number }> {
  const { data } = await api.GET("/api/discipline/incidents", {
    params: { query: { status, limit, offset: 0 } },
  });
  // `readonly DisciplineIncident[]` loses its array prototype through the generated response type
  // here — the same pre-existing `@studafy/api-client` typing gap `NotificationBell.tsx` documents
  // for `notifications`. The annotation restores it without widening to `any`.
  return {
    items: (data?.incidents ?? []) as DisciplineIncident[],
    total: data?.total ?? 0,
  };
}

/**
 * "Open" spans three statuses (reported / under_review / escalated), but
 * `GET /api/discipline/incidents` only filters on one status at a time (see
 * `disciplineIncidentQuerySchema` in `apps/api/src/modules/discipline/schemas.ts`) — there's no
 * server-side "not resolved and not closed" filter. This fans out one request per open status and
 * merges client-side. `total` is exact (each sub-request's count is a true filtered COUNT(*),
 * unaffected by its own limit — see `listIncidents` in `discipline-service.ts`); the merged `items`
 * are accurate as long as `limit` covers every open incident newer than the merge cutoff, which
 * holds for a dashboard preview or a single-page detail list at the sizes this calls with.
 */
export async function fetchOpenDisciplineIncidents(
  limit: number,
): Promise<{ items: DisciplineIncident[]; total: number }> {
  const pages = await Promise.all(
    OPEN_DISCIPLINE_STATUSES.map((status) => fetchIncidentsByStatus(status, limit)),
  );

  const items = pages
    .flatMap((page) => page.items)
    .sort((a, b) => b.incident_at.localeCompare(a.incident_at))
    .slice(0, limit);
  const total = pages.reduce((sum, page) => sum + page.total, 0);

  return { items, total };
}

export type ClassAttendanceSummaryItem = Extract<
  components["schemas"]["AttendanceReportSummary"]["items"][number],
  { group_by: "class" }
>;

export interface DateRange {
  startDate: string;
  endDate: string;
}

/** Local calendar date as YYYY-MM-DD — "today" is what the viewer's clock says, not UTC's. */
function dateString(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Rolling `days`-day window ending today, inclusive on both ends. */
export function lastNDaysRange(days: number): DateRange {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (days - 1));
  return { startDate: dateString(start), endDate: dateString(end) };
}

/** Per-class attendance summary for a date range — backs both the heat map tile and its detail
 * page. `group_by: "class"` items are the only kind the discriminated union can return here. */
export async function fetchClassAttendanceSummary(
  range: DateRange,
  classId?: string,
): Promise<ClassAttendanceSummaryItem[]> {
  const { data } = await api.GET("/api/attendance/reports/summary", {
    params: {
      query: {
        start_date: range.startDate,
        end_date: range.endDate,
        group_by: "class",
        limit: 100,
        ...(classId ? { class_id: classId } : {}),
      },
    },
  });
  // `readonly ...Item[]` loses its array prototype through the generated response type here — the
  // same pre-existing `@studafy/api-client` typing gap `NotificationBell.tsx` documents for
  // `notifications`. The annotation restores it without widening to `any`.
  const items = (data?.items ?? []) as ClassAttendanceSummaryItem[];
  return items;
}
