import { Button, useCursorPagination } from "@studafy/ui";
import { useCallback, useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../lib/i18n";

import { notificationTypeLabel } from "./labels";
import { useMarkAllRead, useMarkNotificationRead } from "./mutations";
import { fetchNotificationsPage } from "./queries";

import "./notifications.css";

type InboxFilter = "all" | "unread";

/** Same fields `Date#toLocaleString()` shows by default, but in the active app locale. */
const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
};

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
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
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
          <h1>{t("site.notifications.inbox.title")}</h1>
          <p>{t("site.notifications.inbox.description")}</p>
        </div>
        <Link to="/portal/notifications/preferences">
          <Button type="button" variant="secondary">
            {t("site.notifications.inbox.settings")}
          </Button>
        </Link>
      </div>

      <div className="notifications-page__toolbar">
        <div
          className="notifications-page__filters"
          role="group"
          aria-label={t("site.notifications.inbox.filterLabel")}
        >
          <Button
            type="button"
            variant={filter === "all" ? "primary" : "tertiary"}
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            {t("site.notifications.inbox.all")}
          </Button>
          <Button
            type="button"
            variant={filter === "unread" ? "primary" : "tertiary"}
            aria-pressed={filter === "unread"}
            onClick={() => setFilter("unread")}
          >
            {t("site.notifications.inbox.unread")}
          </Button>
        </div>

        <Button
          type="button"
          variant="tertiary"
          disabled={!hasUnread}
          loading={markAllRead.isPending}
          onClick={() => markAllRead.mutate()}
        >
          {t("site.notifications.inbox.markAllRead")}
        </Button>
      </div>

      {error ? (
        <p className="notifications-page__notice" role="alert">
          {t("site.notifications.inbox.loadError")}
        </p>
      ) : null}

      {loading ? (
        <p role="status">{t("site.common.loading")}</p>
      ) : items.length === 0 ? (
        <p>
          {filter === "unread"
            ? t("site.notifications.inbox.emptyUnread")
            : t("site.notifications.inbox.empty")}
        </p>
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
                  {notificationTypeLabel(notification.notification_type, t)}
                </p>
                <p className="notifications-page__item-title">{notification.title}</p>
                <p className="notifications-page__item-text">{notification.body}</p>
                <p className="notifications-page__item-date">
                  {formatDate(new Date(notification.created_at), DATE_TIME_OPTIONS)}
                </p>
              </div>
              {notification.read_at === null ? (
                <Button
                  type="button"
                  variant="tertiary"
                  loading={markRead.isPending && markRead.variables === notification.id}
                  onClick={() => markRead.mutate(notification.id)}
                >
                  {t("site.notifications.inbox.markAsRead")}
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
          {t("site.common.previous")}
        </Button>
        <Button type="button" variant="secondary" disabled={!hasNextPage} onClick={goToNextPage}>
          {t("site.common.next")}
        </Button>
      </div>
    </>
  );
}
