import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

export type MemberListItem = components["schemas"]["UserListItem"];

/** The roles issued a member ID (000140/000141), with their ID prefix. */
export const MEMBER_KINDS = [
  { role: "STUDENT", prefix: "STU", countKey: "students" },
  { role: "INSTRUCTOR", prefix: "TCH", countKey: "teachers" },
  { role: "PARENT", prefix: "PAR", countKey: "parents" },
  { role: "ATTENDANCE_OFFICER", prefix: "ATT", countKey: "attendance_officers" },
] as const;

export type MemberRole = (typeof MEMBER_KINDS)[number]["role"];

const PAGE_SIZE = 25;

export function useMemberSummaryQuery() {
  return useQuery({
    queryKey: ["users", "member-summary"],
    queryFn: async () => {
      const { data } = await api.GET("/api/users/member-summary");
      return data!;
    },
  });
}

export function useMembersPageQuery(role: MemberRole, search: string, cursor: string | undefined) {
  return useQuery({
    queryKey: ["users", "members", role, search, cursor],
    queryFn: async () => {
      const { data } = await api.GET("/api/users", {
        params: { query: { role, search: search || undefined, cursor, limit: PAGE_SIZE } },
      });
      // Same generated readonly-array typing gap as `admin/users/queries.ts`.
      return {
        users: (data?.users ?? []) as MemberListItem[],
        next_cursor: data?.next_cursor ?? null,
      };
    },
    placeholderData: keepPreviousData,
  });
}
