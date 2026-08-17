import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";
import type { CursorPage, DateRangeValue } from "@studafy/ui";

export type AuditLogEntry = components["schemas"]["AuditLogEntry"];
export type AuditExportJob = components["schemas"]["AuditExportJob"];
export type UserWithRoles = components["schemas"]["UserWithRoles"];

export interface AuditLogFilters {
  actorId: string;
  action: AuditLogEntry["action"] | "";
  targetTable: string;
  dateRange: DateRangeValue;
}

export const EMPTY_AUDIT_FILTERS: AuditLogFilters = {
  actorId: "",
  action: "",
  targetTable: "",
  dateRange: {},
};

/** `YYYY-MM-DD` (the date inputs' format) to the ISO datetime the query needs, at a day boundary —
 * matches `students/queries.ts`'s `toIsoDateBoundary`, duplicated rather than shared since each
 * admin feature folder is self-contained. */
function toIsoDateBoundary(
  date: string | undefined,
  boundary: "start" | "end",
): string | undefined {
  if (!date) return undefined;
  return boundary === "start" ? `${date}T00:00:00.000Z` : `${date}T23:59:59.999Z`;
}

/** Shared by the list query and the export mutation — both send the same filter shape to their
 * respective `GET`/`POST` endpoints (see `apps/api/src/modules/audit/routes.ts`'s `filterFrom`). */
export function auditFilterQuery(filters: AuditLogFilters) {
  return {
    actor_id: filters.actorId || undefined,
    action: filters.action || undefined,
    target_table: filters.targetTable || undefined,
    from: toIsoDateBoundary(filters.dateRange.from, "start"),
    to: toIsoDateBoundary(filters.dateRange.to, "end"),
  };
}

const PAGE_SIZE = 100;

/** One page of `GET /api/audit/logs`, shaped for `useCursorPagination` — see that hook's doc for
 * why this feature uses it directly instead of the manual cursor-stack/TanStack-Query pattern the
 * students and users lists use: the audit list has no client-side mutation that needs an
 * optimistic cache to patch, so the simpler hook is the correct fit here, not a downgrade. */
export async function fetchAuditLogPage(
  filters: AuditLogFilters,
  cursor: string | undefined,
): Promise<CursorPage<AuditLogEntry>> {
  const { data } = await api.GET("/api/audit/logs", {
    params: { query: { limit: PAGE_SIZE, cursor, ...auditFilterQuery(filters) } },
  });
  return {
    items: (data?.items ?? []) as AuditLogEntry[],
    nextCursor: data?.next_cursor ?? undefined,
  };
}

export function auditExportJobQueryKey(jobId: string) {
  return ["audit", "export", jobId] as const;
}

export async function fetchAuditExportJob(jobId: string): Promise<AuditExportJob> {
  const { data } = await api.GET("/api/audit/logs/export/{jobId}", { params: { path: { jobId } } });
  if (!data) throw new Error("Audit export job not found.");
  return data as AuditExportJob;
}

const ACTOR_SEARCH_LIMIT = 10;

export function actorSearchQueryKey(search: string) {
  return ["users", "search-actors", search] as const;
}

/** Backs the actor filter's search-as-you-type picker (see `ActorFilterField`). Unlike
 * `students/queries.ts`'s `searchParentUsers`, this has no `role` filter — an audit entry's actor
 * can hold any role, including ones deactivated since. */
export async function searchActorUsers(search: string): Promise<UserWithRoles[]> {
  if (!search.trim()) {
    return [];
  }
  const { data } = await api.GET("/api/users", {
    params: { query: { search: search.trim(), limit: ACTOR_SEARCH_LIMIT } },
  });
  return (data?.users ?? []) as UserWithRoles[];
}
