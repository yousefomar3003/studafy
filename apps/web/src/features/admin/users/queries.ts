import { api } from "../../../lib/api";

import type { UserStatus } from "./schema";
import type { components } from "@studafy/api-client";
import type { Role } from "@studafy/constants";
import type { DateRangeValue } from "@studafy/ui";

export type UserWithRoles = components["schemas"]["UserWithRoles"];

export interface UsersFilters {
  search: string;
  /** `""` means "all roles" — not a valid `Role`, so it is stripped to `undefined` before the request. */
  role: Role | "";
  /** `""` means "all statuses". */
  status: UserStatus | "";
  dateRange: DateRangeValue;
}

export const EMPTY_FILTERS: UsersFilters = { search: "", role: "", status: "", dateRange: {} };

/** `YYYY-MM-DD` (FilterBar's format) to the ISO datetime `userListQuerySchema` requires, at a day boundary. */
function toIsoDateBoundary(
  date: string | undefined,
  boundary: "start" | "end",
): string | undefined {
  if (!date) return undefined;
  return boundary === "start" ? `${date}T00:00:00.000Z` : `${date}T23:59:59.999Z`;
}

/** Query-key prefix shared by every cached page of the list, so mutations can invalidate/patch all of them at once. */
export const USERS_LIST_KEY = ["users", "list"] as const;

export function usersListQueryKey(filters: UsersFilters, cursor: string | undefined) {
  return [...USERS_LIST_KEY, filters, cursor] as const;
}

const PAGE_SIZE = 25;

export async function fetchUsersPage(filters: UsersFilters, cursor: string | undefined) {
  const { data } = await api.GET("/api/users", {
    params: {
      query: {
        limit: PAGE_SIZE,
        cursor,
        role: filters.role || undefined,
        status: filters.status || undefined,
        search: filters.search || undefined,
        created_from: toIsoDateBoundary(filters.dateRange.from, "start"),
        created_to: toIsoDateBoundary(filters.dateRange.to, "end"),
      },
    },
  });
  // `readonly UserWithRoles[]` loses its array prototype through the generated response type here —
  // a pre-existing `@studafy/api-client` typing gap (see ApprovalQueuePage/DeviceSessionsPanel), not a
  // shape mismatch. The annotation restores it without widening to `any`.
  return {
    users: (data?.users ?? []) as UserWithRoles[],
    next_cursor: data?.next_cursor ?? null,
  };
}
