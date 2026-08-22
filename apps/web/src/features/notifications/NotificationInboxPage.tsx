import { Button, useCursorPagination } from "@studafy/ui";
import { useCallback, useState } from "react";
import { Link } from "react-router-dom";

import { notificationTypeLabel } from "./labels";
import { useMarkAllRead, useMarkNotificationRead } from "./mutations";
import { fetchNotificationsPage } from "./queries";

import "./notifications.css";

type InboxFilter = "all" | "unread";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/**
 * Full notification inbox (`/portal/notifications`). No permission gate — mirrors the API's own
 * posture (see `notificationRoutes`'s doc comment): RLS scopes every row to the caller regardless
 * of role, so there is no permission to check.
 *
 * Cursor-paginated with the same `useCursorPagination` contract `finance/invoices/InvoiceListPage`
 * and `billing/BillingInvoicesPage` use. Switching the All/Unread filter changes `fetchPage`'s
 * identity (the hook's cache key), which resets back to the first page by design — see the hook's
 * own doc comment.
 *
 * The unread badge in the header bell (`layouts/portal/NotificationBell`) polls the same
 * `useUnreadCountQuery` this page's mutations invalidate, so marking read here updates the badge on
 * its next poll tick.
 */
export default function NotificationInboxPage() {
  const [filter, setFilter] = useState<InboxFilter>("all");
  const fetchPage = useCallback(
    (cursor: string | undefined) => fetchNotificationsPage(filter === "unread", cursor),
    [filter],
  );
  const { items, loading, error, hasNextPage, hasPreviousPage, goToNextPage, goToPreviousPage } =
    useCursorPagination(fetchPage);

  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllRead();

  const hasUnread = items.some((notification) => notification.read_at === null);

  return (
    <>
      <div className="notifications-page__header">
        <div>
          <h1>Notifications</h1>
          <p>Everything sent to you, newest first.</p>
        </div>
        <Link to="/portal/notifications/preferences">
          <Button type="button" variant="secondary">
            Notification settings
          </Button>
        </Link>
      </div>

      <div className="notifications-page__toolbar">
        <div className="notifications-page__filters" role="group" aria-label="Filter notifications">
          <Button
            type="button"
            variant={filter === "all" ? "primary" : "tertiary"}
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            All
          </Button>
          <Button
            type="button"
            variant={filter === "unread" ? "primary" : "tertiary"}
            aria-pressed={filter === "unread"}
            onClick={() => setFilter("unread")}
          >
            Unread
          </Button>
        </div>

        <Button
          type="button"
          variant="tertiary"
          disabled={!hasUnread}
          loading={markAllRead.isPending}
          onClick={() => markAllRead.mutate()}
        >
          Mark all as read
        </Button>
      </div>

      {error ? (
        <p className="notifications-page__notice" role="alert">
          Unable to load notifications. Try reloading the page.
        </p>
      ) : null}

      {loading ? (
        <p role="status">Loading…</p>
      ) : items.length === 0 ? (
        <p>{filter === "unread" ? "No unread notifications." : "You’re all caught up."}</p>
      ) : (
        <ul className="notifications-page__list">
          {items.map((notification) => (
            <li
              key={notification.id}
              className="notifications-page__item"
              data-unread={notification.read_at === null || undefined}
            >
              <div className="notifications-page__item-body">
                <p className="notifications-page__item-type">
                  {notificationTypeLabel(notification.notification_type)}
                </p>
                <p className="notifications-page__item-title">{notification.title}</p>
                <p className="notifications-page__item-text">{notification.body}</p>
                <p className="notifications-page__item-date">
                  {formatDateTime(notification.created_at)}
                </p>
              </div>
              {notification.read_at === null ? (
                <Button
                  type="button"
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

      <div className="notifications-page__pagination">
        <Button
          type="button"
          variant="secondary"
          disabled={!hasPreviousPage}
          onClick={goToPreviousPage}
        >
          Previous
        </Button>
        <Button type="button" variant="secondary" disabled={!hasNextPage} onClick={goToNextPage}>
          Next
        </Button>
      </div>
    </>
  );
}
