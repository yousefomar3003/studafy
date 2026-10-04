import { Button, DataGrid } from "@studafy/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { bulkInvitesListQueryKey, fetchBulkInvitesPage } from "./queries";
import { BULK_INVITE_STATUS_LABEL_KEYS, ROLE_LABEL_KEYS } from "./schema";

import type { BulkInvite } from "./queries";
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

  return (
    <>
      <div className="invitations-board__header">
        <p>{t("adminPeople.invitations.bulkBoard.description")}</p>
        <Button onClick={onCreate}>{t("adminPeople.invitations.bulkBoard.newBulkInvite")}</Button>
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
