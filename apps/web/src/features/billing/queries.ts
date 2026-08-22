import { useQuery } from "@tanstack/react-query";

import { api } from "../../lib/api";

import type { components, operations } from "@studafy/api-client";
import type { CursorPage } from "@studafy/ui";

export type BillingOverview = components["schemas"]["BillingOverview"];
export type SubscriptionCancellationState = components["schemas"]["SubscriptionCancellationState"];
export type BillingInvoice = components["schemas"]["BillingInvoiceList"]["invoices"][number];

// No named schema for a plan (plan-routes.ts inlines the response), same as the marketing pricing
// page's own `PricingPage.tsx` — the element type is pulled from the operation's response instead of
// `components["schemas"]`.
export type SubscriptionPlan =
  operations["listSubscriptionPlans"]["responses"][200]["content"]["application/json"][number];

// ---------------------------------------------------------------------------
// Overview — moved here from `admin/billing-overview-query.ts` (ST-207): this feature is now the
// canonical home for subscription state, and `SubscriptionStatusBanner`/`StorageUsageTile` on the
// admin dashboard import this same hook rather than each dashboard re-querying it.
// ---------------------------------------------------------------------------

export const BILLING_OVERVIEW_QUERY_KEY = ["billing-overview"];

/**
 * No realtime event is routed for billing or storage changes yet (see
 * apps/realtime/src/event-routing.ts — only grades.published is routed today), so the subscription
 * banner and storage tile poll instead, same fallback NotificationBell uses for its unread count.
 */
const BILLING_OVERVIEW_POLL_MS = 60_000;

/**
 * Shared by every billing-overview reader (this feature's own pages, plus the admin dashboard's
 * `SubscriptionStatusBanner` and `StorageUsageTile`) — one query key lets TanStack Query dedupe the
 * request between them.
 */
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
// Plans — checkout entry reads the same public catalog the marketing pricing page does.
// ---------------------------------------------------------------------------

export const BILLING_PLANS_QUERY_KEY = ["billing-plans"];

export async function fetchBillingPlans(): Promise<readonly SubscriptionPlan[]> {
  const { data } = await api.GET("/api/subscriptions/plans");
  // A bare top-level array response loses its `Array` prototype through the generated response
  // type — the same pre-existing `@studafy/api-client` typing gap `PricingPage.tsx` documents.
  return (data ?? []) as readonly SubscriptionPlan[];
}

// ---------------------------------------------------------------------------
// Invoices — read straight from the payment provider (Studafy keeps no local copy), paginated with
// `@studafy/ui`'s `useCursorPagination` the same way `finance/invoices/InvoiceListPage` is, adapting
// Stripe's `starting_after`/`has_more` shape to the hook's `nextCursor` contract.
// ---------------------------------------------------------------------------

const INVOICES_PAGE_SIZE = 10;

export async function fetchInvoicesPage(
  cursor: string | undefined,
): Promise<CursorPage<BillingInvoice>> {
  const { data } = await api.GET("/api/subscriptions/current/invoices", {
    params: { query: { limit: INVOICES_PAGE_SIZE, startingAfter: cursor } },
  });
  const invoices = (data?.invoices ?? []) as BillingInvoice[];
  const last = invoices.at(-1);
  return {
    items: invoices,
    nextCursor: data?.hasMore && last ? last.id : undefined,
  };
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
