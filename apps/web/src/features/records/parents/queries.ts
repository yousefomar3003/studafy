import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

export type ParentSummary = components["schemas"]["ParentSummary"];
export type ParentList = components["schemas"]["ParentList"];

const PAGE_SIZE = 50;

export const parentDirectoryKey = (search: string) => ["parents", "directory", search] as const;
export const parentSummaryKey = (parentUserId: string) =>
  ["parents", "summary", parentUserId] as const;

/** `GET /api/parents`, a page at a time (needs `user:read`). */
export function useParentDirectory(search: string) {
  return useInfiniteQuery({
    queryKey: parentDirectoryKey(search),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { data } = await api.GET("/api/parents", {
        params: {
          query: {
            limit: PAGE_SIZE,
            ...(pageParam ? { cursor: pageParam } : {}),
            ...(search ? { search } : {}),
          },
        },
      });
      if (!data) throw new Error("The parent list returned no data.");
      return data as ParentList;
    },
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
}

/** `GET /api/parents/{parentUserId}`: one parent's contact details and children. */
export function useParentSummary(parentUserId: string, enabled = true) {
  return useQuery({
    queryKey: parentSummaryKey(parentUserId),
    enabled,
    queryFn: async () => {
      const { data } = await api.GET("/api/parents/{parentUserId}", {
        params: { path: { parentUserId } },
      });
      if (!data) throw new Error("The parent returned no data.");
      return data as ParentSummary;
    },
  });
}
