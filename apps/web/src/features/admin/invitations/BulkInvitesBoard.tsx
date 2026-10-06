import { PAGINATION_MAX_LIMIT } from "@studafy/shared-schemas";
import { Button, DataGrid } from "@studafy/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { ExportCsvButton } from "../../../components/ExportCsvButton";
import { collectCursorPages } from "../../../lib/data-transfer";
import { useFormatters, useTranslation } from "../../../lib/i18n";

import { bulkInvitesListQueryKey, fetchBulkInvitesPage } from "./queries";
import { BULK_INVITE_STATUS_LABEL_KEYS, ROLE_LABEL_KEYS } from "./schema";

import type { BulkInvite } from "./queries";
import type { ExportColumn } from "../../../lib/data-transfer";
import type { Role } from "@studafy/constants";
import type { DataGridColumn } from "@studafy/ui";

/** Matches `Date#toLocaleString()`'s default fields, now formatted in the active locale. */
const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
};

export interface BulkInvitesBoardProps {
  onCreate: () => void;
  onViewProgress: (bulkInviteId: string) => void;
}

export function BulkInvitesBoard({ onCreate, onViewProgress }: BulkInvitesBoardProps) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);

  const { data, isPending, isError } = useQuery({
    queryKey: bulkInvitesListQueryKey(cursor),
    queryFn: () => fetchBulkInvitesPage(cursor),
    placeholderData: keepPreviousData,
  });

  const columns: DataGridColumn<BulkInvite>[] = [
    {
      id: "status",
      header: t("adminPeople.invitations.bulkBoard.columns.status"),
      renderCell: (batch) => (
        <span className="invitations-status-pill" data-status={batch.status}>
          {t(BULK_INVITE_STATUS_LABEL_KEYS[batch.status])}
        </span>
      ),
    },
    {
      id: "role",
      header: t("adminPeople.invitations.bulkBoard.columns.role"),
      renderCell: (batch) => {
        const key = ROLE_LABEL_KEYS[batch.role as Role];
        return key ? t(key) : batch.role;
      },
    },
    {
      id: "total",
      header: t("adminPeople.invitations.bulkBoard.columns.total"),
      renderCell: (batch) => batch.total_count,
      align: "end",
    },
    {
      id: "sent",
      header: t("adminPeople.invitations.bulkBoard.columns.sent"),
      renderCell: (batch) => batch.sent_count,
      align: "end",
    },
    {
      id: "failed",
      header: t("adminPeople.invitations.bulkBoard.columns.failed"),
      renderCell: (batch) => batch.failed_count,
      align: "end",
    },
    {
      id: "created_at",
      header: t("adminPeople.invitations.bulkBoard.columns.created"),
      renderCell: (batch) => formatDate(new Date(batch.created_at), DATE_TIME_OPTIONS),
    },
    {
      id: "actions",
      header: t("adminPeople.invitations.bulkBoard.columns.actions"),
      renderCell: (batch) => (
        <Button variant="tertiary" onClick={() => onViewProgress(batch.id)}>
          {t("adminPeople.invitations.bulkBoard.viewProgress")}
        </Button>
      ),
    },
  ];

  // Same headers as the grid; counts as numbers and the created time as an ISO timestamp.
  const exportColumns: ExportColumn<BulkInvite>[] = [
    {
      header: t("adminPeople.invitations.bulkBoard.columns.status"),
      value: (batch) => t(BULK_INVITE_STATUS_LABEL_KEYS[batch.status]),
    },
    { header: t("adminPeople.invitations.bulkBoard.columns.role"), value: (batch) => batch.role },
    {
      header: t("adminPeople.invitations.bulkBoard.columns.total"),
      value: (batch) => batch.total_count,
    },
    {
      header: t("adminPeople.invitations.bulkBoard.columns.sent"),
      value: (batch) => batch.sent_count,
    },
    {
      header: t("adminPeople.invitations.bulkBoard.columns.failed"),
      value: (batch) => batch.failed_count,
    },
    {
      header: t("adminPeople.invitations.bulkBoard.columns.created"),
      value: (batch) => batch.created_at,
    },
  ];

  return (
    <>
      <div className="invitations-board__header">
        <p>{t("adminPeople.invitations.bulkBoard.description")}</p>
        <div className="invitations-board__header-actions">
          <ExportCsvButton
            filename="bulk-invites"
            columns={exportColumns}
            getRows={() =>
              collectCursorPages(async (pageCursor) => {
                const page = await fetchBulkInvitesPage(pageCursor, PAGINATION_MAX_LIMIT);
                return { items: page.bulkInvites, nextCursor: page.next_cursor };
              })
            }
          />
          <Button onClick={onCreate}>{t("adminPeople.invitations.bulkBoard.newBulkInvite")}</Button>
        </div>
      </div>

      <DataGrid
        caption={t("adminPeople.invitations.bulkBoard.caption")}
        columns={columns}
        rows={data?.bulkInvites ?? []}
        getRowId={(batch) => batch.id}
        getRowLabel={(batch) => t("adminPeople.invitations.bulkBoard.rowLabel", { id: batch.id })}
        loading={isPending}
        empty={
          isError
            ? t("adminPeople.invitations.bulkBoard.loadError")
            : t("adminPeople.invitations.bulkBoard.empty")
        }
      />

      <div className="invitations-board__pagination">
        <Button
          variant="secondary"
          disabled={cursorHistory.length === 0}
          onClick={() => {
            const next = [...cursorHistory];
            const previous = next.pop();
            setCursorHistory(next);
            setCursor(previous);
          }}
        >
          {t("adminPeople.common.previous")}
        </Button>
        <Button
          variant="secondary"
          disabled={!data?.next_cursor}
          onClick={() => {
            const nextCursor = data?.next_cursor;
            if (!nextCursor) return;
            setCursorHistory([...cursorHistory, cursor]);
            setCursor(nextCursor);
          }}
        >
          {t("adminPeople.common.next")}
        </Button>
      </div>
    </>
  );
}
