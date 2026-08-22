import { Button } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { useMarkAllRead, useMarkNotificationRead } from "../../features/notifications/mutations";
import { useUnreadCountQuery } from "../../features/notifications/queries";
import { api } from "../../lib/api";

import { useDisclosure } from "./use-disclosure";

import type { Notification } from "../../features/notifications/queries";

const RECENT_LIST_QUERY_KEY = ["notifications", "recent"];
const RECENT_LIST_LIMIT = 10;

/**
 * Notification bell, backed by the real inbox endpoints. No permission gate: the inbox routes are
 * deliberately open to every authenticated session (RLS scopes rows to the caller — see
 * `notificationRoutes`'s doc comment), so every role sees it once signed in.
 *
 * The unread count and the two read-state mutations are the same ones the full inbox
 * (`features/notifications/NotificationInboxPage`) uses — sharing the query/mutation hooks from
 * `features/notifications` means a read-state change made on either surface invalidates the same
 * cache entry the other reads from. Only this preview list's own small "recent" query stays local:
 * it is a distinct shape (a fixed-size, always-newest preview fetched on open) from the inbox's
 * cursor-paginated, filterable list.
 *
 * The unread badge is `position: absolute` over a fixed-size trigger (`portal-shell.css`) so a
 * count changing width or appearing/disappearing never reflows the header.
 */
export function NotificationBell() {
  const { open, toggle, close, triggerRef, panelRef } = useDisclosure();
  const panelId = "portal-notifications-panel";

  const unreadCountQuery = useUnreadCountQuery();

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

  const markAllRead = useMarkAllRead();
  const markRead = useMarkNotificationRead();

  const unreadCount = unreadCountQuery.data?.unread_count ?? 0;
  // `readonly Notification[]` loses its array prototype through the generated response type here —
  // a pre-existing `@studafy/api-client` typing gap, not a shape mismatch. The annotation restores
  // it without widening to `any`.
  const notifications = (recentQuery.data?.notifications ?? []) as readonly Notification[];

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

          <div className="portal-notification-panel__footer">
            <Link to="/portal/notifications" onClick={close}>
              View all notifications
            </Link>
            <Link to="/portal/notifications/preferences" onClick={close}>
              Notification settings
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
