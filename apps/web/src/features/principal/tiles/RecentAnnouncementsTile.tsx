import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { DashboardTile } from "../../../components/DashboardTile";
import { api } from "../../../lib/api";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { DATE_TIME_OPTIONS } from "../format";

import type { components } from "@studafy/api-client";

const RECENT_LIMIT = 5;

/** Most recently published announcements, newest first (`GET /api/announcements` already sorts
 * that way — see `apps/api/src/modules/announcements/routes.ts`). Scheduled-but-not-yet-published
 * announcements are excluded: a principal glancing at this tile cares what already went out, not
 * what's queued. */
export function RecentAnnouncementsTile() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { data, isPending, isError } = useQuery({
    queryKey: ["announcements", "recent"],
    queryFn: async () => {
      const { data } = await api.GET("/api/announcements", {
        params: { query: { limit: RECENT_LIMIT, status: "published" } },
      });
      return data;
    },
  });

  // `readonly Announcement[]` loses its array prototype through the generated response type here —
  // the same pre-existing `@studafy/api-client` typing gap `NotificationBell.tsx` documents for
  // `notifications`. The annotation restores it without widening to `any`.
  const announcements = (data?.items ?? []) as readonly components["schemas"]["Announcement"][];

  return (
    <DashboardTile
      title={t("principal.tiles.recentAnnouncements.title")}
      status={isPending ? "pending" : isError ? "error" : "ready"}
      errorMessage={t("principal.tiles.recentAnnouncements.error")}
    >
      {announcements.length === 0 ? (
        <p className="dashboard-tile__caption">{t("principal.tiles.recentAnnouncements.empty")}</p>
      ) : (
        <ul className="principal-announcements-list">
          {announcements.map((announcement) => (
            <li key={announcement.id} className="principal-announcements-list__item">
              <p className="principal-announcements-list__title">{announcement.title}</p>
              <p className="dashboard-tile__caption">
                {announcement.published_at
                  ? formatDate(new Date(announcement.published_at), DATE_TIME_OPTIONS)
                  : "—"}
              </p>
            </li>
          ))}
        </ul>
      )}
      <Link className="dashboard-tile__link" to="/portal/admin/announcements">
        {t("principal.tiles.recentAnnouncements.link")}
      </Link>
    </DashboardTile>
  );
}
