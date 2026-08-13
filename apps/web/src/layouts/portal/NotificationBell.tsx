import { Button } from "@studafy/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../lib/api";

import { useDisclosure } from "./use-disclosure";

import type { components } from "@studafy/api-client";

const UNREAD_COUNT_QUERY_KEY = ["notifications", "unread-count"];
const RECENT_LIST_QUERY_KEY = ["notifications", "recent"];
const RECENT_LIST_LIMIT = 10;
/**
 * Read-state changes have no realtime push yet (the inbox's read/allRead outbox events have no
 * consumer that fans out to a user's other devices — see the doc comment on `notificationRoutes`),
 * so the count is polled instead.
 */
const UNREAD_COUNT_POLL_MS = 60_000;

/**
 * Notification bell, backed by the real inbox endpoints. No permission gate: the inbox routes are
 * deliberately open to every authenticated session (RLS scopes rows to the caller — see
 * `notificationRoutes`'s doc comment), so every role sees it once signed in.
 *
 * The unread badge is `position: absolute` over a fixed-size trigger (`portal-shell.css`) so a
 * count changing width or appearing/disappearing never reflows the header.
 */
export function NotificationBell() {
  const queryClient = useQueryClient();
  const { open, toggle, triggerRef, panelRef } = useDisclosure();
  const panelId = "portal-notifications-panel";

  const unreadCountQuery = useQuery({
    queryKey: UNREAD_COUNT_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/notifications/unread-count");
      return data;
    },
    refetchInterval: UNREAD_COUNT_POLL_MS,
  });

  const recentQuery = useQuery({
    queryKey: RECENT_LIST_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/notifications", {
        params: { query: { limit: RECENT_LIST_LIMIT } },
      });
      return data;
    },
    enabled: open,
  });

  const invalidateInbox = () => {
    void queryClient.invalidateQueries({ queryKey: ["notifications"] });
  };

  const markAllRead = useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/notifications/read-all");
      return data;
    },
    onSuccess: invalidateInbox,
  });

  const markRead = useMutation({
    mutationFn: async (notificationId: string) => {
      const { data } = await api.POST("/api/notifications/{notificationId}/read", {
        params: { path: { notificationId } },
      });
      return data;
    },
    onSuccess: invalidateInbox,
  });

  const unreadCount = unreadCountQuery.data?.unread_count ?? 0;
  // `readonly Notification[]` loses its array prototype through the generated response type here —
  // a pre-existing `@studafy/api-client` typing gap, not a shape mismatch. The annotation restores
  // it without widening to `any`.
  const notifications = (recentQuery.data?.notifications ??
    []) as readonly components["schemas"]["Notification"][];

  return (
    <div className="portal-notification-bell">
      <button
        ref={triggerRef}
        type="button"
        className="portal-icon-button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <path
            d="M10 2.5c-2.2 0-4 1.8-4 4v2.6c0 .5-.2 1-.5 1.4L4 12.3c-.6.7-.1 1.7.8 1.7h10.4c.9 0 1.4-1 .8-1.7l-1.5-1.8c-.3-.4-.5-.9-.5-1.4V6.5c0-2.2-1.8-4-4-4Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path
            d="M8 15.5a2 2 0 0 0 4 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <span className="sf-visually-hidden">
          Notifications{unreadCount > 0 ? `, ${unreadCount} unread` : ""}
        </span>
        {unreadCount > 0 ? (
          <span className="portal-notification-bell__badge" aria-hidden="true">
            {unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          id={panelId}
          ref={panelRef}
          role="region"
          aria-label="Notifications"
          className="portal-popover portal-notification-panel"
        >
          <div className="portal-notification-panel__header">
            <h2>Notifications</h2>
            <Button
              variant="tertiary"
              disabled={unreadCount === 0}
              loading={markAllRead.isPending}
              onClick={() => markAllRead.mutate()}
            >
              Mark all as read
            </Button>
          </div>

          {recentQuery.isPending ? (
            <p role="status">Loading…</p>
          ) : notifications.length === 0 ? (
            <p>You&rsquo;re all caught up.</p>
          ) : (
            <ul className="portal-notification-list">
              {notifications.map((notification) => (
                <li
                  key={notification.id}
                  className="portal-notification-list__item"
                  data-unread={notification.read_at === null || undefined}
                >
                  <p className="portal-notification-list__title">{notification.title}</p>
                  <p className="portal-notification-list__body">{notification.body}</p>
                  {notification.read_at === null ? (
                    <Button
                      variant="tertiary"
                      loading={markRead.isPending && markRead.variables === notification.id}
                      onClick={() => markRead.mutate(notification.id)}
                    >
                      Mark as read
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
