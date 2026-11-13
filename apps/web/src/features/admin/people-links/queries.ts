import { api } from "../../../lib/api";
import { FAMILIES_KEY } from "../../finance/families/queries";

import type { components } from "@studafy/api-client";
import type { QueryClient } from "@tanstack/react-query";

export type StudentProfile = components["schemas"]["StudentProfile"];
export type Family = components["schemas"]["Family"];

// The parent search is LinkGuardianModal's own (`../students/queries.ts`); these are its siblings
// for the other two things a link can need staff to pick: a student and a household.

const SEARCH_LIMIT = 10;

export function studentSearchQueryKey(search: string) {
  return ["students", "search-to-link", search] as const;
}

/** Students matching what staff typed (name or admission number), for picking a parent's child. */
export async function searchStudents(search: string): Promise<StudentProfile[]> {
  if (!search.trim()) return [];
  const { data } = await api.GET("/api/students", {
    params: { query: { search: search.trim(), limit: SEARCH_LIMIT } },
  });
  return (data?.students ?? []) as StudentProfile[];
}

export function familySearchQueryKey(search: string) {
  return ["families", "search", search] as const;
}

/** Households by name, for adding a guardian to an existing family instead of their own. */
export async function searchFamilies(search: string): Promise<Family[]> {
  if (!search.trim()) return [];
  const { data } = await api.GET("/api/families", {
    params: { query: { search: search.trim(), limit: SEARCH_LIMIT } },
  });
  return (data?.families ?? []) as Family[];
}

/** The finance "unlinked" lists and counts (`features/finance/unlinked`). */
export const UNLINKED_KEY = ["finance", "unlinked"] as const;

/** After a link is made: the unlinked lists, finance's families and the household search change. */
export function invalidateLinkViews(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: UNLINKED_KEY });
  void queryClient.invalidateQueries({ queryKey: FAMILIES_KEY });
  void queryClient.invalidateQueries({ queryKey: ["families"] });
}
