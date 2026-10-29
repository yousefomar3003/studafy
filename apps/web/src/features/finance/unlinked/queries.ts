import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";
import { invalidateLinkViews, UNLINKED_KEY } from "../../admin/people-links/queries";

import type { GuardianRelationship } from "../../admin/students/schema";
import type { components } from "@studafy/api-client";

// Restated with plain arrays, as `../families/queries.ts` does, because the generated `readonly`
// arrays lose their array prototype through `api.GET`'s response typing.

export type UnlinkedStudent = components["schemas"]["FinanceUnlinkedStudent"];
export type UnlinkedParent = components["schemas"]["FinanceUnlinkedParent"];
export type UnlinkedSummary = components["schemas"]["FinanceUnlinkedSummary"];

export const UNLINKED_PAGE_SIZE = 20;

export { UNLINKED_KEY };

export async function fetchUnlinkedStudents(
  search: string,
  offset: number,
): Promise<{ items: UnlinkedStudent[]; total: number }> {
  const { data } = await api.GET("/api/finance/unlinked/students", {
    params: {
      query: { search: search.trim() || undefined, limit: UNLINKED_PAGE_SIZE, offset },
    },
  });
  return { items: (data?.students ?? []) as UnlinkedStudent[], total: data?.total ?? 0 };
}

export async function fetchUnlinkedParents(
  search: string,
  offset: number,
): Promise<{ items: UnlinkedParent[]; total: number }> {
  const { data } = await api.GET("/api/finance/unlinked/parents", {
    params: {
      query: { search: search.trim() || undefined, limit: UNLINKED_PAGE_SIZE, offset },
    },
  });
  return { items: (data?.parents ?? []) as UnlinkedParent[], total: data?.total ?? 0 };
}

export async function fetchUnlinkedSummary(): Promise<UnlinkedSummary> {
  const { data } = await api.GET("/api/finance/unlinked/summary");
  return data ?? { students: 0, parents: 0 };
}

export interface LinkChildrenVariables {
  parentUserId: string;
  children: { studentId: string; relationship: GuardianRelationship }[];
}

/**
 * Links an existing parent to the children staff picked, one `POST /api/students/{id}/guardians`
 * each (`student:update`) -- the Guardians tab's own call, so each link is checked and audited the
 * same way and joins the parent's household. Stops at the first failure and reports how many were
 * linked before it; the ones already made stay.
 */
export function useLinkChildren() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ parentUserId, children }: LinkChildrenVariables) => {
      let linked = 0;
      try {
        for (const child of children) {
          await api.POST("/api/students/{studentId}/guardians", {
            params: { path: { studentId: child.studentId } },
            body: { parent_user_id: parentUserId, relationship: child.relationship },
          });
          linked += 1;
        }
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { linked });
      }
      return { linked };
    },
    onSettled: () => {
      invalidateLinkViews(queryClient);
      void queryClient.invalidateQueries({ queryKey: ["students", "detail"] });
    },
  });
}
