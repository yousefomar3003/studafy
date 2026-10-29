import { useQuery } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

export type RecordMissingIssue = components["schemas"]["RecordMissingIssue"];
export type RecordMissingField = components["schemas"]["RecordMissingField"];
export type RecordMissingSummary = components["schemas"]["RecordMissingSummary"];
// Restated with plain arrays, as `../../finance/unlinked/queries.ts` does, because the generated
// `readonly` arrays lose their array prototype through `api.GET`'s response typing.
interface Issues {
  missing: RecordMissingField[];
  expired: RecordMissingField[];
  expiring: RecordMissingField[];
}
export type RecordMissingStudent = Omit<
  components["schemas"]["RecordMissingStudent"],
  keyof Issues
> &
  Issues;
export type RecordMissingParent = Omit<components["schemas"]["RecordMissingParent"], keyof Issues> &
  Issues;

export const MISSING_PAGE_SIZE = 20;
export const MISSING_KEY = ["records", "missing"] as const;
export const MISSING_SUMMARY_KEY = [...MISSING_KEY, "summary"] as const;

export interface MissingPage<T> {
  items: T[];
  total: number;
}

function query(search: string, issue: RecordMissingIssue | null, offset: number) {
  return {
    search: search.trim() || undefined,
    issue: issue ?? undefined,
    limit: MISSING_PAGE_SIZE,
    offset,
  };
}

export async function fetchMissingStudents(
  search: string,
  issue: RecordMissingIssue | null,
  offset: number,
): Promise<MissingPage<RecordMissingStudent>> {
  const { data } = await api.GET("/api/records/missing/students", {
    params: { query: query(search, issue, offset) },
  });
  return { items: (data?.students ?? []) as RecordMissingStudent[], total: data?.total ?? 0 };
}

export async function fetchMissingParents(
  search: string,
  issue: RecordMissingIssue | null,
  offset: number,
): Promise<MissingPage<RecordMissingParent>> {
  const { data } = await api.GET("/api/records/missing/parents", {
    params: { query: query(search, issue, offset) },
  });
  return { items: (data?.parents ?? []) as RecordMissingParent[], total: data?.total ?? 0 };
}

const EMPTY_SUMMARY: RecordMissingSummary = {
  students: 0,
  parents: 0,
  expired_documents: 0,
  expiring_documents: 0,
};

export async function fetchMissingSummary(): Promise<RecordMissingSummary> {
  const { data } = await api.GET("/api/records/missing/summary");
  return data ?? EMPTY_SUMMARY;
}

/** The dashboard count. Only fetched for sessions holding `studentRecord:read`. */
export function useMissingSummaryQuery(enabled: boolean) {
  return useQuery({ queryKey: MISSING_SUMMARY_KEY, queryFn: fetchMissingSummary, enabled });
}
