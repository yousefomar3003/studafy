import { useQuery } from "@tanstack/react-query";

import { api } from "../../lib/api";

/** No realtime event is routed for user status changes or attendance marks yet, so these poll. */
const ADMIN_HOME_POLL_MS = 60_000;

/** Local calendar date as YYYY-MM-DD — "today" is what the viewer's clock says, not UTC's. */
function todayDateString(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Invited / active / suspended / archived user counts (`GET /api/users/status-counts`). */
export function useUserStatusCountsQuery() {
  return useQuery({
    queryKey: ["user-status-counts"],
    queryFn: async () => {
      const { data } = await api.GET("/api/users/status-counts");
      return data;
    },
    refetchInterval: ADMIN_HOME_POLL_MS,
  });
}

/**
 * Today's attendance totals: the reports summary endpoint scoped to a single-day range. That
 * endpoint is a scoped report, not a "today" scalar, so callers only read its `totals`.
 */
export function useAttendanceTodayQuery() {
  const today = todayDateString();
  return useQuery({
    queryKey: ["attendance-summary", "today"],
    queryFn: async () => {
      const { data } = await api.GET("/api/attendance/reports/summary", {
        params: { query: { start_date: today, end_date: today, group_by: "class" } },
      });
      return data;
    },
    refetchInterval: ADMIN_HOME_POLL_MS,
  });
}
