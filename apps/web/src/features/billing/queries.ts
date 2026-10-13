import { useQuery } from "@tanstack/react-query";

import { api } from "../../lib/api";

import type { components } from "@studafy/api-client";

export type BillingOverview = components["schemas"]["BillingOverview"];

// ---------------------------------------------------------------------------
// Overview — the school's subscription row, read by the admin dashboard's `StorageUsageTile` for
// storage used against the plan's cap. Schools no longer pay for a plan (migration 000126), so
// nothing on the web shows the plan itself.
// ---------------------------------------------------------------------------

export const BILLING_OVERVIEW_QUERY_KEY = ["billing-overview"];

/**
 * No realtime event is routed for billing or storage changes yet (see
 * apps/realtime/src/event-routing.ts — only grades.published is routed today), so the storage
 * tile polls instead, same fallback NotificationBell uses for its unread count.
 */
const BILLING_OVERVIEW_POLL_MS = 60_000;

/** The admin dashboard's `StorageUsageTile` reads storage usage from here. */
export function useBillingOverviewQuery() {
  return useQuery({
    queryKey: BILLING_OVERVIEW_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/subscriptions/current");
      return data;
    },
    refetchInterval: BILLING_OVERVIEW_POLL_MS,
  });
}

// ---------------------------------------------------------------------------
// AI subscription purchase (ST-208) — the student named in the purchase page's own deep-link query
// params. Reads `GET /api/students/{studentId}` directly rather than importing
// `features/admin/students/queries.ts`'s `fetchStudent`: that module is the admin student directory
// (CSV import, guardian links, enrollment history) that a parent/student session viewing this page
// has no business pulling in for one profile lookup.
// ---------------------------------------------------------------------------

export type AiCheckoutStudent = components["schemas"]["StudentProfile"];

export function aiCheckoutStudentQueryKey(studentId: string) {
  return ["ai-checkout", "student", studentId] as const;
}

export async function fetchAiCheckoutStudent(studentId: string): Promise<AiCheckoutStudent> {
  const { data } = await api.GET("/api/students/{studentId}", { params: { path: { studentId } } });
  if (!data) throw new Error("Student not found.");
  return data as AiCheckoutStudent;
}
