import { useQuery } from "@tanstack/react-query";

import { api } from "../../lib/api";

import type { components } from "@studafy/api-client";
import type { CursorPage } from "@studafy/ui";

export type Notification = components["schemas"]["Notification"];
export type NotificationPreference = components["schemas"]["NotificationPreference"];
export type NotificationPreferences = components["schemas"]["NotificationPreferences"];

// ---------------------------------------------------------------------------
// Unread count — the canonical home for the query the header bell (`NotificationBell`) and this
// feature's own inbox page both read, so a read-state change made on either one updates the
// other's badge on its next poll tick via the shared query key.
//
// Read-state changes have no realtime push yet (the inbox's read/allRead outbox events have no
// consumer that fans out to a user's other devices — see the doc comment on the API's
// `notificationRoutes`), so the count is polled instead, same as `billing/queries.ts`'s overview
// falls back to polling for the same "no routed realtime event yet" reason.
// ---------------------------------------------------------------------------

export const NOTIFICATIONS_QUERY_KEY = ["notifications"] as const;
export const UNREAD_COUNT_QUERY_KEY = [...NOTIFICATIONS_QUERY_KEY, "unread-count"] as const;
const UNREAD_COUNT_POLL_MS = 60_000;

export function useUnreadCountQuery() {
  return useQuery({
    queryKey: UNREAD_COUNT_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/notifications/unread-count");
      return data;
    },
    refetchInterval: UNREAD_COUNT_POLL_MS,
  });
}

// ---------------------------------------------------------------------------
// Inbox list — cursor-paginated with `@studafy/ui`'s `useCursorPagination`, the same contract
// `finance/invoices/InvoiceListPage` and `billing/BillingInvoicesPage` use.
// ---------------------------------------------------------------------------

const INBOX_PAGE_SIZE = 20;

export async function fetchNotificationsPage(
  unreadOnly: boolean,
  cursor: string | undefined,
): Promise<CursorPage<Notification>> {
  const { data } = await api.GET("/api/notifications", {
    params: {
      query: {
        limit: INBOX_PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(unreadOnly ? { unread_only: "true" as const } : {}),
      },
    },
  });
  // A bare list response loses its `Array` prototype through the generated response type — the
  // same pre-existing `@studafy/api-client` typing gap `NotificationBell.tsx` documents.
  const notifications = (data?.notifications ?? []) as readonly Notification[];
  return { items: notifications, nextCursor: data?.next_cursor ?? undefined };
}

// ---------------------------------------------------------------------------
// Preferences (ST-143's matrix, read here for ST-209's preferences screen)
// ---------------------------------------------------------------------------

export const NOTIFICATION_PREFERENCES_QUERY_KEY = ["notification-preferences"] as const;

export function usePreferencesQuery() {
  return useQuery({
    queryKey: NOTIFICATION_PREFERENCES_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/notification-preferences");
      return data;
    },
  });
}
