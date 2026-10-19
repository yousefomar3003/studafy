import { Button, Chip, DataGrid, Select, useCursorPagination } from "@studafy/ui";
import { useCallback, useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { fetchAnnouncementsPage } from "./queries";
import { AUDIENCE_TYPE_LABEL_KEYS, roleLabelKey } from "./schema";

import type { Announcement, AnnouncementStatus } from "./queries";
import type { DataGridColumn, SelectOption } from "@studafy/ui";
import type { TFunction } from "i18next";

/** Same fields `Date#toLocaleString()` shows, but in the active app locale rather than the browser's. */
const DATE_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
};

function audienceLabel(announcement: Announcement, t: TFunction): string {
  if (announcement.audience_type === "role" && announcement.audience_role) {
    return t("adminSchool.announcements.history.audienceRole", {
      role: t(roleLabelKey(announcement.audience_role)),
    });
  }
  if (announcement.audience_type === "class") {
    return t("adminSchool.announcements.history.audienceClass", {
      code: announcement.audience_class_code ?? "—",
    });
  }
  return t(AUDIENCE_TYPE_LABEL_KEYS.school);
}

export interface AnnouncementHistoryTableProps {
  /** Bump to force the list back to its first page and refetch — see `use-cursor-pagination.ts`'s
   * doc comment: changing `fetchPage`'s identity is what resets it. */
  refreshToken: number;
}

/**
 * History of composed announcements, newest first, with each row's reach
 * (`recipient_count` / `notified_count`) already joined in by the API. No client-side mutation here
 * needs an optimistic cache to patch — publishing happens on the Compose tab — so this uses the bare
 * `useCursorPagination` hook directly, the same reasoning `audit/AuditLogExplorerPage.tsx` documents
 * for its own list.
 */
export function AnnouncementHistoryTable({ refreshToken }: AnnouncementHistoryTableProps) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const [status, setStatus] = useState<AnnouncementStatus | "">("");

  const statusOptions: SelectOption<AnnouncementStatus | "">[] = [
    { value: "", label: t("adminSchool.announcements.history.allStatuses") },
    { value: "scheduled", label: t("adminSchool.announcements.history.status.scheduled") },
    { value: "published", label: t("adminSchool.announcements.history.status.published") },
  ];

  function formatDateTime(iso: string): string {
    return formatDate(new Date(iso), DATE_TIME_FORMAT);
  }

  const fetchPage = useCallback(
    (cursor: string | undefined) =>
      fetchAnnouncementsPage(cursor, status === "" ? undefined : status),
    [status, refreshToken],
  );
  const pagination = useCursorPagination(fetchPage);

  const columns: DataGridColumn<Announcement>[] = [
    {
      id: "title",
      header: t("adminSchool.announcements.history.columns.title"),
      renderCell: (a) => (
        <span>
          {a.title}
          {a.mandatory ? (
            <span className="announcements-history__mandatory-chip">
              <Chip variant="outlined">{t("adminSchool.announcements.history.mandatory")}</Chip>
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "audience",
      header: t("adminSchool.announcements.history.columns.audience"),
      renderCell: (a) => audienceLabel(a, t),
      width: 200,
    },
    {
      id: "status",
      header: t("adminSchool.announcements.history.columns.status"),
      renderCell: (a) =>
        a.status === "published"
          ? t("adminSchool.announcements.history.status.published")
          : t("adminSchool.announcements.history.status.scheduled"),
      width: 120,
    },
    {
      id: "when",
      header: t("adminSchool.announcements.history.columns.when"),
      renderCell: (a) =>
        a.status === "published" && a.published_at
          ? formatDateTime(a.published_at)
          : formatDateTime(a.scheduled_at),
      width: 190,
    },
    {
      id: "reach",
      header: t("adminSchool.announcements.history.columns.reach"),
      renderCell: (a) =>
        a.status === "published"
          ? t("adminSchool.announcements.history.reach", {
              notified: a.notified_count,
              recipients: a.recipient_count,
            })
          : "—",
      width: 120,
    },
    {
      id: "created_by",
      header: t("adminSchool.announcements.history.columns.sentBy"),
      renderCell: (a) => a.created_by_name ?? "—",
      width: 160,
    },
  ];

  return (
    <>
      <div className="announcements-history__toolbar">
        <Select
          label={t("adminSchool.announcements.history.statusLabel")}
          options={statusOptions}
          value={status}
          onChange={(value) => setStatus(value)}
        />
      </div>

      <DataGrid
        caption={t("adminSchool.announcements.history.caption")}
        columns={columns}
        rows={pagination.items}
        getRowId={(a) => a.id}
        getRowLabel={(a) => a.title}
        loading={pagination.loading}
        empty={
          pagination.error
            ? t("adminSchool.announcements.history.loadError")
            : t("adminSchool.announcements.history.empty")
        }
      />

      <div className="announcements-history__pagination">
        <Button
          type="button"
          variant="secondary"
          disabled={!pagination.hasPreviousPage}
          onClick={pagination.goToPreviousPage}
        >
          {t("adminSchool.announcements.history.previous")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!pagination.hasNextPage}
          onClick={pagination.goToNextPage}
        >
          {t("adminSchool.announcements.history.next")}
        </Button>
      </div>
    </>
  );
}
