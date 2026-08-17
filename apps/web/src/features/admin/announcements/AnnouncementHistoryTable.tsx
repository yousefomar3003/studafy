import { Button, Chip, DataGrid, Select, useCursorPagination } from "@studafy/ui";
import { useCallback, useState } from "react";

import { fetchAnnouncementsPage } from "./queries";
import { AUDIENCE_TYPE_LABELS, ROLE_LABELS } from "./schema";

import type { Announcement, AnnouncementStatus } from "./queries";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

const STATUS_OPTIONS: SelectOption<AnnouncementStatus | "">[] = [
  { value: "", label: "All statuses" },
  { value: "scheduled", label: "Scheduled" },
  { value: "published", label: "Published" },
];

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function audienceLabel(announcement: Announcement): string {
  if (announcement.audience_type === "role" && announcement.audience_role) {
    return `Role: ${ROLE_LABELS[announcement.audience_role]}`;
  }
  if (announcement.audience_type === "class") {
    return `Class: ${announcement.audience_class_code ?? "—"}`;
  }
  return AUDIENCE_TYPE_LABELS.school;
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
  const [status, setStatus] = useState<AnnouncementStatus | "">("");

  const fetchPage = useCallback(
    (cursor: string | undefined) =>
      fetchAnnouncementsPage(cursor, status === "" ? undefined : status),
    [status, refreshToken],
  );
  const pagination = useCursorPagination(fetchPage);

  const columns: DataGridColumn<Announcement>[] = [
    {
      id: "title",
      header: "Title",
      renderCell: (a) => (
        <span>
          {a.title}
          {a.mandatory ? (
            <span className="announcements-history__mandatory-chip">
              <Chip variant="outlined">Mandatory</Chip>
            </span>
          ) : null}
        </span>
      ),
    },
    { id: "audience", header: "Audience", renderCell: audienceLabel, width: 200 },
    {
      id: "status",
      header: "Status",
      renderCell: (a) => (a.status === "published" ? "Published" : "Scheduled"),
      width: 120,
    },
    {
      id: "when",
      header: "When",
      renderCell: (a) =>
        a.status === "published" && a.published_at
          ? formatDateTime(a.published_at)
          : formatDateTime(a.scheduled_at),
      width: 190,
    },
    {
      id: "reach",
      header: "Reach",
      renderCell: (a) =>
        a.status === "published" ? `${a.notified_count} / ${a.recipient_count}` : "—",
      width: 120,
    },
    {
      id: "created_by",
      header: "Sent by",
      renderCell: (a) => a.created_by_name ?? "—",
      width: 160,
    },
  ];

  return (
    <>
      <div className="announcements-history__toolbar">
        <Select
          label="Status"
          options={STATUS_OPTIONS}
          value={status}
          onChange={(value) => setStatus(value)}
        />
      </div>

      <DataGrid
        caption="Announcement history"
        columns={columns}
        rows={pagination.items}
        getRowId={(a) => a.id}
        getRowLabel={(a) => a.title}
        loading={pagination.loading}
        empty={pagination.error ? "Unable to load announcements." : "No announcements yet."}
      />

      <div className="announcements-history__pagination">
        <Button
          type="button"
          variant="secondary"
          disabled={!pagination.hasPreviousPage}
          onClick={pagination.goToPreviousPage}
        >
          Previous
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!pagination.hasNextPage}
          onClick={pagination.goToNextPage}
        >
          Next
        </Button>
      </div>
    </>
  );
}
